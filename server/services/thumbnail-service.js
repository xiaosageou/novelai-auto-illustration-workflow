import path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';

// 在 Windows 上禁用 libvips 文件锁缓存，防止文件句柄占用引发 EBUSY
sharp.cache({ files: 0 });

/**
 * 内存中记录正在生成的缩略图任务，防止并发请求对同一文件重复生成或在 Windows 上引起写锁冲突
 */
const inFlightThumbnails = new Map();

/**
 * 校验并限制请求的缩略图宽度
 */
export function sanitizeThumbnailWidth(widthParam, defaultWidth = 360) {
  const parsed = parseInt(widthParam, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultWidth;
  }
  return Math.min(1600, Math.max(64, parsed));
}

/**
 * 校验路径安全性，防止目录穿越
 */
export function validateProjectPath(projectsDir, projectName, subPath) {
  if (!projectName || projectName.includes('..') || projectName.includes('/') || projectName.includes('\\')) {
    return null;
  }
  if (!subPath || subPath.includes('..')) {
    return null;
  }

  const projectRoot = path.resolve(projectsDir, projectName);
  const targetPath = path.resolve(projectRoot, subPath);

  const relRoot = path.relative(projectsDir, projectRoot);
  if (relRoot.startsWith('..') || path.isAbsolute(relRoot) || relRoot === '') {
    return null;
  }

  const relFile = path.relative(projectRoot, targetPath);
  if (relFile.startsWith('..') || path.isAbsolute(relFile)) {
    return null;
  }

  return { projectRoot, targetPath, relFile };
}

/**
 * 生成或读取缩略图
 */
export async function getOrGenerateThumbnail({
  originalPath,
  cacheDir,
  width,
  quality = 80
}) {
  const origStat = await fs.stat(originalPath);
  if (!origStat.isFile()) {
    throw new Error('原始路径不是有效文件');
  }

  const parsed = path.parse(originalPath);
  const pathHash = crypto.createHash('md5').update(originalPath).digest('hex').slice(0, 8);
  const cacheFilename = `${parsed.name}_${pathHash}_w${width}.webp`;
  const cachePath = path.join(cacheDir, cacheFilename);

  // 1. 检查缓存是否有效（缓存文件修改时间 >= 原图修改时间且大小 > 0）
  try {
    const cacheStat = await fs.stat(cachePath);
    if (cacheStat.mtimeMs >= origStat.mtimeMs && cacheStat.size > 0) {
      return cachePath;
    }
  } catch {
    // 缓存不存在或损坏，继续生成
  }

  // 2. 检查是否有并发生成任务，复用同个 Promise
  let genPromise = inFlightThumbnails.get(cachePath);
  if (!genPromise) {
    genPromise = (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      const tempPath = `${cachePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await sharp(originalPath)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality, effort: 3 })
          .toFile(tempPath);

        // Windows 上原子重命名覆盖
        await fs.rename(tempPath, cachePath).catch(async () => {
          // 若已有先完成的重命名，尝试清理临时文件
          await fs.unlink(tempPath).catch(() => {});
        });
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        throw err;
      }
    })();

    inFlightThumbnails.set(cachePath, genPromise);
    try {
      await genPromise;
    } finally {
      inFlightThumbnails.delete(cachePath);
    }
  } else {
    await genPromise;
  }

  return cachePath;
}

/**
 * Express 缩略图中间件
 * 挂载于 app.use('/projects', createThumbnailMiddleware({ projectsDir }))
 */
export function createThumbnailMiddleware({ projectsDir }) {
  const supportedExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

  return async function thumbnailMiddleware(req, res, next) {
    const widthParam = req.query.w || req.query.width;
    if (!widthParam) {
      return next();
    }

    try {
      let rawPath = req.path || '';
      try {
        rawPath = decodeURIComponent(rawPath);
      } catch {
        // 解码异常直接交给静态托管
        return next();
      }

      const parts = rawPath.replace(/^\/+/, '').split('/');
      if (parts.length < 2) {
        return next();
      }

      const projectName = parts[0];
      const subPath = parts.slice(1).join('/');

      const ext = path.extname(subPath).toLowerCase();
      if (!supportedExtensions.has(ext)) {
        return next();
      }

      const validated = validateProjectPath(projectsDir, projectName, subPath);
      if (!validated) {
        return next();
      }

      const width = sanitizeThumbnailWidth(widthParam);
      const cacheDir = path.join(validated.projectRoot, '.cache', 'thumbnails');

      const cachePath = await getOrGenerateThumbnail({
        originalPath: validated.targetPath,
        cacheDir,
        width,
        quality: 80
      });

      res.type('image/webp');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.sendFile(cachePath);
    } catch (err) {
      // 缩略图失败时静默回退到原图托管，保证页面功能不受影响
      return next();
    }
  };
}
