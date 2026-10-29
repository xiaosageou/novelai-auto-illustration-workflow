import { promises as fs } from 'fs';
import path from 'path';
import { readJson } from './db.js';
import { parseChapterHeading, isVolumeHeading, selectBareNumberHeadings } from './chapter-heading.js';

// 按 pipeline-manager.parseNovel 相同的标题判定逻辑统计章节数。
// 只计数，不保存章节内容，用于项目列表页快速展示进度。
export function countChaptersFromText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const bareNumberHeadingIndexes = selectBareNumberHeadings(lines);
  let chapterCount = 0;
  let currentContent = [];
  const saveChapter = (contentLines) => {
    if (contentLines.length > 0) chapterCount += 1;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const stripped = line.trim();
    if (!stripped) continue;

    const chapterHeading = parseChapterHeading(stripped)
      || (bareNumberHeadingIndexes.has(lineIndex) ? stripped : null);

    if (isVolumeHeading(stripped) && !chapterHeading) {
      saveChapter(currentContent);
      currentContent = [];
    } else if (chapterHeading) {
      saveChapter(currentContent);
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  saveChapter(currentContent);
  return chapterCount;
}

const summaryCache = new Map();

/**
 * 项目列表页使用的轻量进度摘要。
 * 读取 pipeline_progress.json + book.txt，按文件 mtime 缓存结果。
 */
export async function getProjectSummary(projectName, projectsDir) {
  const projectPath = path.join(projectsDir, projectName);
  const bookPath = path.join(projectPath, 'book.txt');
  const progressPath = path.join(projectPath, 'pipeline_progress.json');

  const stat = async (p) => {
    try {
      return await fs.stat(p);
    } catch {
      return null;
    }
  };

  const bookStat = await stat(bookPath);
  const progressStat = await stat(progressPath);

  const cacheKey = `${projectName}:${bookStat?.mtimeMs ?? 0}:${progressStat?.mtimeMs ?? 0}`;
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  const bookText = bookStat ? await fs.readFile(bookPath, 'utf-8') : '';
  const totalChapters = countChaptersFromText(bookText);

  const progressData = progressStat ? await readJson(progressPath, {}) : {};
  const completedChaptersMap = progressData.completed_chapters || {};
  let completedChapters = 0;
  let generatingChapters = 0;
  let failedChapters = 0;
  let pendingChapters = 0;
  for (const chapter of Object.values(completedChaptersMap)) {
    const status = chapter?.status;
    if (status === 'completed') completedChapters += 1;
    else if (status === 'generating') generatingChapters += 1;
    else if (status === 'failed') failedChapters += 1;
    else pendingChapters += 1;
  }

  const summary = {
    totalChapters,
    completedChapters,
    generatingChapters,
    failedChapters,
    pendingChapters,
    charactersCount: Object.keys(progressData.global_characters || {}).length,
    paused: Boolean(progressData.pipeline_pause),
    pauseReason: progressData.pipeline_pause?.reason || null
  };

  summaryCache.set(cacheKey, summary);
  return summary;
}
