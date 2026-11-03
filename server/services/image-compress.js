/**
 * 插画压缩服务
 * ---------------------------------------------------------------
 * NAI 出图为 32bit PNG，1.5~2.5MB/张。实测转 WebP q85 后体积约 1/10，
 * PSNR 37~40dB（肉眼不可分辨），是无感压缩的甜点参数。
 *
 * 关键：NAI 把完整 prompt / seed / steps 存在 PNG 的 tEXt chunk(Comment) 里，
 * 转 WebP 会丢。因此本模块把元数据落到两个地方：
 *   1. 同名 .txt sidecar（权威存档，人类可读）
 *   2. WebP 的 EXIF ImageDescription（软件里能读回）
 */
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const DEFAULT_QUALITY = 85;
export const SUPPORTED_INPUT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
export const COMPRESSIBLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

/** 解析 PNG 的 tEXt / iTXt / zTXt 块（sharp 已能读大部分，这里是兜底） */
export function readPngTextChunks(buf) {
  const out = {};
  if (!buf || buf.length < 12) return out;
  if (buf.readUInt32BE(0) !== 0x89504e47) return out;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (off + 12 + len > buf.length) break;
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1);
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const keyword = data.toString('latin1', 0, z);
        let p = z + 1;
        const compFlag = data[p]; p += 1;
        p += 1; // compression method
        const langEnd = data.indexOf(0, p); p = langEnd + 1;
        const transEnd = data.indexOf(0, p); p = transEnd + 1;
        out[keyword] = compFlag === 0 ? data.toString('utf8', p) : '';
      }
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

/** 提取 NAI 元数据：优先 sharp 的 comments，兜底手动解析 */
export async function extractMetadata(buf) {
  const text = {};
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    for (const c of meta.comments || []) {
      if (c && c.keyword) text[c.keyword] = c.text;
    }
  } catch { /* 忽略 */ }
  for (const [k, v] of Object.entries(readPngTextChunks(buf))) {
    if (!(k in text)) text[k] = v;
  }
  // Comment 里是 NAI 的 JSON：prompt / uc / seed / steps 等
  let naiParams = null;
  if (text.Comment) {
    try { naiParams = JSON.parse(text.Comment); } catch { naiParams = null; }
  }
  return { text, naiParams };
}

/** 判断图片是否真的带可见 alpha（全不透明则可安全丢掉 alpha 通道，体积更小） */
async function hasMeaningfulAlpha(buf) {
  try {
    const { channels } = await sharp(buf, { failOn: 'none' }).metadata();
    if (!channels || channels < 4) return false;
    const stats = await sharp(buf, { failOn: 'none' }).extractChannel('alpha').stats();
    return stats.channels[0].min < 250;
  } catch {
    return true; // 判断失败就保守保留
  }
}

function buildExifDescription(text) {
  const parts = [];
  if (text.Comment) parts.push(text.Comment);
  else if (text.Description) parts.push(text.Description);
  if (text.Source) parts.push(`Source: ${text.Source}`);
  if (text.Generation_time) parts.push(`Generation_time: ${text.Generation_time}`);
  return parts.join('\n').slice(0, 60000);
}

/**
 * 压缩单个 buffer
 * @returns {Promise<{buffer: Buffer, width: number, height: number, metadata: object}>}
 */
export async function compressBuffer(buf, { quality = DEFAULT_QUALITY, effort = 4 } = {}) {
  const metadata = await extractMetadata(buf);
  const keepAlpha = await hasMeaningfulAlpha(buf);

  let pipe = sharp(buf, { failOn: 'none' });
  if (!keepAlpha) pipe = pipe.removeAlpha();

  const desc = buildExifDescription(metadata.text);
  if (desc) {
    try {
      pipe = pipe.withMetadata({ exif: { IFD0: { ImageDescription: desc, Software: 'NovelAI Illustrator' } } });
    } catch { /* EXIF 写不进就只留 sidecar */ }
  }

  const out = await pipe.webp({ quality, effort, smartSubsample: true }).toBuffer({ resolveWithObject: true });
  return {
    buffer: out.data,
    width: out.info.width,
    height: out.info.height,
    metadata,
    keepAlpha
  };
}

function sidecarText(metadata, srcName) {
  const p = metadata.naiParams;
  const lines = [`# 源文件: ${srcName}`, `# 导出时间: ${new Date().toISOString()}`, ''];
  if (p) {
    for (const [k, v] of Object.entries(p)) {
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  } else if (metadata.text.Comment) {
    lines.push(`Comment: ${metadata.text.Comment}`);
  }
  for (const [k, v] of Object.entries(metadata.text)) {
    if (k !== 'Comment') lines.push(`${k}: ${v}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * 压缩单个文件
 * @param {string} srcPath 源文件绝对路径
 * @param {object} opts
 * @param {number} opts.quality WebP 质量，默认 85
 * @param {boolean} opts.replace 是否删除原图（默认 true = 替换）
 * @param {boolean} opts.sidecar 是否导出元数据 .txt（默认 true）
 * @param {string} opts.outDir 输出目录，默认与源同目录
 * @param {string} opts.ext 输出扩展名，默认 .webp
 * @returns {Promise<{outPath:string, before:number, after:number, skipped?:string}>}
 */
export async function compressFile(srcPath, {
  quality = DEFAULT_QUALITY,
  effort = 4,
  replace = true,
  sidecar = true,
  outDir = null,
  ext = '.webp'
} = {}) {
  const before = (await fs.stat(srcPath)).size;
  const buf = await fs.readFile(srcPath);

  // 已经是小体积 WebP 就跳过，避免二次有损
  const srcExt = path.extname(srcPath).toLowerCase();
  if (srcExt === ext && before < 400 * 1024) {
    return { outPath: srcPath, before, after: before, skipped: 'already-compressed' };
  }

  const { buffer, metadata } = await compressBuffer(buf, { quality, effort });
  const base = path.basename(srcPath, path.extname(srcPath));
  const targetDir = outDir || path.dirname(srcPath);
  const outPath = path.join(targetDir, base + ext);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(outPath, buffer);

  if (sidecar) {
    const txtPath = path.join(targetDir, base + '.txt');
    await fs.writeFile(txtPath, sidecarText(metadata, path.basename(srcPath)), 'utf8').catch(() => {});
  }

  if (replace && path.resolve(outPath) !== path.resolve(srcPath)) {
    await fs.unlink(srcPath).catch(() => {});
  }

  return { outPath, before, after: buffer.length };
}

/**
 * 批量压缩目录（不递归子目录，除非 recursive）
 */
export async function compressDirectory(dirPath, {
  quality = DEFAULT_QUALITY,
  replace = true,
  sidecar = true,
  recursive = false,
  concurrency = 4,
  onProgress = null,
  signal = null
} = {}) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.startsWith('.')) await walk(full);
      } else if (COMPRESSIBLE_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(full);
      }
    }
  }
  await walk(dirPath);

  const stats = { total: files.length, done: 0, failed: 0, skipped: 0, before: 0, after: 0, files: [] };
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      if (signal?.aborted) throw new Error('aborted');
      const f = files[cursor++];
      try {
        const r = await compressFile(f, { quality, replace, sidecar });
        stats.done++;
        if (r.skipped) stats.skipped++;
        stats.before += r.before;
        stats.after += r.after;
        stats.files.push({ src: f, out: r.outPath, before: r.before, after: r.after });
      } catch (err) {
        stats.failed++;
        stats.files.push({ src: f, error: String(err?.message || err) });
      }
      onProgress?.(stats);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, worker));
  return stats;
}

/** 列出目录下所有可压缩图片的绝对路径 */
export async function listImages(dirPath, { recursive = false } = {}) {
  const files = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.startsWith('.')) await walk(full);
      } else if (COMPRESSIBLE_EXT.has(path.extname(e.name).toLowerCase())) {
        files.push(full);
      }
    }
  }
  await walk(dirPath);
  return files;
}

/** 统计目录下可压缩图片的体积 */
export async function scanDirectory(dirPath, { recursive = false } = {}) {
  let total = 0, count = 0;
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.startsWith('.')) await walk(full);
      } else if (COMPRESSIBLE_EXT.has(path.extname(e.name).toLowerCase())) {
        const s = await fs.stat(full).catch(() => null);
        if (s) { total += s.size; count++; }
      }
    }
  }
  await walk(dirPath);
  return { count, bytes: total };
}
