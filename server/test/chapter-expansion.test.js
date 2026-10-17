import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { PipelineManager } from '../services/pipeline-manager.js';

test('_checkChapterExpansion returns false when chapter is new or has no scenes', () => {
  const manager = new PipelineManager({ projectName: 'test-project' });
  const chap = { volume: '第一卷', chapter: '第一章', content: '这是一段很长的小说正文内容。'.repeat(50) };
  
  assert.equal(manager._checkChapterExpansion(chap, null).isExpanded, false);
  assert.equal(manager._checkChapterExpansion(chap, { status: 'pending', scenes: [] }).isExpanded, false);
});

test('_checkChapterExpansion returns false when content_hash matches exactly', () => {
  const manager = new PipelineManager({ projectName: 'test-project' });
  const content = '正文第一段。' + '后续剧情文字。'.repeat(100);
  const hash = crypto.createHash('sha256').update(content.trim()).digest('hex');
  const chap = { volume: '第一卷', chapter: '第一章', content };
  const currentProgress = {
    status: 'completed',
    content_hash: hash,
    content_length: content.length,
    scenes: [
      { scene_idx: 1, trigger_sentence: '正文第一段。', status: 'SUCCESS' }
    ]
  };

  const result = manager._checkChapterExpansion(chap, currentProgress);
  assert.equal(result.isExpanded, false);
});

test('_checkChapterExpansion detects expansion when legacy JSON has no hash and large tail text exists', () => {
  const manager = new PipelineManager({
    projectName: 'test-project',
    cjk_scene_divisor: 600
  });

  const part1 = '这是原本的第一章开头。\n' + '这里是中间剧情发展。'.repeat(60) + '\n这是第一章原来的结尾句。';
  const expansionPart = '\n【扩充内容开始】' + '这是后来补全的大量剧情文本。'.repeat(120);
  const fullContent = part1 + expansionPart;

  const chap = { volume: '第一卷', chapter: '第一章', content: fullContent };
  const currentProgress = {
    status: 'completed',
    scenes: [
      { scene_idx: 1, trigger_sentence: '这是原本的第一章开头。', status: 'SUCCESS' },
      { scene_idx: 2, trigger_sentence: '这是第一章原来的结尾句。', status: 'SUCCESS' }
    ]
  };

  const result = manager._checkChapterExpansion(chap, currentProgress);
  assert.equal(result.isExpanded, true);
  assert.ok(result.extraChars >= 1000);
  assert.ok(result.newText.includes('【扩充内容开始】'));
});

test('_checkChapterExpansion ignores minor edits below threshold in legacy JSON', () => {
  const manager = new PipelineManager({
    projectName: 'test-project',
    cjk_scene_divisor: 600
  });

  const content = '第一章开头。\n' + '剧情内容。'.repeat(80) + '\n第一章结尾。' + ' 稍作润色修改。';
  const chap = { volume: '第一卷', chapter: '第一章', content };
  const currentProgress = {
    status: 'completed',
    scenes: [
      { scene_idx: 1, trigger_sentence: '第一章开头。', status: 'SUCCESS' },
      { scene_idx: 2, trigger_sentence: '第一章结尾。', status: 'SUCCESS' }
    ]
  };

  const result = manager._checkChapterExpansion(chap, currentProgress);
  assert.equal(result.isExpanded, false);
});

test('_extractExpansionScenesIncrementally appends new scenes preserving existing ones and sequence', async () => {
  const manager = new PipelineManager({
    projectName: 'test-project',
    cjk_scene_divisor: 600
  });

  const persisted = [];
  manager._persistChapterScenes = async (chap, chapKey, scenes) => {
    persisted.push({ chapKey, scenesCount: scenes.length, scenes: [...scenes] });
  };
  manager._recordSceneExtractionBatchFailure = async () => {};

  manager.sceneExtractor = {
    async extractChapterScenes(chapterTitle, text, model, onProgressLog, requestedSceneCount) {
      return Array.from({ length: requestedSceneCount }, (_, i) => ({
        scene_idx: i + 1,
        trigger_sentence: `扩充触发句_${i + 1}`,
        visual_description: `扩充描述_${i + 1}`
      }));
    }
  };

  const existingScenes = [
    { scene_idx: 1, trigger_sentence: '原始句1', visual_description: '原始描述1', status: 'SUCCESS', image_path: 'illustrations/scene_1.png' },
    { scene_idx: 2, trigger_sentence: '原始句2', visual_description: '原始描述2', status: 'SUCCESS', image_path: 'illustrations/scene_2.png' }
  ];

  const chap = {
    volume: '第一卷',
    chapter: '第一章',
    content: '原始正文\n' + '新扩充文本段落。'.repeat(100)
  };

  const newText = '新扩充文本段落。'.repeat(100);
  const newScenes = await manager._extractExpansionScenesIncrementally(
    chap,
    '第一卷_第一章',
    newText,
    existingScenes,
    'test-model',
    '[Test]'
  );

  assert.ok(newScenes.length >= 1);
  assert.equal(newScenes[0].scene_idx, 3);
  assert.equal(newScenes[0].status, 'PENDING');

  assert.ok(persisted.length >= 1);
  const lastSave = persisted[persisted.length - 1];
  assert.equal(lastSave.scenesCount, existingScenes.length + newScenes.length);
  assert.equal(lastSave.scenes[0].scene_idx, 1);
  assert.equal(lastSave.scenes[0].image_path, 'illustrations/scene_1.png');
  assert.equal(lastSave.scenes[1].scene_idx, 2);
  assert.equal(lastSave.scenes[2].scene_idx, 3);
});
