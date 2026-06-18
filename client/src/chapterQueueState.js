export function isSingleChapterGenerateDisabled({ chapterQueueState } = {}) {
  return chapterQueueState === 'queued' || chapterQueueState === 'running';
}
