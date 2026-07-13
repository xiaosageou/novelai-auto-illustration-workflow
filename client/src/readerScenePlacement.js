function normalizeReaderText(value) {
  return String(value || '')
    .replace(/[\s\u200B\uFEFF]+/g, '')
    .replace(/[“”"'‘’]/g, '')
    .trim();
}

function findSceneParagraphIndex(scene, paragraphs) {
  const rawSourceIndex = scene?.source_paragraph_index;
  const sourceIndex = Number(rawSourceIndex);
  if (rawSourceIndex !== null && rawSourceIndex !== undefined && rawSourceIndex !== ''
    && Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < paragraphs.length) {
    return sourceIndex;
  }

  const sourceParagraph = normalizeReaderText(scene?.source_paragraph);
  if (sourceParagraph) {
    const sourceMatch = paragraphs.findIndex(paragraph => {
      const normalizedParagraph = normalizeReaderText(paragraph);
      return normalizedParagraph === sourceParagraph
        || normalizedParagraph.includes(sourceParagraph)
        || sourceParagraph.includes(normalizedParagraph);
    });
    if (sourceMatch >= 0) return sourceMatch;
  }

  const trigger = normalizeReaderText(scene?.trigger_sentence);
  if (trigger) {
    const triggerMatch = paragraphs.findIndex(paragraph => normalizeReaderText(paragraph).includes(trigger));
    if (triggerMatch >= 0) return triggerMatch;
  }

  // 不因 LLM 改写/截断触发句而漏图；无法定位时统一放在章节末尾。
  return Math.max(0, paragraphs.length - 1);
}

export function placeReaderScenesByParagraph(paragraphs = [], scenes = []) {
  const placements = Array.from({ length: paragraphs.length }, () => []);
  if (paragraphs.length === 0) return placements;

  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (scene?.status !== 'SUCCESS' || !scene?.image_path) continue;
    placements[findSceneParagraphIndex(scene, paragraphs)].push(scene);
  }

  return placements;
}
