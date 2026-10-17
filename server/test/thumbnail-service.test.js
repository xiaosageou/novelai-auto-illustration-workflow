import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import sharp from 'sharp';
import {
  sanitizeThumbnailWidth,
  validateProjectPath,
  getOrGenerateThumbnail,
  createThumbnailMiddleware
} from '../services/thumbnail-service.js';

test('sanitizeThumbnailWidth clamps dimensions safely', () => {
  assert.equal(sanitizeThumbnailWidth('360'), 360);
  assert.equal(sanitizeThumbnailWidth('10'), 64);
  assert.equal(sanitizeThumbnailWidth('5000'), 1600);
  assert.equal(sanitizeThumbnailWidth('invalid'), 360);
  assert.equal(sanitizeThumbnailWidth(null), 360);
});

test('validateProjectPath prevents directory traversal', () => {
  const tmpDir = path.join(os.tmpdir(), 'nai_test_projects_' + Date.now());

  // 合法路径
  const valid = validateProjectPath(tmpDir, 'my_project', 'illustrations/scene_1.png');
  assert.ok(valid);
  assert.equal(valid.relFile, path.join('illustrations', 'scene_1.png'));

  // 跨目录项目名
  assert.equal(validateProjectPath(tmpDir, '../secret', 'scene_1.png'), null);
  assert.equal(validateProjectPath(tmpDir, 'foo/bar', 'scene_1.png'), null);
  assert.equal(validateProjectPath(tmpDir, 'foo\\bar', 'scene_1.png'), null);

  // 跨目录文件路径
  assert.equal(validateProjectPath(tmpDir, 'my_project', '../../etc/passwd'), null);
  assert.equal(validateProjectPath(tmpDir, 'my_project', 'illustrations/../../secret.txt'), null);
});

test('getOrGenerateThumbnail generates WebP thumbnail and hits disk cache', async () => {
  const testDir = path.join(os.tmpdir(), 'nai_thumb_test_' + Date.now());
  const cacheDir = path.join(testDir, '.cache', 'thumbnails');
  await fs.mkdir(testDir, { recursive: true });

  const originalPath = path.join(testDir, 'test_scene.png');
  // 创建一个 800x800 的测试 PNG
  await sharp({
    create: {
      width: 800,
      height: 800,
      channels: 4,
      background: { r: 100, g: 150, b: 200, alpha: 1 }
    }
  }).png().toFile(originalPath);

  const thumbPath = await getOrGenerateThumbnail({
    originalPath,
    cacheDir,
    width: 200,
    quality: 80
  });

  assert.ok(thumbPath.endsWith('.webp'));
  const metadata = await sharp(thumbPath).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 200);

  // 二次调用应该命中缓存
  const stat1 = await fs.stat(thumbPath);
  const cachedPath = await getOrGenerateThumbnail({
    originalPath,
    cacheDir,
    width: 200,
    quality: 80
  });
  const stat2 = await fs.stat(cachedPath);
  assert.equal(stat1.mtimeMs, stat2.mtimeMs);

  // 清理
  await fs.rm(testDir, { recursive: true, force: true });
});

test('createThumbnailMiddleware passes through when no width param is provided', async () => {
  const middleware = createThumbnailMiddleware({ projectsDir: os.tmpdir() });

  let nextCalled = false;
  const req = { path: '/test_project/illustrations/scene.png', query: {} };
  const res = {};
  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
});

test('createThumbnailMiddleware generates and serves WebP thumbnail when width param is provided', async () => {
  const tmpProjectsDir = path.join(os.tmpdir(), 'nai_mw_test_' + Date.now());
  const projectDir = path.join(tmpProjectsDir, 'demo_book', 'illustrations');
  await fs.mkdir(projectDir, { recursive: true });

  const testFile = path.join(projectDir, 'scene_test.png');
  await sharp({
    create: { width: 600, height: 600, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } }
  }).png().toFile(testFile);

  const middleware = createThumbnailMiddleware({ projectsDir: tmpProjectsDir });

  let nextCalled = false;
  let sentFile = null;
  let setHeaders = {};
  let contentType = null;

  const req = {
    path: '/demo_book/illustrations/scene_test.png',
    query: { w: '300' }
  };
  const res = {
    type(t) { contentType = t; return this; },
    setHeader(k, v) { setHeaders[k] = v; return this; },
    sendFile(filePath) { sentFile = filePath; return this; }
  };

  await middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.ok(sentFile && sentFile.endsWith('.webp'));
  assert.equal(contentType, 'image/webp');
  assert.ok(setHeaders['Cache-Control']);

  const meta = await sharp(sentFile).metadata();
  assert.equal(meta.width, 300);

  await fs.rm(tmpProjectsDir, { recursive: true, force: true });
});

