#!/usr/bin/env node
/**
 * 本地批量压缩插画（多路并行 / worker_threads）
 * ---------------------------------------------------------------
 * 把已生成的 NAI PNG 转成 WebP（默认 q85），原图替换，prompt/seed 另存 .txt。
 * 实测收益：832x1216 约 1.7MB → 140KB；1024x1024 约 1.5MB → 110KB。
 *
 * 用法：
 *   node scripts/compress-images.mjs                      # 全部项目，q85
 *   node scripts/compress-images.mjs --dry-run            # 只统计不压缩
 *   node scripts/compress-images.mjs -j 8 -q 88           # 8 路并行，质量 88
 *   node scripts/compress-images.mjs --only 楠楠的暴露     # 只处理某个项目
 *   node scripts/compress-images.mjs --docs               # 额外包含 docs/ 下的图片
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SERVICES = pathToFileURL(path.join(ROOT, 'server', 'services', 'image-compress.js')).href;

function parseArgs(argv) {
  const opts = { quality: 85, jobs: Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1)), replace: true, sidecar: true, dryRun: false, only: null, docs: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quality' || a === '-q') opts.quality = Number(argv[++i]) || 85;
    else if (a === '--jobs' || a === '-j') opts.jobs = Math.max(1, Number(argv[++i]) || 4);
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]) || 0;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--docs') opts.docs = true;
    else if (a === '--keep-original') opts.replace = false;
    else if (a === '--no-sidecar') opts.sidecar = false;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node scripts/compress-images.mjs [选项]

  -q, --quality <n>       WebP 质量，默认 85（30~100）
  -j, --jobs <n>          并行进程数，默认 CPU 核数-1（最多 8）
      --only <项目名>      只处理指定项目
      --docs              额外处理 docs/ 下的图片
      --limit <n>         只处理前 n 张（试跑用）
      --dry-run           只统计体积，不实际压缩
      --keep-original     保留原 PNG（默认替换删除）
      --no-sidecar        不导出 prompt/seed 的 .txt`);
}

/* ───────────────── worker 侧 ───────────────── */
if (!isMainThread) {
  const { compressFile } = await import(SERVICES);
  const { quality, replace, sidecar } = workerData;
  parentPort.on('message', async (msg) => {
    if (msg.type === 'exit') process.exit(0);
    if (msg.type !== 'task') return;
    try {
      const r = await compressFile(msg.file, { quality, replace, sidecar });
      parentPort.postMessage({ type: 'done', file: msg.file, before: r.before, after: r.after, skipped: !!r.skipped });
    } catch (err) {
      parentPort.postMessage({ type: 'error', file: msg.file, error: String(err?.message || err) });
    }
  });
} else {
  /* ───────────────── 主线程 ───────────────── */
  const opts = parseArgs(process.argv);
  const { listImages } = await import(SERVICES);

  async function collectDirs() {
    const dirs = [];
    const projectsDir = path.join(ROOT, 'projects');
    const names = await fs.readdir(projectsDir).catch(() => []);
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (opts.only && name !== opts.only) continue;
      const st = await fs.stat(path.join(projectsDir, name)).catch(() => null);
      if (!st?.isDirectory()) continue;
      dirs.push({ dir: path.join(projectsDir, name, 'illustrations'), recursive: false });
      dirs.push({ dir: path.join(projectsDir, name, 'comic', 'assets'), recursive: true });
    }
    if (opts.docs && !opts.only) {
      for (const sub of ['suozhang_images', 'generated_scenes', 'composition_style_images']) {
        dirs.push({ dir: path.join(ROOT, 'docs', sub), recursive: false });
      }
    }
    return dirs;
  }

  console.log(`\n🗜️  本地批量压缩 | q=${opts.quality} | ${opts.jobs} 路并行 | ${opts.replace ? '替换原图' : '保留原图'}${opts.dryRun ? ' | DRY-RUN' : ''}`);

  const dirs = await collectDirs();
  const files = [];
  for (const d of dirs) {
    const found = await listImages(d.dir, { recursive: d.recursive });
    if (found.length) {
      files.push(...found);
      console.log(`  · ${path.relative(ROOT, d.dir)}：${found.length} 张`);
    }
  }
  if (opts.limit > 0) files.length = Math.min(files.length, opts.limit);

  if (!files.length) {
    console.log('没有找到可压缩的图片。');
    process.exit(0);
  }

  if (opts.dryRun) {
    let total = 0, count = 0;
    for (const f of files) {
      const s = await fs.stat(f).catch(() => null);
      if (s) { total += s.size; count++; }
    }
    console.log(`\n共 ${count} 张，合计 ${(total / 1024 / 1024).toFixed(1)} MB`);
    console.log(`预估压缩后约 ${(total / 1024 / 1024 / 11).toFixed(1)} MB（按 9% 估算，省 ${(total / 1024 / 1024 * 0.91).toFixed(1)} MB）`);
    process.exit(0);
  }

  console.log(`\n共 ${files.length} 张待处理，启动 ${opts.jobs} 个 worker...\n`);

  const stats = { done: 0, failed: 0, skipped: 0, before: 0, after: 0 };
  const errors = [];
  let cursor = 0;
  let finished = 0;
  const t0 = Date.now();

  const workers = [];
  for (let i = 0; i < opts.jobs; i++) {
    const w = new Worker(__filename, { workerData: { quality: opts.quality, replace: opts.replace, sidecar: opts.sidecar } });
    w.on('message', (msg) => {
      if (msg.type === 'done') {
        stats.done++;
        if (msg.skipped) stats.skipped++;
        stats.before += msg.before;
        stats.after += msg.after;
      } else if (msg.type === 'error') {
        stats.failed++;
        if (errors.length < 30) errors.push(msg);
      }
      dispatch(w);
    });
    w.on('error', (err) => {
      stats.failed++;
      if (errors.length < 30) errors.push({ file: '(worker)', error: String(err?.message || err) });
      dispatch(w);
    });
    workers.push(w);
  }

  function dispatch(w) {
    if (cursor >= files.length) {
      w.postMessage({ type: 'exit' });
      finished++;
      if (finished >= opts.jobs) finish();
      return;
    }
    w.postMessage({ type: 'task', file: files[cursor++] });
  }

  let timer = setInterval(() => {
    const pct = ((stats.done + stats.failed) / files.length * 100).toFixed(1);
    const savedMB = (stats.before - stats.after) / 1024 / 1024;
    const speed = (stats.done / ((Date.now() - t0) / 1000)).toFixed(1);
    process.stdout.write(`\r  进度 ${pct}%  (${stats.done + stats.failed}/${files.length})  失败 ${stats.failed}  已省 ${savedMB.toFixed(0)}MB  ${speed}张/s   `);
  }, 500);

  let finishedOnce = false;
  function finish() {
    if (finishedOnce) return;
    finishedOnce = true;
    clearInterval(timer);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const beforeMB = stats.before / 1024 / 1024;
    const afterMB = stats.after / 1024 / 1024;
    const ratio = stats.before ? (stats.after / stats.before * 100).toFixed(1) : '0';
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
    console.log(`\n✅ 完成：${stats.done} 张成功（跳过 ${stats.skipped}），失败 ${stats.failed}`);
    console.log(`   体积：${beforeMB.toFixed(1)} MB → ${afterMB.toFixed(1)} MB（${ratio}%），省下 ${(beforeMB - afterMB).toFixed(1)} MB`);
    console.log(`   耗时：${dt}s`);
    if (errors.length) {
      console.log('\n⚠️ 失败样本：');
      for (const e of errors.slice(0, 10)) console.log(`   ${path.relative(ROOT, e.file)} → ${e.error}`);
    }
    process.exit(stats.failed > 0 && stats.done === 0 ? 1 : 0);
  }

  for (const w of workers) dispatch(w);
}
