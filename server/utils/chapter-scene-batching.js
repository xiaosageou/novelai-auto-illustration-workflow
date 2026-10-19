function normalizeTextBlock(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function splitByParagraphs(text) {
  const normalized = normalizeTextBlock(text);
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length <= 1) return paragraphs;

  const totalLength = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  const targetLength = totalLength / 2;
  let accumulatedLength = 0;
  let splitIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < paragraphs.length - 1; index++) {
    accumulatedLength += paragraphs[index].length;
    const distance = Math.abs(accumulatedLength - targetLength);
    if (distance < bestDistance) {
      bestDistance = distance;
      splitIndex = index + 1;
    }
  }

  return [
    paragraphs.slice(0, splitIndex).join('\n\n').trim(),
    paragraphs.slice(splitIndex).join('\n\n').trim()
  ].filter(Boolean);
}

function findNearestSentenceBoundary(text, preferredIndex) {
  const normalized = normalizeTextBlock(text);
  if (!normalized) return [];
  if (normalized.length <= 1) return [normalized];

  const safePreferred = Math.min(Math.max(1, preferredIndex), normalized.length - 1);
  const boundaries = [];
  const boundaryPattern = /[。！？!?；;]\s*|\n+/g;
  let match;
  while ((match = boundaryPattern.exec(normalized)) !== null) {
    const endIndex = match.index + match[0].length;
    if (endIndex > 0 && endIndex < normalized.length) {
      boundaries.push(endIndex);
    }
  }

  if (boundaries.length === 0) {
    return [normalized.slice(0, safePreferred).trim(), normalized.slice(safePreferred).trim()].filter(Boolean);
  }

  let bestIndex = boundaries[0];
  let bestDistance = Math.abs(bestIndex - safePreferred);
  for (const boundary of boundaries.slice(1)) {
    const distance = Math.abs(boundary - safePreferred);
    if (distance < bestDistance) {
      bestIndex = boundary;
      bestDistance = distance;
    }
  }

  return [
    normalized.slice(0, bestIndex).trim(),
    normalized.slice(bestIndex).trim()
  ].filter(Boolean);
}

function splitTextForSceneCount(text) {
  const normalized = normalizeTextBlock(text);
  if (!normalized) return [];

  const paragraphBatches = splitByParagraphs(normalized);
  if (paragraphBatches.length === 2) {
    return paragraphBatches;
  }

  return findNearestSentenceBoundary(normalized, Math.floor(normalized.length / 2));
}

export const TARGET_SLICE_START = '=== 【本批次重点提取目标切片（必须且仅在此范围内提炼分镜画面与提取 trigger_sentence）】 ===';
export const TARGET_SLICE_END = '=== 【目标切片结束】 ===';
export const PRECEDING_CONTEXT_START = '=== 【本章前序参考上下文（仅供理解人物、剧情与状态，禁止在此提取分镜）】 ===';
export const PRECEDING_CONTEXT_END = '=== 【前序参考上下文结束】 ===';
export const FOLLOWING_CONTEXT_START = '=== 【本章后序参考上下文（仅供理解剧情与状态，禁止在此提取分镜）】 ===';
export const FOLLOWING_CONTEXT_END = '=== 【后序参考上下文结束】 ===';

export function extractTargetSliceFromContext(text) {
  if (typeof text !== 'string') return '';
  const startIdx = text.indexOf(TARGET_SLICE_START);
  if (startIdx === -1) return '';
  const contentStart = startIdx + TARGET_SLICE_START.length;
  const endIdx = text.indexOf(TARGET_SLICE_END, contentStart);
  if (endIdx === -1) {
    return text.slice(contentStart).trim();
  }
  return text.slice(contentStart, endIdx).trim();
}

export function formatBatchTextWithContext({
  chapterText,
  startOffset = 0,
  endOffset = 0,
  isLongChapter = false,
  maxLongChapterTotal = 5000
}) {
  const normalizedChapter = normalizeTextBlock(chapterText);
  if (!normalizedChapter) return '';

  const safeStart = Math.max(0, Math.min(startOffset, normalizedChapter.length));
  const safeEnd = Math.max(safeStart, Math.min(endOffset, normalizedChapter.length));
  const sliceText = normalizedChapter.slice(safeStart, safeEnd).trim();

  // 若切片本身覆盖全章（单批次提炼），直接返回全章文本，无需包裹标注
  if (safeStart === 0 && safeEnd >= normalizedChapter.length) {
    return sliceText;
  }

  if (isLongChapter) {
    // 超过1万字：发送本切片 + 前面的总计0.5万字以内的内容（不发送后文）
    const maxPrecedingLen = Math.max(0, maxLongChapterTotal - sliceText.length);
    let precedingText = '';
    if (safeStart > 0 && maxPrecedingLen > 0) {
      const rawStart = Math.max(0, safeStart - maxPrecedingLen);
      precedingText = normalizedChapter.slice(rawStart, safeStart).trim();
    }

    const parts = [];
    if (precedingText) {
      parts.push(
        PRECEDING_CONTEXT_START,
        precedingText,
        PRECEDING_CONTEXT_END,
        ''
      );
    }
    parts.push(
      TARGET_SLICE_START,
      sliceText,
      TARGET_SLICE_END
    );
    return parts.join('\n');
  }

  // 不超过1万字：发送全章，但标出llm需要提取的切片
  const precedingText = normalizedChapter.slice(0, safeStart).trim();
  const followingText = normalizedChapter.slice(safeEnd).trim();

  const parts = [];
  if (precedingText) {
    parts.push(
      PRECEDING_CONTEXT_START,
      precedingText,
      PRECEDING_CONTEXT_END,
      ''
    );
  }
  parts.push(
    TARGET_SLICE_START,
    sliceText,
    TARGET_SLICE_END
  );
  if (followingText) {
    parts.push(
      '',
      FOLLOWING_CONTEXT_START,
      followingText,
      FOLLOWING_CONTEXT_END
    );
  }
  return parts.join('\n');
}

export function buildBatchPlan(text, sceneCount, { splitThreshold = 10000, maxScenesPerRequest = 5 } = {}) {
  const normalizedChapter = normalizeTextBlock(text);
  if (!normalizedChapter) return [];

  const numericSceneCount = Number.isInteger(sceneCount) && sceneCount > 0 ? sceneCount : 1;

  function recurse(currentText, currentCount, baseOffset) {
    const shouldSplitBySceneCount = currentCount > maxScenesPerRequest;
    const shouldSplitByLength = currentText.length > splitThreshold;

    if (!shouldSplitBySceneCount && !shouldSplitByLength) {
      return [{
        text: currentText,
        sceneCount: currentCount,
        startOffset: baseOffset,
        endOffset: baseOffset + currentText.length
      }];
    }

    const splitBatches = shouldSplitByLength
      ? splitChapterTextIntoBatches(currentText, splitThreshold)
      : splitTextForSceneCount(currentText);

    if (splitBatches.length <= 1) {
      return [{
        text: currentText,
        sceneCount: currentCount,
        startOffset: baseOffset,
        endOffset: baseOffset + currentText.length
      }];
    }

    const childSceneCounts = allocateSceneCounts(currentCount, splitBatches);
    const results = [];
    let searchFrom = 0;

    for (let index = 0; index < splitBatches.length; index++) {
      const batchText = splitBatches[index];
      const childCount = childSceneCounts[index] || 1;
      const foundIdx = currentText.indexOf(batchText, searchFrom);
      const batchOffset = foundIdx >= 0 ? baseOffset + foundIdx : baseOffset + searchFrom;
      searchFrom = (foundIdx >= 0 ? foundIdx : searchFrom) + batchText.length;

      const subBatches = recurse(batchText, childCount, batchOffset);
      results.push(...subBatches);
    }

    return results;
  }

  return recurse(normalizedChapter, numericSceneCount, 0);
}

export function splitChapterTextIntoBatches(text, threshold = 10000) {
  const normalized = normalizeTextBlock(text);
  if (!normalized) return [];
  if (normalized.length <= threshold) return [normalized];

  const paragraphBatches = splitByParagraphs(normalized);
  if (paragraphBatches.length === 2) {
    return paragraphBatches;
  }

  return findNearestSentenceBoundary(normalized, Math.floor(normalized.length / 2));
}

export function allocateSceneCounts(totalSceneCount, batchTexts) {
  const counts = [];
  const totalLength = batchTexts.reduce((sum, batchText) => {
    return sum + String(batchText || '').replace(/\s/g, '').length;
  }, 0);

  if (batchTexts.length === 0) return counts;
  if (batchTexts.length === 1 || totalSceneCount <= 1 || totalLength <= 0) {
    return [Math.max(1, totalSceneCount)];
  }

  let remaining = totalSceneCount;
  for (let index = 0; index < batchTexts.length; index++) {
    const batchLength = String(batchTexts[index] || '').replace(/\s/g, '').length;
    const isLast = index === batchTexts.length - 1;
    if (isLast) {
      counts.push(Math.max(1, remaining));
      break;
    }

    const proportion = batchLength / totalLength;
    let allocated = Math.round(totalSceneCount * proportion);
    const minRemaining = batchTexts.length - index - 1;

    allocated = Math.max(1, allocated);
    allocated = Math.min(allocated, remaining - minRemaining);
    counts.push(allocated);
    remaining -= allocated;
  }

  const sum = counts.reduce((acc, value) => acc + value, 0);
  if (sum !== totalSceneCount && counts.length > 0) {
    counts[counts.length - 1] += totalSceneCount - sum;
  }

  return counts;
}

export async function extractChapterScenesInBatches({
  chapterTitle,
  text,
  model,
  sceneExtractor,
  onProgressLog = null,
  onBatchExtracted = null,
  onBatchFailed = null,
  requestedSceneCount = null,
  sceneCountOptions = {},
  maxScenesPerRequest = 5,
  splitThreshold = 10000,
  shouldAbort = null,
  signal = null
}) {
  const chapterText = normalizeTextBlock(text);
  if (!chapterText) {
    return [];
  }

  const isLongChapter = chapterText.length > 10000;
  const sceneCount = Number.isInteger(requestedSceneCount) && requestedSceneCount > 0
    ? requestedSceneCount
    : null;
  const batchPlan = sceneCount
    ? buildBatchPlan(chapterText, sceneCount, { splitThreshold, maxScenesPerRequest })
    : [{ text: chapterText, sceneCount: null, startOffset: 0, endOffset: chapterText.length }];

  if (batchPlan.length <= 1 || !sceneCount || sceneCount <= 1) {
    const scenes = await sceneExtractor.extractChapterScenes(chapterTitle, chapterText, model, onProgressLog, requestedSceneCount, sceneCountOptions);
    await onBatchExtracted?.(scenes, {
      batchIndex: 0,
      totalBatches: 1,
      requestedSceneCount: requestedSceneCount || scenes.length || 0,
      chapterTitle
    });
    return scenes;
  }
  const mergedScenes = [];

  for (let index = 0; index < batchPlan.length; index++) {
    if (shouldAbort?.() || signal?.aborted) {
      onProgressLog?.(`[LLM] 章节「${chapterTitle}」提炼已检测到暂停指令，已中止剩余批次。`);
      break;
    }
    const batchTitle = `${chapterTitle}（${index + 1}/${batchPlan.length}）`;
    const batchText = batchPlan[index].text;
    const batchSceneCount = batchPlan[index].sceneCount || 1;
    const startOffset = batchPlan[index].startOffset ?? 0;
    const endOffset = batchPlan[index].endOffset ?? chapterText.length;
    const contextualText = formatBatchTextWithContext({
      chapterText,
      startOffset,
      endOffset,
      isLongChapter,
      maxLongChapterTotal: 5000
    });

    onProgressLog?.(`[LLM] 章节「${chapterTitle}」拆分提炼第 ${index + 1}/${batchPlan.length} 批，切片 ${batchText.length} 字，附带上下文总计发送 ${contextualText.length} 字，提炼 ${batchSceneCount} 个场景...`);
    const batchInfo = {
      batchIndex: index,
      totalBatches: batchPlan.length,
      requestedSceneCount: batchSceneCount,
      chapterTitle: batchTitle,
      sourceText: batchText,
      contextualText
    };
    try {
      const batchScenes = await sceneExtractor.extractChapterScenes(
        batchTitle,
        contextualText,
        model,
        onProgressLog,
        batchSceneCount,
        {
          ...sceneCountOptions,
          targetSlice: batchText,
          contextualText
        }
      );
      await onBatchExtracted?.(batchScenes, batchInfo);
      mergedScenes.push(...batchScenes);
    } catch (error) {
      const isAborted = shouldAbort?.() || signal?.aborted || error?.name === 'AbortError' || /abort/i.test(error?.message || '');
      if (isAborted) {
        onProgressLog?.(`[LLM] 章节「${chapterTitle}」提炼已中断（用户暂停）。`);
        break;
      }
      const failureMessage = `章节「${chapterTitle}」第 ${index + 1}/${batchPlan.length} 段提炼失败：${error.message}`;
      onProgressLog?.(`[LLM] ${failureMessage}；已记录该段，继续处理其余分段。`, 'error');
      await onBatchFailed?.(error, batchInfo);
    }
  }

  return mergedScenes.map((scene, index) => ({
    ...scene,
    scene_idx: index + 1
  }));
}
