import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheFilePath = path.join(__dirname, '..', 'database', 'danbooru_tags.json');

let allTags = [];

// 启动时同步加载词库至内存
try {
  if (fs.existsSync(cacheFilePath)) {
    const rawData = fs.readFileSync(cacheFilePath, 'utf-8');
    allTags = JSON.parse(rawData);
    console.log(`[Local Tag Searcher] Loaded ${allTags.length} tags successfully from offline database.`);
  } else {
    console.warn(`[Local Tag Searcher] Warning: Offline database file not found at ${cacheFilePath}. Please run 'build-tag-cache.js' first!`);
  }
} catch (e) {
  console.error(`[Local Tag Searcher] Error loading offline database:`, e.message);
}

/**
 * 本地模糊搜索 Danbooru 标签（中英文模糊匹配）
 */
export function searchTagsLocal(query, options = {}) {
  if (!query) return { results: [] };
  const lowerQuery = String(query).toLowerCase().trim();
  if (!lowerQuery) return { results: [] };

  const matched = [];
  const limit = options.limit || 30;

  for (const item of allTags) {
    const english = item.e;
    const chinese = item.c;

    const isChineseMatch = chinese && (chinese === lowerQuery || chinese.includes(lowerQuery));
    const isEnglishMatch = english && (english === lowerQuery || english.includes(lowerQuery));

    if (isChineseMatch || isEnglishMatch) {
      matched.push({
        tag: english,
        cn_name: chinese,
        category: "General",
        count: item.h || 0
      });
    }
  }

  // 按热度降序排序，并截取返回数量
  const results = matched
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { results };
}

/**
 * 本地关联共现推荐标签（兼容在线 getRelatedTagsOnline 接口）
 */
export function getRelatedTagsLocal(tags, limit = 15) {
  // 本地离线状态下，直接返回一些通用画质增强和常见插画拓展标签以供 LLM 提示词丰富化
  const commonBoosters = [
    { tag: "masterpiece", cn_name: "杰作", category: "General", count: 1000000 },
    { tag: "best quality", cn_name: "最佳质量", category: "General", count: 990000 },
    { tag: "highly detailed", cn_name: "极度精细", category: "General", count: 980000 },
    { tag: "ultra-detailed", cn_name: "超精细", category: "General", count: 970000 },
    { tag: "volumetric lighting", cn_name: "体积光", category: "General", count: 900000 },
    { tag: "depth of field", cn_name: "景深", category: "General", count: 850000 },
    { tag: "cinematic lighting", cn_name: "电影光效", category: "General", count: 800000 }
  ];
  return { results: commonBoosters.slice(0, limit) };
}
