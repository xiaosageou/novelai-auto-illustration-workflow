import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractChapterScenesInBatches,
  splitChapterTextIntoBatches,
  formatBatchTextWithContext,
  extractTargetSliceFromContext,
  TARGET_SLICE_START,
  TARGET_SLICE_END,
  PRECEDING_CONTEXT_START,
  PRECEDING_CONTEXT_END,
  FOLLOWING_CONTEXT_START,
  FOLLOWING_CONTEXT_END
} from '../utils/chapter-scene-batching.js';

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

test('extractChapterScenesInBatches keeps each request at or below five scenes', async () => {
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
  assert.ok(calls.every(call => call.requestedSceneCount <= 5), JSON.stringify(calls));
  assert.equal(calls.reduce((sum, call) => sum + call.requestedSceneCount, 0), 25);
  assert.deepEqual(scenes.map(scene => scene.scene_idx), Array.from({ length: 25 }, (_value, index) => index + 1));
});

test('extractChapterScenesInBatches still splits when scene count exceeds five but text is below the size threshold', async () => {
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
  assert.ok(calls.every(call => call.requestedSceneCount <= 5), JSON.stringify(calls));
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

test('formatBatchTextWithContext sends full chapter with target slice marker when chapter <= 10000', () => {
  const chapterText = '前文背景设定。\n\n主角拔剑出鞘。\n\n后文收尾伏笔。';
  const startOffset = chapterText.indexOf('主角拔剑出鞘。');
  const endOffset = startOffset + '主角拔剑出鞘。'.length;

  const result = formatBatchTextWithContext({
    chapterText,
    startOffset,
    endOffset,
    isLongChapter: false
  });

  assert.ok(result.includes(PRECEDING_CONTEXT_START));
  assert.ok(result.includes('前文背景设定。'));
  assert.ok(result.includes(TARGET_SLICE_START));
  assert.ok(result.includes('主角拔剑出鞘。'));
  assert.ok(result.includes(TARGET_SLICE_END));
  assert.ok(result.includes(FOLLOWING_CONTEXT_START));
  assert.ok(result.includes('后文收尾伏笔。'));
  assert.ok(result.includes(FOLLOWING_CONTEXT_END));

  const extracted = extractTargetSliceFromContext(result);
  assert.equal(extracted, '主角拔剑出鞘。');
});

test('formatBatchTextWithContext sends target slice plus preceding text under 5000 chars when chapter > 10000', () => {
  const preceding = '前'.repeat(4000);
  const slice = '中'.repeat(2500);
  const following = '后'.repeat(4000);
  const chapterText = `${preceding}\n\n${slice}\n\n${following}`;
  assert.ok(chapterText.length > 10000);

  const startOffset = chapterText.indexOf(slice);
  const endOffset = startOffset + slice.length;

  const result = formatBatchTextWithContext({
    chapterText,
    startOffset,
    endOffset,
    isLongChapter: true,
    maxLongChapterTotal: 5000
  });

  // 必须没有后序上下文
  assert.ok(!result.includes(FOLLOWING_CONTEXT_START));
  assert.ok(!result.includes('后'.repeat(100)));

  // 必须标出目标切片
  assert.ok(result.includes(TARGET_SLICE_START));
  assert.ok(result.includes(TARGET_SLICE_END));
  assert.equal(extractTargetSliceFromContext(result), slice);

  // 正文总字数（切片 + 前文）必须严格控制在 5000 字以内
  assert.ok(result.includes(PRECEDING_CONTEXT_START));
  const precedingMatch = result.match(new RegExp(`${PRECEDING_CONTEXT_START}\\s*([\\s\\S]*?)\\s*${PRECEDING_CONTEXT_END}`));
  assert.ok(precedingMatch);
  const precedingContent = precedingMatch[1].trim();
  assert.ok(precedingContent.length + slice.length <= 5000);
  assert.ok(precedingContent.length >= 2490 && precedingContent.length <= 2500);
});

test('extractChapterScenesInBatches sends full chapter context when chapter <= 10000 and splits due to scene count', async () => {
  const calls = [];
  const sceneExtractor = {
    async extractChapterScenes(chapterTitle, text, model, onProgressLog, requestedSceneCount, options) {
      calls.push({ chapterTitle, text, requestedSceneCount, options });
      return Array.from({ length: requestedSceneCount }, (_val, i) => ({
        scene_idx: i + 1,
        trigger_sentence: `scene-${i + 1}`
      }));
    }
  };

  const part1 = '甲'.repeat(2000);
  const part2 = '乙'.repeat(2000);
  const chapterText = `${part1}\n\n${part2}`;
  assert.ok(chapterText.length <= 10000);

  await extractChapterScenesInBatches({
    chapterTitle: '短章多批次测试',
    text: chapterText,
    model: 'test-model',
    sceneExtractor,
    requestedSceneCount: 8, // 超过 5，触发切分
    maxScenesPerRequest: 5
  });

  assert.equal(calls.length, 2);
  // 第一批发送全章：切片是甲，后置上下文是乙
  assert.ok(calls[0].text.includes(TARGET_SLICE_START));
  assert.ok(calls[0].text.includes(part1));
  assert.ok(calls[0].text.includes(FOLLOWING_CONTEXT_START));
  assert.ok(calls[0].text.includes(part2));
  assert.equal(calls[0].options.targetSlice, part1);

  // 第二批发送全章：前置上下文是甲，切片是乙
  assert.ok(calls[1].text.includes(PRECEDING_CONTEXT_START));
  assert.ok(calls[1].text.includes(part1));
  assert.ok(calls[1].text.includes(TARGET_SLICE_START));
  assert.ok(calls[1].text.includes(part2));
  assert.equal(calls[1].options.targetSlice, part2);
});

test('extractChapterScenesInBatches caps preceding context + slice under 5000 chars when chapter > 10000', async () => {
  const calls = [];
  const sceneExtractor = {
    async extractChapterScenes(chapterTitle, text, model, onProgressLog, requestedSceneCount, options) {
      calls.push({ chapterTitle, text, requestedSceneCount, options });
      return Array.from({ length: requestedSceneCount }, (_val, i) => ({
        scene_idx: i + 1,
        trigger_sentence: `scene-${i + 1}`
      }));
    }
  };

  const part1 = '一'.repeat(3000);
  const part2 = '二'.repeat(3000);
  const part3 = '三'.repeat(3000);
  const part4 = '四'.repeat(3000);
  const chapterText = `${part1}\n\n${part2}\n\n${part3}\n\n${part4}`;
  assert.ok(chapterText.length > 10000);

  await extractChapterScenesInBatches({
    chapterTitle: '超长章测试',
    text: chapterText,
    model: 'test-model',
    sceneExtractor,
    requestedSceneCount: 16,
    splitThreshold: 3500,
    maxScenesPerRequest: 5
  });

  assert.ok(calls.length >= 3);
  for (const call of calls) {
    // 超过1万字，绝不能包含后序参考上下文
    assert.ok(!call.text.includes(FOLLOWING_CONTEXT_START));
    assert.ok(call.text.includes(TARGET_SLICE_START));

    const slice = extractTargetSliceFromContext(call.text);
    assert.ok(slice.length > 0);

    const precedingMatch = call.text.match(new RegExp(`${PRECEDING_CONTEXT_START}\\s*([\\s\\S]*?)\\s*${PRECEDING_CONTEXT_END}`));
    const precedingLen = precedingMatch ? precedingMatch[1].trim().length : 0;
    assert.ok(precedingLen + slice.length <= 5000, `precedingLen (${precedingLen}) + sliceLen (${slice.length}) exceeded 5000`);
  }
});
