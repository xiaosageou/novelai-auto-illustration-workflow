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

function buildBatchPlan(text, sceneCount, { splitThreshold = 10000, maxScenesPerRequest = 10 } = {}) {
  const normalized = normalizeTextBlock(text);
  if (!normalized) return [];

  const numericSceneCount = Number.isInteger(sceneCount) && sceneCount > 0 ? sceneCount : 1;
  const shouldSplitBySceneCount = numericSceneCount > maxScenesPerRequest;
  const shouldSplitByLength = normalized.length > splitThreshold;

  if (!shouldSplitBySceneCount && !shouldSplitByLength) {
    return [{ text: normalized, sceneCount: numericSceneCount }];
  }

  const splitBatches = splitChapterTextIntoBatches(normalized, splitThreshold);
  if (splitBatches.length <= 1) {
    return [{ text: normalized, sceneCount: numericSceneCount }];
  }

  const childSceneCounts = allocateSceneCounts(numericSceneCount, splitBatches);
  return splitBatches.flatMap((batchText, index) => {
    const childSceneCount = childSceneCounts[index] || 1;
    return buildBatchPlan(batchText, childSceneCount, { splitThreshold, maxScenesPerRequest });
  });
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
  requestedSceneCount = null,
  sceneCountOptions = {},
  maxScenesPerRequest = 10,
  splitThreshold = 10000
}) {
  const chapterText = normalizeTextBlock(text);
  if (!chapterText) {
    return [];
  }

  const sceneCount = Number.isInteger(requestedSceneCount) && requestedSceneCount > 0
    ? requestedSceneCount
    : null;
  const batchPlan = sceneCount
    ? buildBatchPlan(chapterText, sceneCount, { splitThreshold, maxScenesPerRequest })
    : [{ text: chapterText, sceneCount: null }];

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
    const batchTitle = `${chapterTitle}（${index + 1}/${batchPlan.length}）`;
    const batchText = batchPlan[index].text;
    const batchSceneCount = batchPlan[index].sceneCount || 1;
    onProgressLog?.(`[LLM] 章节「${chapterTitle}」拆分提炼第 ${index + 1}/${batchPlan.length} 段，发送 ${batchText.length} 字，提炼 ${batchSceneCount} 个场景...`);
    const batchScenes = await sceneExtractor.extractChapterScenes(
      batchTitle,
      batchText,
      model,
      onProgressLog,
      batchSceneCount,
      sceneCountOptions
    );
    await onBatchExtracted?.(batchScenes, {
      batchIndex: index,
      totalBatches: batchPlan.length,
      requestedSceneCount: batchSceneCount,
      chapterTitle: batchTitle
    });
    mergedScenes.push(...batchScenes);
  }

  return mergedScenes.map((scene, index) => ({
    ...scene,
    scene_idx: index + 1
  }));
}
