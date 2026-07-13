import test from 'node:test';
import assert from 'node:assert/strict';

import { placeReaderScenesByParagraph } from '../src/readerScenePlacement.js';

test('reader placement retains every successful illustration when trigger text is rewritten', () => {
  const paragraphs = ['第一段，角色进入房间。', '第二段，故事继续发展。'];
  const placements = placeReaderScenesByParagraph(paragraphs, [
    { scene_idx: 1, status: 'SUCCESS', image_path: 'illustrations/1.png', source_paragraph_index: 0 },
    { scene_idx: 2, status: 'SUCCESS', image_path: 'illustrations/2.png', trigger_sentence: '第二段故事继续发展' },
    { scene_idx: 3, status: 'SUCCESS', image_path: 'illustrations/3.png', trigger_sentence: '完全不在正文中的改写句' }
  ]);

  assert.deepEqual(placements.map(items => items.map(scene => scene.scene_idx)), [[1], [2, 3]]);
});
