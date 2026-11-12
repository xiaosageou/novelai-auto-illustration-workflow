/**
 * 产物导出目录：把生成好的 m4b / epub 自动复制到挂载出来的可见目录。
 *
 * 默认（本地运行）落在 <项目根>/audiobook 与 <项目根>/book；
 * Docker 里用 AUDIOBOOK_EXPORT_DIR / EPUB_EXPORT_DIR 指向挂载点（/app/audiobook、/app/book），
 * 这样 NAS 上能直接在文件管理里看到成品，不必进 projects/ 深处翻。
 *
 * 约定：复制失败只记日志，绝不影响主流程——产物在 projects/ 里始终有一份。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

function resolveDir(envValue, fallbackName, baseDir) {
  const raw = String(envValue || '').trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.join(baseDir, raw);
  return path.join(baseDir, fallbackName);
}

/** 有声书产物导出目录（默认 audiobook/） */
export function audiobookExportDir(baseDir = process.cwd()) {
  return resolveDir(process.env.AUDIOBOOK_EXPORT_DIR, 'audiobook', baseDir);
}

/** EPUB 导出目录（默认 book/） */
export function epubExportDir(baseDir = process.cwd()) {
  return resolveDir(process.env.EPUB_EXPORT_DIR, 'book', baseDir);
}

/**
 * 复制单个文件到导出目录（同名覆盖）。
 * 先写 .part 临时名再 rename，避免 NAS 上被下载/同步工具读到半截文件。
 *
 * @returns {Promise<string>} 目标路径；失败时抛错，由调用方决定是否吞掉
 */
export async function copyToDir(srcFile, destDir) {
  const dir = String(destDir || '').trim();
  if (!dir) throw new Error('导出目录为空');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(srcFile));
  const tmp = `${dest}.part-${process.pid}`;
  await fs.copyFile(srcFile, tmp);
  try {
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return dest;
}

/** 友好地展示导出目录（相对项目根的路径更好读） */
export function prettyDir(dir, baseDir = process.cwd()) {
  const rel = path.relative(baseDir, dir);
  return rel && !rel.startsWith('..') ? `${rel}/` : `${dir}/`;
}
