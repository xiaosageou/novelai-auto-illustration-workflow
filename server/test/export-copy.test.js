import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  audiobookExportDir, epubExportDir, copyToDir, prettyDir,
} from '../utils/export-copy.js';

async function tmpDir(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), `export-copy-${tag}-`));
}

test('默认导出目录是项目根下的 audiobook/ 与 book/', () => {
  const saved = { ...process.env };
  delete process.env.AUDIOBOOK_EXPORT_DIR;
  delete process.env.EPUB_EXPORT_DIR;
  try {
    const base = '/tmp/base';
    assert.equal(audiobookExportDir(base), path.join(base, 'audiobook'));
    assert.equal(epubExportDir(base), path.join(base, 'book'));
  } finally {
    process.env = saved;
  }
});

test('环境变量支持绝对路径与相对路径', () => {
  const saved = { ...process.env };
  try {
    process.env.AUDIOBOOK_EXPORT_DIR = '/mnt/audiobooks';
    process.env.EPUB_EXPORT_DIR = 'out/books';
    assert.equal(audiobookExportDir('/app'), '/mnt/audiobooks');
    assert.equal(epubExportDir('/app'), path.join('/app', 'out/books'));
  } finally {
    process.env = saved;
  }
});

test('copyToDir 会建目录并同名覆盖，不留 .part 临时文件', async () => {
  const src = await tmpDir('src');
  const dst = await tmpDir('dst');
  const file = path.join(src, 'demo.m4b');
  await fs.writeFile(file, 'v1');

  const out = await copyToDir(file, path.join(dst, 'audiobook'));
  assert.equal(out, path.join(dst, 'audiobook', 'demo.m4b'));
  assert.equal(await fs.readFile(out, 'utf8'), 'v1');

  await fs.writeFile(file, 'v2-longer');
  await copyToDir(file, path.join(dst, 'audiobook'));
  assert.equal(await fs.readFile(out, 'utf8'), 'v2-longer', '同名文件应被覆盖');

  const leftovers = (await fs.readdir(path.join(dst, 'audiobook'))).filter((n) => n.includes('.part'));
  assert.deepEqual(leftovers, []);
});

test('prettyDir 在项目内显示相对路径，项目外显示绝对路径', () => {
  assert.equal(prettyDir('/app/audiobook', '/app'), 'audiobook/');
  assert.equal(prettyDir('/mnt/music', '/app'), '/mnt/music/');
});
