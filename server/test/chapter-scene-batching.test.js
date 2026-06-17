import test from 'node:test';
import assert from 'node:assert/strict';

import { extractChapterScenesInBatches, splitChapterTextIntoBatches } from '../utils/chapter-scene-batching.js';

test('splitChapterTextIntoBatches splits long chapters on paragraph boundaries', () => {
  const text = `${'甲'.repeat(60)}\n\n${'乙'.repeat(60)}`;

  const batches = splitChapterTextIntoBatches(text, 100);

  assert.equal(batches.length, 2);
  assert.equal(batches[0], '甲'.repeat(60));
  assert.equal(batches[1], '乙'.repeat(60));
});

test('extractChapterScenesInBatches extracts long chapters in two passes and keeps scene order', async () => {
  const calls = [];
  const sceneExtractor = {
    async extractChapterScenes(chapterTitle, text, model, onProgressLog, requestedSceneCount) {
      calls.push({ chapterTitle, text, model, requestedSceneCount });
      return Array.from({ length: requestedSceneCount }, (_value, index) => ({
        scene_idx: index + 1,
        trigger_sentence: `${chapterTitle}-scene-${index + 1}`,
        visual_description: `${text.slice(0, 8)}-${index + 1}`
      }));
    }
  };

  const text = `${'前段内容'.repeat(300)}\n\n${'后段内容'.repeat(300)}`;
  const scenes = await extractChapterScenesInBatches({
    chapterTitle: '测试章',
    text,
    model: 'test-model',
    sceneExtractor,
    requestedSceneCount: 4,
    splitThreshold: 1000
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].chapterTitle, /测试章（1\/2）$/);
  assert.match(calls[1].chapterTitle, /测试章（2\/2）$/);
  assert.equal(calls[0].requestedSceneCount + calls[1].requestedSceneCount, 4);
  assert.ok(calls[0].text.includes('前段内容'));
  assert.ok(!calls[0].text.includes('后段内容'));
  assert.ok(calls[1].text.includes('后段内容'));
  assert.ok(!calls[1].text.includes('前段内容'));
  assert.deepEqual(scenes.map(scene => scene.scene_idx), [1, 2, 3, 4]);
  assert.match(scenes[0].trigger_sentence, /测试章（1\/2）-scene-1/);
  assert.match(scenes[3].trigger_sentence, /测试章（2\/2）-scene-2/);
});
