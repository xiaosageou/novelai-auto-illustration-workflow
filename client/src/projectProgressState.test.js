import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeProjectProgressSnapshot } from './projectProgressState.js';

test('mergeProjectProgressSnapshot applies SSE fullProgress immediately to visible chapter scenes', () => {
  const projectDetails = {
    chapters: [{ volume: '卷一', chapter: '第一章' }],
    progress: {
      completed_chapters: {}
    }
  };

  const next = mergeProjectProgressSnapshot(projectDetails, {
    completed_chapters: {
      卷一_第一章: {
        status: 'generating',
        scenes: [
          { scene_idx: 1, trigger_sentence: '她抬头', visual_description: '场景一', status: 'PENDING' }
        ]
      }
    }
  });

  assert.equal(next.progress.completed_chapters['卷一_第一章'].scenes.length, 1);
  assert.equal(next.progress.completed_chapters['卷一_第一章'].scenes[0].trigger_sentence, '她抬头');
});
