/**
 * ffmpeg 封装：WAV → AAC 压缩、m4b 封装、产物校验。
 *
 * 只产出 m4b：中间产物是分章 ADTS AAC（.aac），最终单遍流式封装为 .m4b，
 * 全程不保留整书 WAV。24kHz/16bit 单声道 WAV 是 384kbps，
 * 压成 48kbps AAC 后体积约为 1/8。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { removeTree } from './wav.js';

const FFMPEG = process.env.AUDIOBOOK_FFMPEG || process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.AUDIOBOOK_FFPROBE || process.env.FFPROBE_PATH || 'ffprobe';

export const BITRATE_PRESETS = [
  { id: 32, label: '32 kbps', note: '极限压缩 · 约 14 MB/小时' },
  { id: 48, label: '48 kbps', note: '推荐 · 约 22 MB/小时' },
  { id: 64, label: '64 kbps', note: '高音质 · 约 29 MB/小时' },
  { id: 96, label: '96 kbps', note: '接近无损听感 · 约 43 MB/小时' },
];

function run(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${stderr.slice(-600)}`));
    });
  });
}

/** 检查 ffmpeg / ffprobe 是否可用 */
export async function checkFfmpeg() {
  try {
    const [{ stdout: v1 }, { stdout: v2 }] = await Promise.all([
      run(FFMPEG, ['-version']),
      run(FFPROBE, ['-version']),
    ]);
    return {
      ok: true,
      ffmpeg: v1.split('\n')[0].trim(),
      ffprobe: v2.split('\n')[0].trim(),
      binary: FFMPEG,
    };
  } catch (err) {
    return { ok: false, error: messageOf(err), binary: FFMPEG };
  }
}

function messageOf(err) {
  return String(err?.message || err || '未知错误');
}

/** WAV → AAC(ADTS) 压缩，返回字节数 */
export async function encodeAac(wavPath, aacPath, opts = {}) {
  const bitrate = opts.bitrateKbps || 48;
  const sampleRate = opts.sampleRate || 24000;
  const channels = opts.channels || 1;

  fs.mkdirSync(path.dirname(aacPath), { recursive: true });
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wavPath,
    '-vn',
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-c:a', 'aac',
    '-b:a', `${bitrate}k`,
    '-f', 'adts',
    aacPath,
  ]);
  const size = fs.statSync(aacPath).size;
  if (!size) throw new Error('AAC 编码产物为空');
  return size;
}

/**
 * ADTS(AAC) → m4a 试听副本：只转封装不重编码，一章通常在百毫秒级完成。
 * 浏览器对裸 .aac 的支持参差不齐（Safari / 部分 Chromium 版本无法 seek），
 * MP4 容器 + faststart 后 <audio> 才能正常拖动进度条。
 */
export async function remuxToM4a(aacPath, m4aPath) {
  fs.mkdirSync(path.dirname(m4aPath), { recursive: true });
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', aacPath,
    '-vn', '-c:a', 'copy',
    '-movflags', '+faststart',
    '-f', 'ipod', m4aPath,
  ], { timeoutMs: 60000 });
  const size = fs.statSync(m4aPath).size;
  if (size < 1024) throw new Error('试听音频转封装产物为空');
  return size;
}

/** 读取媒体时长（秒），失败返回 0 */
export async function probeDuration(filePath) {
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const val = Number.parseFloat(stdout.trim());
    return Number.isFinite(val) && val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * 精确统计 ADTS(AAC) 文件的时长。
 *
 * ffprobe 对裸 ADTS 只能按码率「估算」时长，误差可达 20%（会让章节标记越界）。
 * AAC-LC 每帧固定 1024 个采样点，所以直接数帧最准：
 *   duration = Σ (raw_blocks + 1) * 1024 / sampleRate
 */
export function adtsDurationSec(filePath, { frameBytes = 1024 } = {}) {
  const buf = fs.readFileSync(filePath);
  let offset = 0;
  let frames = 0;
  let blocks = 0;
  let sampleRate = 24000;

  while (offset + 7 <= buf.length) {
    if (buf[offset] !== 0xff || (buf[offset + 1] & 0xf0) !== 0xf0) {
      // 失步：逐字节找下一帧头
      const next = buf.indexOf(0xff, offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const sampleRateIndex = (buf[offset + 2] >> 2) & 0x0f;
    if (ADTS_SAMPLE_RATES[sampleRateIndex]) sampleRate = ADTS_SAMPLE_RATES[sampleRateIndex];

    const frameLength = ((buf[offset + 3] & 0x03) << 11)
      | (buf[offset + 4] << 3)
      | (buf[offset + 5] >> 5);
    if (!frameLength || frameLength < 7) break;

    frames += 1;
    blocks += (buf[offset + 6] & 0x03) + 1;
    offset += frameLength;
  }

  if (!frames) return 0;
  return (blocks * frameBytes) / sampleRate;
}

/** 读取 m4b 结构：体积、时长、章节数、编码 */
export async function inspectM4b(filePath) {
  const stat = fs.statSync(filePath);
  const result = {
    bytes: stat.size, durationSec: 0, chapters: 0, codec: '', sampleRate: 0, channels: 0,
  };
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels,codec_type',
      '-of', 'json',
      filePath,
    ]);
    const info = JSON.parse(stdout);
    result.durationSec = Number.parseFloat(info.format?.duration || '0') || 0;
    const audio = (info.streams || []).find((s) => s.codec_type === 'audio') || (info.streams || [])[0] || {};
    result.codec = audio.codec_name || '';
    result.sampleRate = Number(audio.sample_rate || 0);
    result.channels = Number(audio.channels || 0);
  } catch { /* 至少返回体积 */ }

  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_chapters', '-of', 'json', filePath]);
    result.chapters = (JSON.parse(stdout).chapters || []).length;
  } catch { /* ignore */ }

  return result;
}

/** ffmetadata 值转义 */
function escapeMeta(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#')
    .replace(/\r?\n/g, ' ');
}

/**
 * 分章 AAC → 单个 m4b（含章节标记与元数据）。
 *
 * @param {object} opts
 * @param {Array<{ path:string, title:string, durationSec:number }>} opts.parts
 * @param {string} opts.outPath
 * @param {object} [opts.meta] { title, author, album, narrator, year, comment }
 * @param {string} [opts.coverPath]
 * @param {number} [opts.bitrateKbps] 仅兜底重编码时使用
 * @param {(msg:string,level?:string)=>void} [opts.log]
 */
export async function packM4b(opts) {
  const {
    parts, outPath, meta = {}, coverPath, log = () => {},
  } = opts;
  if (!parts.length) throw new Error('没有可打包的音频片段');

  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpBase = path.join(outDir, `.m4b-build-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  try {
    // 1. 章节时间轴：用真实 AAC 时长，避免编码 padding 造成累计漂移
    const marks = [];
    let cursor = 0;
    for (const part of parts) {
      // .aac 一律按帧数算，忽略传入的估算值（估算值会让章节标记越界）
      let dur = part.path.toLowerCase().endsWith('.aac') ? adtsDurationSec(part.path) : 0;
      if (!dur) dur = Number(part.durationSec) || 0;
      if (!dur) dur = await probeDuration(part.path);
      if (!dur) throw new Error(`无法读取片段时长：${path.basename(part.path)}`);
      marks.push({ title: part.title, start: cursor, end: cursor + dur });
      cursor += dur;
    }

    // 2. concat 列表
    const listPath = path.join(tmpBase, 'concat.txt');
    fs.writeFileSync(
      listPath,
      parts.map((p) => `file '${p.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );

    // 3. ffmetadata：全局元数据 + 章节
    const lines = [';FFMETADATA1'];
    if (meta.title) lines.push(`title=${escapeMeta(meta.title)}`);
    if (meta.author) lines.push(`artist=${escapeMeta(meta.author)}`);
    lines.push(`album=${escapeMeta(meta.album || meta.title || '有声书')}`);
    lines.push('genre=有声小说');
    if (meta.narrator) lines.push(`composer=${escapeMeta(`演播：${meta.narrator}`)}`);
    if (meta.year) lines.push(`date=${escapeMeta(meta.year)}`);
    lines.push(`comment=${escapeMeta(meta.comment || 'NovelAI Illustrator 有声书')}`);
    for (const m of marks) {
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000');
      lines.push(`START=${Math.round(m.start * 1000)}`);
      lines.push(`END=${Math.round(m.end * 1000)}`);
      lines.push(`title=${escapeMeta(m.title)}`);
    }
    const metaPath = path.join(tmpBase, 'meta.txt');
    fs.writeFileSync(metaPath, `${lines.join('\n')}\n`, 'utf8');

    // 4. 单遍封装：ADTS AAC 直接 copy 进 mp4，不重新编码
    const baseArgs = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-i', metaPath];

    const withCover = Boolean(coverPath && fs.existsSync(coverPath));
    if (withCover) {
      baseArgs.push('-i', coverPath, '-map', '0:a', '-map', '2:v',
        '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic', '-map_metadata', '1');
    } else {
      baseArgs.push('-map', '0:a', '-map_metadata', '1');
    }

    try {
      await run(FFMPEG, [...baseArgs, '-c:a', 'copy', '-movflags', '+faststart', '-f', 'ipod', outPath], {
        timeoutMs: 3600000,
      });
    } catch (err) {
      // 片段码流不一致时兜底：重新编码
      log(`直接封装失败（${messageOf(err).split('\n')[0]}），改为重新编码`, 'warn');
      const fallback = ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-i', metaPath,
        '-map', '0:a', '-map_metadata', '1',
        '-c:a', 'aac', '-b:a', `${opts.bitrateKbps || 48}k`,
        '-movflags', '+faststart', '-f', 'ipod', outPath];
      await run(FFMPEG, fallback, { timeoutMs: 3600000 });
    }

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
      throw new Error('m4b 打包产物异常（文件为空）');
    }
    return inspectM4b(outPath);
  } finally {
    removeTree(tmpBase);
  }
}

export { messageOf };
