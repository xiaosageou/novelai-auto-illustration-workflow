/**
 * 有声书 API 路由（挂载在 /api/audiobook）。
 *
 * 与生图管线完全隔离：只读书籍/章节，独立任务表、独立 SSE 通道、独立产物目录。
 * 所有写操作都限定在 projects/<书名>/audiobook/ 之内。
 */

import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  checkFfmpeg, BITRATE_PRESETS,
} from './ffmpeg.js';
import { PRESET_VOICES, verifyKey } from './mimo.js';
import { readMimoConfig, saveMimoConfig, maskKey } from './key-store.js';
import {
  audiobookPaths, ensureAudiobookDirs, readState, writeState,
  normalizeSettings, partPathFor, partMetaPathFor,
} from './state.js';
import { runAudiobookPipeline, summarize, AudiobookError } from './pipeline.js';
import { removeTree } from './wav.js';
import { estimateDurationSec, formatBytes, formatDuration } from './text.js';

/** 每个项目最多一个运行中的任务 */
const tasks = new Map();      // projectName -> { id, controller, snapshot }
const listeners = new Map();  // projectName -> Set<res>

function broadcast(projectName, evt) {
  const set = listeners.get(projectName);
  if (!set || !set.size) return;
  const payload = `event: audiobook\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { /* 客户端已断开 */ }
  }
}

function publicTask(task) {
  if (!task) return null;
  return { ...task.snapshot, id: task.id };
}

function taskSnapshot(projectName) {
  const task = tasks.get(projectName);
  return task ? publicTask(task) : null;
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 取项目章节（复用已有的 PipelineManager 解析结果） */
async function loadChapters(getPipeline, projectName) {
  const pipeline = await getPipeline(projectName);
  return {
    pipeline,
    chapters: (pipeline.chapters || []).map((c, i) => ({
      key: c.chapterKey,
      title: String(c.chapter || '').trim() || `${c.volume || ''} 第${i + 1}章`.trim(),
      volume: c.volume || '',
      ordinal: c.ordinal ?? i,
      index: i,
      content: String(c.content || ''),
      charCount: String(c.content || '').replace(/\s/g, '').length,
    })),
  };
}

/**
 * @param {{ baseDir:string, getPipeline:Function, safeProjectPath:Function }} deps
 */
export function createAudiobookRouter({ baseDir, getPipeline, safeProjectPath }) {
  const router = express.Router();

  /* ── 状态 ── */
  router.get('/status', asyncHandler(async (req, res) => {
    const [ffmpeg, mimo] = await Promise.all([checkFfmpeg(), readMimoConfig(baseDir)]);
    const projectName = String(req.query.projectName || '');
    let state = null;
    if (projectName) {
      try {
        const { projectPath } = await safeProjectPath(projectName);
        state = await readState(projectPath, projectName);
      } catch {
        state = null;
      }
    }
    res.json({
      ok: true,
      ffmpeg,
      key: { hasKey: mimo.hasKey, masked: mimo.maskedKey, baseUrl: mimo.baseUrl },
      voices: PRESET_VOICES,
      bitrates: BITRATE_PRESETS,
      state,
      task: taskSnapshot(projectName),
    });
  }));

  /* ── 保存 / 测试 Key ── */
  router.post('/config', asyncHandler(async (req, res) => {
    const { apiKey, baseUrl } = req.body || {};
    const saved = await saveMimoConfig(baseDir, { apiKey, baseUrl });
    res.json({ ok: true, key: { hasKey: saved.hasKey, masked: saved.maskedKey, baseUrl: saved.baseUrl } });
  }));

  router.post('/test', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const current = await readMimoConfig(baseDir);
    const apiKey = String(body.apiKey || current.apiKey || '').trim();
    if (!apiKey) return res.status(400).json({ ok: false, error: '请先填写 MiMo API Key' });
    try {
      const started = Date.now();
      const r = await verifyKey({ apiKey, baseUrl: body.baseUrl || current.baseUrl, voice: body.voice || '白桦' });
      res.json({ ok: true, latencyMs: Date.now() - started, bytes: r.bytes, masked: maskKey(apiKey) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  }));

  /* ── 章节清单 + 估算 ── */
  router.get('/chapters', asyncHandler(async (req, res) => {
    const projectName = String(req.query.projectName || '');
    if (!projectName) return res.status(400).json({ error: '缺少 projectName' });
    const { projectPath } = await safeProjectPath(projectName);

    const [{ pipeline, chapters }, state] = await Promise.all([
      loadChapters(getPipeline, projectName),
      readState(projectPath, projectName),
    ]);

    const settings = normalizeSettings({
      ...state.settings,
      bitrateKbps: req.query.bitrateKbps || state.settings.bitrateKbps,
    });

    const items = chapters.map((c) => {
      const record = state.chapters[c.key] || {};
      return {
        key: c.key,
        title: c.title,
        volume: c.volume,
        index: c.index,
        charCount: c.charCount,
        estDurationSec: Math.round(estimateDurationSec(c.content)),
        status: record.status || 'pending',
        durationSec: record.durationSec || 0,
        bytes: record.bytes || 0,
        error: record.error || '',
      };
    });

    const totals = {
      chapters: items.length,
      chars: items.reduce((s, c) => s + c.charCount, 0),
      doneChapters: items.filter((c) => c.status === 'done').length,
      estDurationSec: Math.round(items.reduce((s, c) => s + c.estDurationSec, 0)),
      estBytes: Math.round((items.reduce((s, c) => s + c.estDurationSec, 0) * settings.bitrateKbps * 1000) / 8),
      doneBytes: items.reduce((s, c) => s + (c.status === 'done' ? c.bytes : 0), 0),
    };

    res.json({
      ok: true,
      projectName,
      bookTitle: pipeline.projectName || projectName,
      chapters: items,
      totals,
      settings,
      output: state.output,
      status: state.status,
      task: taskSnapshot(projectName),
    });
  }));

  /* ── 启动 / 停止 ── */
  router.post('/start', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const projectName = String(body.projectName || '');
    if (!projectName) return res.status(400).json({ error: '缺少 projectName' });
    if (tasks.has(projectName)) return res.status(409).json({ error: '该书的有声书任务正在运行' });

    const { projectPath } = await safeProjectPath(projectName);
    const mimo = await readMimoConfig(baseDir);
    if (!mimo.hasKey) return res.status(400).json({ error: '请先填写并保存 MiMo API Key' });

    const { chapters } = await loadChapters(getPipeline, projectName);
    if (!chapters.length) return res.status(400).json({ error: '该书没有可用章节' });

    const settings = normalizeSettings(body.settings || {});
    const wanted = Array.isArray(body.chapterKeys) && body.chapterKeys.length
      ? new Set(body.chapterKeys.map(String))
      : null;
    const selected = wanted ? chapters.filter((c) => wanted.has(c.key)) : chapters;
    if (!selected.length) return res.status(400).json({ error: '没有勾选任何章节' });

    await ensureAudiobookDirs(projectPath);
    const state = await readState(projectPath, projectName);
    state.settings = settings;
    state.status = 'running';
    await writeState(projectPath, state);

    const controller = new AbortController();
    const taskId = `ab-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      controller,
      snapshot: {
        taskId,
        projectName,
        status: 'running',
        stage: 'tts',
        percent: 0,
        doneChunks: 0,
        totalChunks: 0,
        doneChapters: 0,
        totalChapters: selected.length,
        aacBytes: 0,
        elapsedSec: 0,
        etaSec: 0,
        startedAt: new Date().toISOString(),
        logs: [],
      },
    };
    tasks.set(projectName, task);

    const pushLog = (message, level = 'info') => {
      const logs = task.snapshot.logs;
      logs.push({ at: new Date().toISOString(), level, message });
      if (logs.length > 300) logs.splice(0, logs.length - 300);
    };

    res.json({ ok: true, taskId });

    // 后台执行，不阻塞 HTTP
    (async () => {
      try {
        const output = await runAudiobookPipeline({
          projectPath,
          projectName,
          chapters: selected,
          state,
          settings,
          apiKey: mimo.apiKey,
          baseUrl: mimo.baseUrl,
          signal: controller.signal,
          force: Boolean(body.force),
          meta: { title: projectName, author: '' },
          emit: (evt) => {
            if (evt.type === 'progress') {
              task.snapshot = { ...task.snapshot, ...evt.data, status: 'running' };
            } else if (evt.type === 'log') {
              pushLog(evt.message, evt.level);
            } else if (evt.type === 'chapter') {
              pushLog(`${evt.data.title} · ${evt.data.status === 'done' ? '完成' : evt.data.status === 'error' ? `失败：${evt.data.error || ''}` : '编码中'}`,
                evt.data.status === 'error' ? 'error' : evt.data.status === 'done' ? 'success' : 'info');
            } else if (evt.type === 'done') {
              task.snapshot = { ...task.snapshot, status: 'done', percent: 100, output: evt.data };
            } else if (evt.type === 'stopped') {
              task.snapshot = { ...task.snapshot, status: 'stopped' };
            }
            broadcast(projectName, evt);
          },
        });
        if (output?.stopped) {
          task.snapshot.status = 'stopped';
        } else {
          task.snapshot = { ...task.snapshot, status: 'done', percent: 100, output };
        }
      } catch (err) {
        const message = err?.message || String(err);
        pushLog(message, 'error');
        task.snapshot = { ...task.snapshot, status: 'error', error: message, details: err?.details || null };
        broadcast(projectName, { type: 'error', message, details: err?.details || null });
        const state2 = await readState(projectPath, projectName).catch(() => null);
        if (state2) {
          state2.status = 'error';
          await writeState(projectPath, state2).catch(() => {});
        }
      } finally {
        broadcast(projectName, { type: 'task', data: publicTask(task) });
        setTimeout(() => { tasks.delete(projectName); }, 5000);
      }
    })();
  }));

  router.post('/stop', asyncHandler(async (req, res) => {
    const projectName = String(req.body?.projectName || '');
    const task = tasks.get(projectName);
    if (!task) return res.json({ ok: true, message: '当前没有运行中的任务' });
    task.snapshot.status = 'stopping';
    task.controller.abort();
    broadcast(projectName, { type: 'stopping', message: '正在停止…已完成的章节会保留' });
    res.json({ ok: true });
  }));

  router.get('/task', asyncHandler(async (req, res) => {
    const projectName = String(req.query.projectName || '');
    res.json({ ok: true, task: taskSnapshot(projectName) });
  }));

  /* ── SSE ── */
  router.get('/events', asyncHandler(async (req, res) => {
    const projectName = String(req.query.projectName || '');
    if (!projectName) return res.status(400).end();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify({ task: taskSnapshot(projectName) })}\n\n`);

    if (!listeners.has(projectName)) listeners.set(projectName, new Set());
    listeners.get(projectName).add(res);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const set = listeners.get(projectName);
      if (set) {
        set.delete(res);
        if (!set.size) listeners.delete(projectName);
      }
    });
  }));

  /* ── 产物下载 / 清理 ── */
  router.get('/download', asyncHandler(async (req, res) => {
    const projectName = String(req.query.projectName || '');
    if (!projectName) return res.status(400).json({ error: '缺少 projectName' });
    const { projectPath } = await safeProjectPath(projectName);
    const state = await readState(projectPath, projectName);
    if (!state.output?.file) return res.status(404).json({ error: '尚未生成 m4b' });

    const file = path.join(audiobookPaths(projectPath).outDir, state.output.file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return res.status(404).json({ error: 'm4b 文件不存在，请重新生成' });

    res.download(file, `${projectName}.m4b`);
  }));

  router.post('/reset', asyncHandler(async (req, res) => {
    const projectName = String(req.body?.projectName || '');
    if (!projectName) return res.status(400).json({ error: '缺少 projectName' });
    if (tasks.has(projectName)) return res.status(409).json({ error: '任务运行中，请先停止' });

    const { projectPath } = await safeProjectPath(projectName);
    const paths = audiobookPaths(projectPath);
    const state = await readState(projectPath, projectName);

    if (req.body?.chapterKeys?.length) {
      const keys = new Set(req.body.chapterKeys.map(String));
      for (const key of keys) {
        removeTree(partPathFor(projectPath, key), { recursive: false });
        removeTree(partMetaPathFor(projectPath, key), { recursive: false });
        delete state.chapters[key];
      }
      state.output = null;
    } else {
      removeTree(paths.partsDir);
      removeTree(paths.workDir);
      removeTree(paths.outDir);
      state.chapters = {};
      state.output = null;
    }
    state.status = 'idle';
    await ensureAudiobookDirs(projectPath);
    await writeState(projectPath, state);
    res.json({ ok: true, state });
  }));

  // 统一错误出口
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof AudiobookError ? 400 : 500;
    res.status(status).json({ error: err?.message || '有声书服务异常', details: err?.details || null });
  });

  return router;
}

export { formatBytes, formatDuration, summarize };
