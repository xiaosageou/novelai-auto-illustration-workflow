/**
 * 有声书生产管线：项目章节 →（并发）MiMo TTS → 逐章 AAC 压缩 → 单个 m4b。
 *
 * 和生图管线完全独立，只共用「书籍/章节」这一层数据：
 *  1. 全局块级任务池：所有章节的所有文本块拉平成一个队列，并发数由前端配置，
 *     短章多的时候也能吃满并发。
 *  2. 磁盘友好：TTS 返回的 WAV 只作块级临时文件；一章的块到齐后
 *     立刻流式拼接 → AAC → 删除 WAV，中间体积约为 WAV 的 1/8。
 *  3. 断点续跑：章片段（parts/<hash>.aac）落地后即视为完成；中断在半章时，
 *     已合成的块文件也能复用。
 *  4. 只产出 m4b：不保留整书 WAV，最终由分章 AAC 直接封装。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { chunkText, estimateDurationSec } from './text.js';
import {
  parseWav, extractPcm, WavStreamWriter, removeTree,
} from './wav.js';
import { MiMoClient } from './mimo.js';
import {
  checkFfmpeg, encodeAac, probeDuration, adtsDurationSec, packM4b,
} from './ffmpeg.js';
import {
  audiobookPaths, partIdFor, partPathFor, partMetaPathFor,
  readPartMeta, writePartMeta, settingsSignature, normalizeSettings, writeState,
} from './state.js';

const TARGET_SAMPLE_RATE = 24000;
const TARGET_CHANNELS = 1;
const TARGET_BITS = 16;

export class AudiobookError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AudiobookError';
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把非目标格式的块转成 24k/16bit/单声道 PCM（极少发生，仅作兜底） */
async function convertChunkToPcm(srcPath, dstPath) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.AUDIOBOOK_FFMPEG || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', srcPath,
      '-ac', String(TARGET_CHANNELS), '-ar', String(TARGET_SAMPLE_RATE),
      '-c:a', 'pcm_s16le', dstPath,
    ], { windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`块转码失败：${code}`))));
  });
}

/**
 * 执行一次有声书生产。
 *
 * @param {object} opts
 * @param {string} opts.projectPath 项目根目录（projects/<书名>）
 * @param {string} opts.projectName
 * @param {Array<{key:string,title:string,index:number,content:string}>} opts.chapters 参与合成的章节
 * @param {object} opts.state 已加载的状态对象（会被就地更新并落盘）
 * @param {object} opts.settings
 * @param {string} opts.apiKey
 * @param {string} [opts.baseUrl]
 * @param {AbortSignal} [opts.signal]
 * @param {(evt:object)=>void} [opts.emit]
 * @param {boolean} [opts.force] 强制重跑
 * @param {{title?:string, author?:string}} [opts.meta]
 */
export async function runAudiobookPipeline(opts) {
  const {
    projectPath, projectName, chapters, state, apiKey, baseUrl, signal, emit = () => {}, force = false, meta = {},
  } = opts;

  const settings = normalizeSettings(opts.settings);
  const paths = audiobookPaths(projectPath);
  await fs.mkdir(paths.partsDir, { recursive: true });
  await fs.mkdir(paths.workDir, { recursive: true });

  const log = (message, level = 'info') => emit({ type: 'log', level, message });
  const patch = (payload) => emit({ type: 'progress', data: payload });

  const ff = await checkFfmpeg();
  if (!ff.ok) {
    throw new AudiobookError('未找到 ffmpeg / ffprobe，无法压缩音频并打包 m4b。请安装 ffmpeg 并加入 PATH。', {
      detail: ff.error,
    });
  }

  if (!chapters.length) throw new AudiobookError('没有勾选任何章节');
  if (!apiKey) throw new AudiobookError('缺少 MiMo API Key，请先在上方填写并保存');

  const client = new MiMoClient({
    apiKey,
    baseUrl,
    voice: settings.voice,
    context: settings.context,
    log,
  });

  /* ── 1. 规划：已完成章节直接复用 ── */
  const plans = [];
  const tasks = [];
  let totalChunks = 0;
  let doneChunks = 0;
  let doneChapters = 0;
  let aacBytes = 0;

  for (const chapter of chapters) {
    const record = state.chapters[chapter.key] || {};
    const cached = force ? null : await readPartMeta(projectPath, chapter.key, settings);

    if (cached) {
      // 复用片段时以 AAC 帧数重算时长，修正历史估算误差（章节标记精确到帧）
      const exactDur = adtsDurationSec(partPathFor(projectPath, chapter.key)) || cached.durationSec;
      if (Math.abs(exactDur - (cached.durationSec || 0)) > 0.5) {
        await writePartMeta(projectPath, chapter.key, { ...cached, durationSec: exactDur }).catch(() => {});
      }
      state.chapters[chapter.key] = {
        ...record,
        title: chapter.title,
        index: chapter.index,
        status: 'done',
        durationSec: exactDur,
        bytes: cached.bytes,
        error: '',
        partId: partIdFor(chapter.key),
        signature: cached.signature,
        updatedAt: new Date().toISOString(),
      };
      const guessed = Math.max(1, Math.ceil(chapter.content.length / settings.chunkChars));
      totalChunks += guessed;
      doneChunks += guessed;
      doneChapters += 1;
      aacBytes += cached.bytes;
      plans.push({ chapter, chunks: [], reused: true });
      continue;
    }

    const chunks = chunkText(chapter.content, settings.chunkChars);
    if (!chunks.length) {
      state.chapters[chapter.key] = {
        ...record,
        title: chapter.title,
        index: chapter.index,
        status: 'empty',
        error: '章节正文为空',
        partId: partIdFor(chapter.key),
        updatedAt: new Date().toISOString(),
      };
      continue;
    }

    if (record.status !== 'pending') {
      state.chapters[chapter.key] = {
        ...record,
        title: chapter.title,
        index: chapter.index,
        status: 'pending',
        error: '',
        partId: partIdFor(chapter.key),
        updatedAt: new Date().toISOString(),
      };
    }

    const plan = {
      chapter,
      chunks,
      reused: false,
      remaining: chunks.length,
      failed: false,
      assemblyQueued: false,
      bytes: 0,
    };
    plans.push(plan);
    totalChunks += chunks.length;

    chunks.forEach((text, ci) => tasks.push({ plan, chapter, ci, text }));
  }

  if (!plans.length) throw new AudiobookError('所选章节都没有正文');

  const totalChapters = chapters.length;
  const startedAt = Date.now();
  let lastEmit = 0;
  let failedChapters = 0;
  let processedTasks = 0;

  const emitProgress = (extra = {}, forceEmit = false) => {
    const now = Date.now();
    if (!forceEmit && now - lastEmit < 700) return;
    lastEmit = now;
    const elapsed = (Date.now() - startedAt) / 1000;
    const remaining = Math.max(0, tasks.length - processedTasks);
    const rate = processedTasks > 0 ? processedTasks / Math.max(elapsed, 1) : 0;
    patch({
      stage: 'tts',
      percent: totalChunks > 0 ? Math.min(99, Math.round((doneChunks / totalChunks) * 100)) : 0,
      doneChunks,
      totalChunks,
      doneChapters,
      totalChapters,
      aacBytes,
      elapsedSec: Math.round(elapsed),
      etaSec: rate > 0 ? Math.round(remaining / rate) : 0,
      ...extra,
    });
  };

  log(`开始合成：${totalChapters} 章 / ${totalChunks} 块 · 并发 ${settings.concurrency} · 音色 ${settings.voice} · ${settings.bitrateKbps}kbps AAC`);
  if (doneChapters > 0) log(`断点续跑：${doneChapters} 章已有压缩音频，直接复用`);
  emitProgress({}, true);

  state.status = 'running';
  state.settings = settings;
  await writeState(projectPath, state);

  /* ── 2. 章级收尾（串行，避免 ffmpeg 抢 CPU） ── */
  let assembleChain = Promise.resolve();
  const queueAssembly = (plan) => {
    if (plan.assemblyQueued) return;
    plan.assemblyQueued = true;
    assembleChain = assembleChain.then(async () => {
      const { chapter } = plan;
      emit({ type: 'chapter', data: { key: chapter.key, title: chapter.title, status: 'encoding' } });

      const workDir = path.join(paths.workDir, partIdFor(chapter.key));
      const chapterWav = path.join(workDir, '_chapter.wav');

      // 校验块文件齐全
      const chunkFiles = [];
      for (let ci = 0; ci < plan.chunks.length; ci += 1) {
        const file = path.join(workDir, `c_${String(ci).padStart(4, '0')}.wav`);
        if (!(await fs.stat(file).catch(() => null))?.size) {
          throw new Error(`缺少第 ${ci + 1}/${plan.chunks.length} 个音频块`);
        }
        chunkFiles.push(file);
      }

      const firstBuf = await fs.readFile(chunkFiles[0]);
      const firstInfo = parseWav(firstBuf);
      const format = {
        sampleRate: firstInfo.sampleRate || TARGET_SAMPLE_RATE,
        channels: firstInfo.channels || TARGET_CHANNELS,
        bitsPerSample: firstInfo.bitsPerSample || TARGET_BITS,
      };

      const writer = new WavStreamWriter(chapterWav, format).open();
      try {
        // 章间停顿放在本章开头：不影响章节标记起点，且可精确计时
        if (chapter.index > 0 && settings.chapterGapSec > 0) writer.appendSilence(settings.chapterGapSec);

        for (let i = 0; i < chunkFiles.length; i += 1) {
          let info;
          let pcm;
          try {
            const buf = await fs.readFile(chunkFiles[i]);
            info = parseWav(buf);
            pcm = extractPcm(buf).pcm;
          } catch {
            const converted = path.join(workDir, `_fix_${i}.wav`);
            await convertChunkToPcm(chunkFiles[i], converted);
            const buf = await fs.readFile(converted);
            info = parseWav(buf);
            pcm = extractPcm(buf).pcm;
            removeTree(converted, { recursive: false });
          }

          const sameFormat = info.sampleRate === format.sampleRate
            && info.channels === format.channels
            && info.bitsPerSample === format.bitsPerSample;
          if (!sameFormat) {
            const converted = path.join(workDir, `_conv_${i}.wav`);
            await convertChunkToPcm(chunkFiles[i], converted);
            const buf = await fs.readFile(converted);
            pcm = extractPcm(buf).pcm;
            removeTree(converted, { recursive: false });
          }

          writer.append(pcm);
          if (i < chunkFiles.length - 1 && settings.chunkGapSec > 0) {
            writer.appendSilence(settings.chunkGapSec);
          }
        }
      } finally {
        writer.finish();
      }

      const outPart = partPathFor(projectPath, chapter.key);
      const bytes = await encodeAac(chapterWav, outPart, {
        bitrateKbps: settings.bitrateKbps,
        sampleRate: format.sampleRate,
        channels: format.channels,
      });
      const durationSec = adtsDurationSec(outPart) || writer.durationSec || (await probeDuration(outPart));

      await writePartMeta(projectPath, chapter.key, {
        chapterKey: chapter.key,
        title: chapter.title,
        durationSec,
        bytes,
        chunks: plan.chunks.length,
        signature: settingsSignature(settings),
        createdAt: new Date().toISOString(),
      });

      removeTree(workDir);

      doneChapters += 1;
      aacBytes += bytes;
      plan.bytes = bytes;
      state.chapters[chapter.key] = {
        ...(state.chapters[chapter.key] || {}),
        title: chapter.title,
        index: chapter.index,
        status: 'done',
        durationSec,
        bytes,
        error: '',
        partId: partIdFor(chapter.key),
        signature: settingsSignature(settings),
        updatedAt: new Date().toISOString(),
      };
      await writeState(projectPath, state);

      log(`第 ${chapter.index + 1} 章完成 · ${plan.chunks.length} 块 · ${Math.round(durationSec)}s · ${(bytes / 1048576).toFixed(2)} MB`, 'success');
      emit({ type: 'chapter', data: {
        key: chapter.key, title: chapter.title, status: 'done', durationSec, bytes,
      } });
      emitProgress({}, true);
    }).catch(async (err) => {
      failedChapters += 1;
      plan.failed = true;
      state.chapters[plan.chapter.key] = {
        ...(state.chapters[plan.chapter.key] || {}),
        title: plan.chapter.title,
        index: plan.chapter.index,
        status: 'error',
        error: String(err?.message || err),
        partId: partIdFor(plan.chapter.key),
        updatedAt: new Date().toISOString(),
      };
      await writeState(projectPath, state).catch(() => {});
      log(`第 ${plan.chapter.index + 1} 章收尾失败：${err?.message || err}`, 'error');
      emit({ type: 'chapter', data: { key: plan.chapter.key, title: plan.chapter.title, status: 'error', error: String(err?.message || err) } });
    });
  };

  /* ── 3. 并发执行块任务 ── */
  let cursor = 0;
  let aborted = false;

  const worker = async () => {
    while (!aborted) {
      if (signal?.aborted) { aborted = true; return; }
      const idx = cursor;
      cursor += 1;
      if (idx >= tasks.length) return;
      const { plan, chapter, ci, text } = tasks[idx];

      if (plan.failed) {
        processedTasks += 1;
        continue;
      }

      const workDir = path.join(paths.workDir, partIdFor(chapter.key));
      const target = path.join(workDir, `c_${String(ci).padStart(4, '0')}.wav`);
      await fs.mkdir(workDir, { recursive: true });

      // 块级续跑
      if (!force) {
        const stat = await fs.stat(target).catch(() => null);
        if (stat && stat.size > 44) {
          try {
            parseWav(await fs.readFile(target));
            processedTasks += 1;
            doneChunks += 1;
            plan.remaining -= 1;
            if (plan.remaining === 0) queueAssembly(plan);
            emitProgress({ stage: `ch${chapter.index + 1}` });
            continue;
          } catch { /* 坏文件，重新合成 */ }
        }
      }

      try {
        const { wav } = await client.synthesize(text, { signal });
        parseWav(wav); // 早失败：返回的不是合法 WAV
        await fs.writeFile(target, wav);
        processedTasks += 1;
        doneChunks += 1;
        plan.remaining -= 1;
        if (plan.remaining === 0) queueAssembly(plan);
        emitProgress({ stage: `ch${chapter.index + 1}` });
      } catch (err) {
        processedTasks += 1;
        if (signal?.aborted) { aborted = true; return; }
        plan.failed = true;
        failedChapters += 1;
        state.chapters[chapter.key] = {
          ...(state.chapters[chapter.key] || {}),
          title: chapter.title,
          index: chapter.index,
          status: 'error',
          error: String(err?.message || err),
          partId: partIdFor(chapter.key),
          updatedAt: new Date().toISOString(),
        };
        await writeState(projectPath, state).catch(() => {});
        log(`第 ${chapter.index + 1} 章第 ${ci + 1} 块失败：${err?.message || err}`, 'error');
        emit({ type: 'chapter', data: { key: chapter.key, title: chapter.title, status: 'error', error: String(err?.message || err) } });
        emitProgress({ stage: `ch${chapter.index + 1}` }, true);
      }
    }
  };

  const workerCount = Math.min(settings.concurrency, Math.max(tasks.length, 1));
  await Promise.all(Array.from({ length: workerCount }, worker));
  await assembleChain;

  if (signal?.aborted || aborted) {
    state.status = 'stopped';
    await writeState(projectPath, state);
    emit({ type: 'stopped', message: '已停止；已完成的章节已保存，可再次启动续跑' });
    return { stopped: true, doneChapters, totalChapters };
  }

  if (failedChapters > 0) {
    state.status = 'error';
    await writeState(projectPath, state);
    throw new AudiobookError(
      `${failedChapters} 个章节未能完成，中间产物已保留；再次启动会自动重试失败章节`,
      { failedChapters, doneChapters, totalChapters },
    );
  }

  /* ── 4. 打包 m4b ── */
  emitProgress({ stage: 'packing', percent: 99 }, true);
  log('章节音频已就绪，开始封装 m4b…');

  const ordered = chapters
    .map((c) => ({ chapter: c, record: state.chapters[c.key] }))
    .filter(({ record }) => record?.status === 'done')
    .sort((a, b) => a.chapter.index - b.chapter.index);

  if (!ordered.length) throw new AudiobookError('没有成功合成的章节，无法打包 m4b');

  const parts = ordered.map(({ chapter, record }) => ({
    path: partPathFor(projectPath, chapter.key),
    title: chapter.title,
    durationSec: record.durationSec,
  }));

  const outFile = path.join(paths.outDir, `${safeName(meta.title || projectName)}.m4b`);
  await fs.mkdir(paths.outDir, { recursive: true });

  const info = await packM4b({
    parts,
    outPath: outFile,
    bitrateKbps: settings.bitrateKbps,
    meta: {
      title: meta.title || projectName,
      author: meta.author || '',
      album: meta.title || projectName,
      narrator: settings.voice,
      comment: `NovelAI Illustrator 有声书 · ${parts.length} 章`,
    },
    log,
  });

  const wavEquivalent = Math.round(info.durationSec * TARGET_SAMPLE_RATE * TARGET_CHANNELS * (TARGET_BITS / 8));
  const ratio = info.bytes > 0 ? Number((wavEquivalent / info.bytes).toFixed(1)) : 0;

  state.status = 'done';
  state.output = {
    file: path.basename(outFile),
    bytes: info.bytes,
    durationSec: info.durationSec,
    chapters: info.chapters || parts.length,
    codec: info.codec,
    sampleRate: info.sampleRate,
    compressionRatio: ratio,
    settings,
    createdAt: new Date().toISOString(),
  };
  await writeState(projectPath, state);

  log(`m4b 已生成：${path.basename(outFile)} · ${Math.round(info.durationSec / 60)} 分钟 · ${(info.bytes / 1048576).toFixed(1)} MB（约为 WAV 的 1/${ratio}）`, 'success');
  emit({ type: 'done', data: state.output });
  return state.output;
}

function safeName(name) {
  return String(name || 'audiobook')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'audiobook';
}

/** 预估：章节数、总字数、总时长、产物体积 */
export function summarize(chapters, settings) {
  const chars = chapters.reduce((s, c) => s + c.content.replace(/\s/g, '').length, 0);
  const durationSec = chapters.reduce((s, c) => s + estimateDurationSec(c.content), 0);
  const bytes = Math.round((durationSec * settings.bitrateKbps * 1000) / 8);
  return { chars, durationSec, bytes, chapters: chapters.length };
}

export { sleep };
