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

  assert.ok(calls.length >= 2);
  assert.equal(calls.reduce((sum, call) => sum + call.requestedSceneCount, 0), 4);
  assert.ok(calls.some(call => call.text.includes('前段内容')));
  assert.ok(calls.some(call => call.text.includes('后段内容')));
  assert.deepEqual(scenes.map(scene => scene.scene_idx), [1, 2, 3, 4]);
  assert.match(scenes[0].trigger_sentence, /测试章（1\/\d+）-scene-1/);
  assert.match(scenes[3].trigger_sentence, /测试章（\d+\/\d+）-scene-\d+/);
});

test('extractChapterScenesInBatches keeps each request at or below ten scenes', async () => {
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

  const text = [
    '甲'.repeat(2400),
    '乙'.repeat(2400),
    '丙'.repeat(2400),
    '丁'.repeat(2400)
  ].join('\n\n');

  const scenes = await extractChapterScenesInBatches({
    chapterTitle: '超长测试章',
    text,
    model: 'test-model',
    sceneExtractor,
    requestedSceneCount: 25,
    splitThreshold: 1000
  });

  assert.ok(calls.length >= 3);
  assert.ok(calls.every(call => call.requestedSceneCount <= 10), JSON.stringify(calls));
  assert.equal(calls.reduce((sum, call) => sum + call.requestedSceneCount, 0), 25);
  assert.deepEqual(scenes.map(scene => scene.scene_idx), Array.from({ length: 25 }, (_value, index) => index + 1));
});

test('extractChapterScenesInBatches still splits when scene count exceeds ten but text is below the size threshold', async () => {
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

  const text = `${'前段'.repeat(1000)}\n\n${'后段'.repeat(995)}`;
  const scenes = await extractChapterScenesInBatches({
    chapterTitle: '场景数强拆测试章',
    text,
    model: 'test-model',
    sceneExtractor,
    requestedSceneCount: 20,
    splitThreshold: 10000
  });

  assert.ok(calls.length >= 2, JSON.stringify(calls));
  assert.ok(calls.every(call => call.requestedSceneCount <= 10), JSON.stringify(calls));
  assert.equal(calls.reduce((sum, call) => sum + call.requestedSceneCount, 0), 20);
  assert.deepEqual(scenes.map(scene => scene.scene_idx), Array.from({ length: 20 }, (_value, index) => index + 1));
});

test('extractChapterScenesInBatches records one failed batch and continues with later batches', async () => {
  const calls = [];
  const failures = [];
  const extracted = [];
  let firstCall = true;
  const sceneExtractor = {
    async extractChapterScenes(chapterTitle, text, _model, _onProgressLog, requestedSceneCount) {
      calls.push(chapterTitle);
      if (firstCall) {
        firstCall = false;
        throw new Error('temporary provider error');
      }
      return Array.from({ length: requestedSceneCount }, (_value, index) => ({
        scene_idx: index + 1,
        trigger_sentence: `${chapterTitle}-scene-${index + 1}`,
        visual_description: text.slice(0, 8)
      }));
    }
  };
  const text = `${'前段内容'.repeat(300)}\n\n${'后段内容'.repeat(300)}`;

  const scenes = await extractChapterScenesInBatches({
    chapterTitle: '失败隔离测试章',
    text,
    model: 'test-model',
    sceneExtractor,
    requestedSceneCount: 4,
    splitThreshold: 1000,
    onBatchExtracted: (_scenes, info) => extracted.push(info.batchIndex),
    onBatchFailed: (error, info) => failures.push({ error, info })
  });

  assert.ok(calls.length >= 2);
  assert.ok(extracted.length >= 1);
  assert.ok(extracted.every(index => index > 0));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].info.batchIndex, 0);
  assert.match(failures[0].info.sourceText, /前段内容/);
  assert.ok(scenes.length > 0);
  assert.deepEqual(scenes.map(scene => scene.scene_idx), Array.from({ length: scenes.length }, (_value, index) => index + 1));
});
