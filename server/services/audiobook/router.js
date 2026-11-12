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
  checkFfmpeg, BITRATE_PRESETS, remuxToM4a,
} from './ffmpeg.js';
import { PRESET_VOICES, verifyKey } from './mimo.js';
import { readMimoConfig, saveMimoConfig, maskKey } from './key-store.js';
import {
  audiobookPaths, ensureAudiobookDirs, readState, writeState,
  normalizeSettings, settingsSignature, partPathFor, partMetaPathFor,
  previewPathFor, readPartMetaFile,
} from './state.js';
import { runAudiobookPipeline, summarize, AudiobookError } from './pipeline.js';
import { removeTree } from './wav.js';
import { estimateDurationSec, formatBytes, formatDuration } from './text.js';

/**
 * 任务表 + 全局队列。
 *
 * 全局串行：同一时刻只跑一本书。TTS 是限流敏感的网络 IO，多书并行会让 429 互相
 * 放大、ETA 一起失真；NAS 上还会几个 ffmpeg 同时收尾抢 CPU。所以后来者排队，
 * 拿到「前面还有 N 本」的位置，真正轮到了才读盘、跑管线。
 */
const tasks = new Map();      // projectName -> { id, controller, snapshot, chapters, ... }
const listeners = new Map();  // projectName -> Set<res>
const queue = [];             // 排队中的任务（FIFO），元素就是上面的 task 对象
let activeTask = null;        // 正在运行的那一个
let slotReserved = false;     // 全局槽位已被某个 /start 同步占住（它在 await 中还没进 startTask）

/** 占着队列位置的状态；done/error/stopped 的旧任务可以直接被新任务顶掉 */
const BUSY_STATUS = new Set(['running', 'queued', 'stopping']);

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

function pushTaskLog(task, message, level = 'info') {
  const logs = task.snapshot.logs;
  logs.push({ at: new Date().toISOString(), level, message });
  if (logs.length > 300) logs.splice(0, logs.length - 300);
}

/** 队列全貌：哪本在跑、谁在第几位 */
function queueInfo() {
  return {
    active: activeTask ? { projectName: activeTask.snapshot.projectName, taskId: activeTask.id } : null,
    pending: queue.map((t, i) => ({
      projectName: t.snapshot.projectName,
      taskId: t.id,
      position: i + 1,
    })),
  };
}

/** 重排排队位置，并把新位置推给每一本排队中的书 */
function refreshQueuePositions() {
  const blocking = activeTask ? activeTask.snapshot.projectName : '';
  queue.forEach((t, i) => {
    t.snapshot.queuePosition = i + 1;
    t.snapshot.queueAhead = i;
    t.snapshot.queueTotal = queue.length;
    t.snapshot.blockingProject = blocking;
  });
  for (const t of queue) {
    broadcast(t.snapshot.projectName, { type: 'task', data: publicTask(t) });
  }
}

/** 进程重启后，磁盘上残留的 running/queued 是死状态，纠正成 stopped */
async function reconcileState(projectPath, projectName, state) {
  if (!state || !BUSY_STATUS.has(state.status) || tasks.has(projectName)) return state;
  state.status = 'stopped';
  await writeState(projectPath, state).catch(() => {});
  return state;
}

/**
 * 真正开始跑一个任务：置 running → 跑管线 → 收尾后交给队列里的下一本。
 * 调用前任务必须已在 tasks 里，且没有别的任务在跑。
 */
async function startTask(task) {
  const {
    projectPath, chapters, settings, apiKey, baseUrl, force,
  } = task;
  // 书名只在 snapshot 里，任务对象本身不存一份，避免两处不一致
  const projectName = task.snapshot.projectName;

  activeTask = task;
  slotReserved = false;
  task.snapshot = {
    ...task.snapshot,
    status: 'running',
    queuePosition: 0,
    queueAhead: 0,
    startedAt: new Date().toISOString(),
  };
  pushTaskLog(task, `轮到本书：${chapters.length} 章 · 并发 ${settings.concurrency} · ${settings.bitrateKbps}kbps AAC`);
  broadcast(projectName, { type: 'task', data: publicTask(task) });
  refreshQueuePositions(); // 后面的书前进一位

  const state = await readState(projectPath, projectName).catch(() => task.sourceState);
  state.status = 'running';
  state.settings = settings;
  await writeState(projectPath, state).catch(() => {});

  try {
    const output = await runAudiobookPipeline({
      projectPath,
      projectName,
      chapters,
      state,
      settings,
      apiKey,
      baseUrl,
      signal: task.controller.signal,
      force,
      meta: { title: projectName, author: '' },
      emit: (evt) => {
        if (evt.type === 'progress') {
          task.snapshot = { ...task.snapshot, ...evt.data, status: 'running' };
        } else if (evt.type === 'log') {
          pushTaskLog(task, evt.message, evt.level);
        } else if (evt.type === 'chapter') {
          pushTaskLog(task, `${evt.data.title} · ${evt.data.status === 'done' ? '完成' : evt.data.status === 'error' ? `失败：${evt.data.error || ''}` : '编码中'}`,
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
    pushTaskLog(task, message, 'error');
    task.snapshot = { ...task.snapshot, status: 'error', error: message, details: err?.details || null };
    broadcast(projectName, { type: 'error', message, details: err?.details || null });
    const state2 = await readState(projectPath, projectName).catch(() => null);
    if (state2) {
      state2.status = 'error';
      await writeState(projectPath, state2).catch(() => {});
    }
  } finally {
    activeTask = null;
    broadcast(projectName, { type: 'task', data: publicTask(task) });
    // 保留 5 秒快照，方便前端把「完成/中断」的收尾日志显示完
    setTimeout(() => {
      if (tasks.get(projectName) === task) tasks.delete(projectName);
    }, 5000);
    drainQueue();
  }
}

/** 空出全局槽位后，拉起队首的书 */
function drainQueue() {
  if (activeTask) return;
  const next = queue.shift();
  if (!next) return;
  refreshQueuePositions();
  void startTask(next).catch((err) => recoverStartFailure(next, err));
}

/** startTask 在进入自己的 try 之前就挂了（读盘/写状态失败）时的兜底，别把全局槽位占死 */
function recoverStartFailure(task, err) {
  if (activeTask === task) activeTask = null;
  slotReserved = false;
  task.snapshot = { ...task.snapshot, status: 'error', error: err?.message || String(err) };
  const { projectName } = task.snapshot;
  if (tasks.get(projectName) === task) tasks.delete(projectName);
  broadcast(projectName, { type: 'task', data: publicTask(task) });
  drainQueue();
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * 试听副本（parts/<hash>.aac → preview/<hash>.m4a）。
 * 播放器发起的是 Range 请求，常常几个请求并发打进来，所以同一文件只转封装一次；
 * 章节重新生成后 AAC 的 mtime 变新，副本自动失效重建。
 */
const previewJobs = new Map();

async function ensurePreviewFile(projectPath, chapterKey) {
  const partFile = partPathFor(projectPath, chapterKey);
  const m4aFile = previewPathFor(projectPath, chapterKey);
  const [partStat, m4aStat] = await Promise.all([
    fs.stat(partFile).catch(() => null),
    fs.stat(m4aFile).catch(() => null),
  ]);
  if (!partStat || partStat.size < 1024) return null;
  if (m4aStat && m4aStat.size > 1024 && m4aStat.mtimeMs >= partStat.mtimeMs) return m4aFile;

  const running = previewJobs.get(m4aFile);
  if (running) return running;

  const job = (async () => {
    await fs.mkdir(path.dirname(m4aFile), { recursive: true });
    const tmp = `${m4aFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      await remuxToM4a(partFile, tmp);
      await fs.rename(tmp, m4aFile);
      return m4aFile;
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  })().finally(() => previewJobs.delete(m4aFile));

  previewJobs.set(m4aFile, job);
  return job;
}

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
        state = await reconcileState(projectPath, projectName, await readState(projectPath, projectName));
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
      queue: queueInfo(),
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

    const [{ pipeline, chapters }, rawState] = await Promise.all([
      loadChapters(getPipeline, projectName),
      readState(projectPath, projectName),
    ]);
    const state = await reconcileState(projectPath, projectName, rawState);

    // 页面上的音色/码率可能还没保存到 state，用查询参数覆盖，才能算出「这章是不是要重生成」
    const settings = normalizeSettings({
      ...state.settings,
      voice: req.query.voice || state.settings.voice,
      bitrateKbps: req.query.bitrateKbps || state.settings.bitrateKbps,
      chunkChars: req.query.chunkChars || state.settings.chunkChars,
    });
    const expectedSignature = settingsSignature(settings);

    const items = await Promise.all(chapters.map(async (c) => {
      const record = state.chapters[c.key] || {};
      // 片段是用什么参数合成的（老数据可能只有文件里的 meta 才有签名）
      const signature = record.signature
        || (record.status === 'done' ? (await readPartMetaFile(projectPath, c.key))?.signature : '')
        || '';
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
        skippedChars: record.skippedChars || 0,
        error: record.error || '',
        signature,
        voice: signature ? signature.split('|')[0] : '',
        // 已完成、但音频是别的音色/码率合成的 → 需要重新生成
        stale: record.status === 'done' && Boolean(signature) && signature !== expectedSignature,
      };
    }));

    const totals = {
      chapters: items.length,
      chars: items.reduce((s, c) => s + c.charCount, 0),
      doneChapters: items.filter((c) => c.status === 'done').length,
      staleChapters: items.filter((c) => c.stale).length,
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
      expectedSignature,
      output: state.output,
      status: state.status,
      queue: queueInfo(),
      task: taskSnapshot(projectName),
    });
  }));

  /* ── 启动 / 停止 ── */
  router.post('/start', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const projectName = String(body.projectName || '');
    if (!projectName) return res.status(400).json({ error: '缺少 projectName' });

    const existing = tasks.get(projectName);
    if (existing && BUSY_STATUS.has(existing.snapshot.status)) {
      const ahead = Math.max(0, existing.snapshot.queueAhead || 0);
      return res.status(409).json({
        error: existing.snapshot.status === 'queued'
          ? `该书已在队列中，前面还有 ${ahead} 本`
          : '该书的有声书任务正在运行',
      });
    }

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

    // 全局串行：已经有书在跑就排队，先落一个 queued 状态，刷新页面也能看到。
    // 从这里到 tasks.set 之间不能再有 await，否则两个 /start 会互相看不见对方、双双开跑。
    await ensureAudiobookDirs(projectPath);
    const state = await readState(projectPath, projectName);
    state.settings = settings;

    const willQueue = Boolean(activeTask) || slotReserved;
    if (!willQueue) slotReserved = true;
    state.status = willQueue ? 'queued' : 'running';
    try {
      await writeState(projectPath, state);
    } catch (err) {
      if (!willQueue) slotReserved = false;
      throw err;
    }

    const taskId = `ab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      id: taskId,
      controller: new AbortController(),
      projectPath,
      chapters: selected,
      settings,
      apiKey: mimo.apiKey,
      baseUrl: mimo.baseUrl,
      force: Boolean(body.force),
      sourceState: state,
      snapshot: {
        taskId,
        projectName,
        status: willQueue ? 'queued' : 'running',
        stage: 'tts',
        percent: 0,
        doneChunks: 0,
        totalChunks: 0,
        doneChapters: 0,
        totalChapters: selected.length,
        aacBytes: 0,
        elapsedSec: 0,
        etaSec: 0,
        queuePosition: willQueue ? queue.length + 1 : 0,
        queueAhead: willQueue ? queue.length : 0,
        queueTotal: willQueue ? queue.length + 1 : 0,
        blockingProject: willQueue ? (activeTask?.snapshot.projectName || '') : '',
        startedAt: new Date().toISOString(),
        logs: [],
      },
    };
    tasks.set(projectName, task);

    if (willQueue) {
      queue.push(task);
      pushTaskLog(task, `已加入队列：前面还有 ${queue.length - 1} 本`);
      refreshQueuePositions();
      return res.json({ ok: true, taskId, queued: true, ahead: queue.length - 1, position: queue.length });
    }

    res.json({ ok: true, taskId, queued: false });
    void startTask(task).catch((err) => recoverStartFailure(task, err));
  }));

  router.post('/stop', asyncHandler(async (req, res) => {
    const projectName = String(req.body?.projectName || '');
    const task = tasks.get(projectName);
    if (!task) return res.json({ ok: true, message: '当前没有运行中的任务' });

    // 排队中的任务：直接摘出队列，后面几本一起往前挪，不需要中断任何东西
    if (task.snapshot.status === 'queued') {
      const idx = queue.indexOf(task);
      if (idx >= 0) queue.splice(idx, 1);
      task.snapshot = { ...task.snapshot, status: 'stopped', queuePosition: 0, queueAhead: 0 };
      pushTaskLog(task, '已取消排队', 'warn');
      broadcast(projectName, { type: 'task', data: publicTask(task) });
      broadcast(projectName, { type: 'stopped', message: '已取消排队' });
      const state = await readState(task.projectPath, projectName).catch(() => null);
      if (state) {
        state.status = 'stopped';
        await writeState(task.projectPath, state).catch(() => {});
      }
      setTimeout(() => {
        if (tasks.get(projectName) === task) tasks.delete(projectName);
      }, 5000);
      refreshQueuePositions();
      return res.json({ ok: true, cancelled: true });
    }

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

  /* ── 单章在线试听（返回支持 Range 的 m4a，可拖动进度条） ── */
  router.get('/preview', asyncHandler(async (req, res) => {
    const projectName = String(req.query.projectName || '');
    const chapterKey = String(req.query.chapterKey || '');
    if (!projectName) return res.status(400).json({ error: '缺少 projectName' });
    if (!chapterKey) return res.status(400).json({ error: '缺少 chapterKey' });

    const { projectPath } = await safeProjectPath(projectName);
    const state = await readState(projectPath, projectName);
    const record = state.chapters[chapterKey];
    if (!record || record.status !== 'done') {
      return res.status(404).json({ error: '该章还没有可试听的音频' });
    }

    let file;
    try {
      file = await ensurePreviewFile(projectPath, chapterKey);
    } catch (err) {
      return res.status(500).json({ error: `试听音频准备失败：${err.message}` });
    }
    if (!file) return res.status(404).json({ error: '该章的音频片段不存在，请重新生成' });

    res.sendFile(file, {
      headers: {
        'Content-Type': 'audio/mp4',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline',
      },
    }, (err) => {
      if (!err) return;
      if (!res.headersSent) res.status(500).json({ error: err.message });
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
    const busy = tasks.get(projectName);
    if (busy && BUSY_STATUS.has(busy.snapshot.status)) {
      return res.status(409).json({
        error: busy.snapshot.status === 'queued' ? '该书正在排队，请先取消排队' : '任务运行中，请先停止',
      });
    }

    const { projectPath } = await safeProjectPath(projectName);
    const paths = audiobookPaths(projectPath);
    const state = await readState(projectPath, projectName);

    if (req.body?.chapterKeys?.length) {
      const keys = new Set(req.body.chapterKeys.map(String));
      for (const key of keys) {
        removeTree(partPathFor(projectPath, key), { recursive: false });
        removeTree(partMetaPathFor(projectPath, key), { recursive: false });
        removeTree(previewPathFor(projectPath, key), { recursive: false });
        delete state.chapters[key];
      }
      state.output = null;
    } else {
      removeTree(paths.partsDir);
      removeTree(paths.previewDir);
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
