#!/usr/bin/env node
/**
 * 修复 image_path 引用：把指向已不存在的 .png 改成对应的 .webp
 * ---------------------------------------------------------------
 * 压缩把 xxx.png 换成了 xxx.webp，但 pipeline_progress.json / comic/*.json
 * 里的 image_path 还写着 .png，前端请求就 404。
 *
 * 用法：
 *   node scripts/fix-image-paths.mjs --dry-run    # 只统计
 *   node scripts/fix-image-paths.mjs              # 实际修复
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const PROJECTS = path.join(ROOT, 'projects');
const DRY = process.argv.includes('--dry-run');

const PNG_REF = /"([^"\\]*\.png)"/g;

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

/** 收集所有需要处理的 json */
async function collectJson() {
  const out = [];
  async function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['.trash', '.cache', 'node_modules', '.git'].includes(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.name.endsWith('.json')) {
        out.push(full);
      }
    }
  }
  await walk(PROJECTS);
  return out;
}

function candidateBases(jsonPath, value) {
  const bases = [];
  // 项目根：projects/<name>
  const rel = path.relative(PROJECTS, jsonPath);
  const projectName = rel.split(path.sep)[0];
  bases.push(path.join(PROJECTS, projectName));
  // json 自身所在目录（comic/assets/... 这类相对路径可能以项目根为准，留作兜底）
  bases.push(path.dirname(jsonPath));
  // 全局 projects 根（.agent/ledger.json 之类）
  bases.push(PROJECTS);
  return bases;
}

async function resolveWebp(jsonPath, pngValue) {
  const webpValue = pngValue.replace(/\.png$/i, '.webp');
  const relNorm = pngValue.split('/').join(path.sep);
  const webpNorm = webpValue.split('/').join(path.sep);
  for (const base of candidateBases(jsonPath, pngValue)) {
    // 路径本身已在值里带了项目名时避免重复拼接
    const candidates = [
      path.join(base, webpNorm),
      path.join(base, relNorm.replace(/\.png$/i, '.webp'))
    ];
    for (const c of candidates) {
      if (await exists(c)) return webpValue;
    }
  }
  return null;
}

const files = await collectJson();
let changedFiles = 0;
let replacements = 0;
let unresolved = 0;
const unresolvedSamples = [];

for (const file of files) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
  if (!text.includes('.png')) continue;

  const matches = [...text.matchAll(PNG_REF)];
  if (!matches.length) continue;

  let newText = text;
  let localChanged = 0;

  for (const m of matches) {
    const value = m[1];
    const webpValue = await resolveWebp(file, value);
    if (!webpValue) {
      unresolved++;
      if (unresolvedSamples.length < 8) unresolvedSamples.push({ file: path.relative(ROOT, file), value });
      continue;
    }
    const before = `"${value}"`;
    const after = `"${webpValue}"`;
    if (newText.includes(before)) {
      newText = newText.replace(before, after);
      localChanged++;
    }
  }

  if (localChanged > 0) {
    changedFiles++;
    replacements += localChanged;
    if (!DRY) {
      await fs.writeFile(file, newText, 'utf8');
    }
    console.log(`  ${DRY ? '[dry]' : ' 修 '} ${String(localChanged).padStart(4)} 处  ${path.relative(ROOT, file)}`);
  }
}

console.log(`\n${DRY ? '（dry-run，未写入）' : '完成'}：${changedFiles} 个文件，${replacements} 处引用改为 .webp`);
if (unresolved > 0) {
  console.log(`未解析（目标 webp 不存在，保持原样）：${unresolved} 处`);
  for (const s of unresolvedSamples) console.log(`   ${s.file} → ${s.value}`);
}
