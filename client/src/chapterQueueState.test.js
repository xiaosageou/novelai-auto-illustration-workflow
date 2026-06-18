import test from 'node:test';
import assert from 'node:assert/strict';

import { isSingleChapterGenerateDisabled } from './chapterQueueState.js';

test('single chapter generation stays clickable while the main pipeline is running', () => {
  assert.equal(isSingleChapterGenerateDisabled({ pipelineRunning: true, chapterQueueState: undefined }), false);
});

test('single chapter generation is disabled while the selected chapter is queued or running', () => {
  assert.equal(isSingleChapterGenerateDisabled({ pipelineRunning: false, chapterQueueState: 'queued' }), true);
  assert.equal(isSingleChapterGenerateDisabled({ pipelineRunning: false, chapterQueueState: 'running' }), true);
});
