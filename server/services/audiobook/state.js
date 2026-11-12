/**
 * 有声书状态存储：挂在原书籍项目目录下，书籍管理完全复用 projects/<书名>/。
 *
 * projects/<书名>/audiobook/
 *   state.json            设置 + 每章状态 + 产物信息
 *   parts/<hash>.aac      分章压缩音频（中间产物）
 *   parts/<hash>.json     该章的时长/体积/参数签名
 *   work/                 临时块 WAV（编码后立即清理）
 *   out/<书名>.m4b        最终产物
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

export const AUDIOBOOK_DIRNAME = 'audiobook';

export function audiobookPaths(projectPath) {
  const root = path.join(projectPath, AUDIOBOOK_DIRNAME);
  return {
    root,
    stateFile: path.join(root, 'state.json'),
    partsDir: path.join(root, 'parts'),
    workDir: path.join(root, 'work'),
    outDir: path.join(root, 'out'),
  };
}

/** 章节 → 稳定的片段 ID（chapterKey 不变则文件名不变，重排章节也不会错位） */
export function partIdFor(chapterKey) {
  return crypto.createHash('sha1').update(String(chapterKey || '')).digest('hex').slice(0, 12);
}

export function partPathFor(projectPath, chapterKey) {
  return path.join(audiobookPaths(projectPath).partsDir, `${partIdFor(chapterKey)}.aac`);
}

export function partMetaPathFor(projectPath, chapterKey) {
  return path.join(audiobookPaths(projectPath).partsDir, `${partIdFor(chapterKey)}.json`);
}

export const DEFAULT_SETTINGS = {
  voice: '白桦',
  bitrateKbps: 48,
  concurrency: 4,
  chunkChars: 1600,
  chunkGapSec: 0.35,
  chapterGapSec: 1.0,
  context: '',
};

export function normalizeSettings(input = {}) {
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    voice: String(input.voice || DEFAULT_SETTINGS.voice),
    bitrateKbps: num(input.bitrateKbps, 48, 24, 128),
    concurrency: Math.round(num(input.concurrency, 4, 1, 16)),
    chunkChars: Math.round(num(input.chunkChars, 1600, 400, 2400)),
    chunkGapSec: num(input.chunkGapSec, 0.35, 0, 3),
    chapterGapSec: num(input.chapterGapSec, 1.0, 0, 5),
    context: String(input.context || '').slice(0, 2000),
  };
}

/** 参数签名：音色/码率/块大小变化时，旧片段判定为失效 */
export function settingsSignature(settings) {
  return `${settings.voice}|${settings.bitrateKbps}|${settings.chunkChars}|24000`;
}

export async function ensureAudiobookDirs(projectPath) {
  const p = audiobookPaths(projectPath);
  for (const dir of [p.root, p.partsDir, p.workDir, p.outDir]) {
    await fs.mkdir(dir, { recursive: true });
  }
  return p;
}

export async function readState(projectPath, projectName) {
  const p = audiobookPaths(projectPath);
  try {
    const raw = await fs.readFile(p.stateFile, 'utf8');
    const state = JSON.parse(raw);
    return {
      version: 1,
      projectName,
      settings: normalizeSettings(state.settings),
      chapters: state.chapters || {},
      output: state.output || null,
      status: state.status || 'idle',
      updatedAt: state.updatedAt || null,
    };
  } catch {
    return {
      version: 1,
      projectName,
      settings: { ...DEFAULT_SETTINGS },
      chapters: {},
      output: null,
      status: 'idle',
      updatedAt: null,
    };
  }
}

export async function writeState(projectPath, state) {
  const p = audiobookPaths(projectPath);
  await fs.mkdir(p.root, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const tmp = `${p.stateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, p.stateFile);
  return next;
}

/** 章节片段是否可用（存在且签名匹配） */
export async function readPartMeta(projectPath, chapterKey, settings) {
  const metaFile = partMetaPathFor(projectPath, chapterKey);
  const audioFile = partPathFor(projectPath, chapterKey);
  try {
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    if (meta.signature !== settingsSignature(settings)) return null;
    const stat = await fs.stat(audioFile);
    if (stat.size < 1024) return null;
    return { ...meta, bytes: stat.size };
  } catch {
    return null;
  }
}

export async function writePartMeta(projectPath, chapterKey, meta) {
  const file = partMetaPathFor(projectPath, chapterKey);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
