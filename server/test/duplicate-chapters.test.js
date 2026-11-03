import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineManager } from '../services/pipeline-manager.js';
import { ProjectProgress } from '../utils/db.js';

function makePipeline(chapters) {
  const pm = Object.create(PipelineManager.prototype);
  pm.chapters = chapters;
  pm.projectProgress = {
    getCompletedChapters: () => ({}),
    resolveChapterKey: null
  };
  pm.assignChapterKeys();
  return pm;
}

test('同名同卷章节分配唯一 chapterKey，首个保持无后缀', () => {
  const pm = makePipeline([
    { volume: '第一卷', chapter: '第18章' },
    { volume: '第一卷', chapter: '第19章' },
    { volume: '第一卷', chapter: '第19章' },
    { volume: '第二卷', chapter: '第19章' }
  ]);

  assert.deepEqual(pm.chapters.map(c => c.chapterKey), [
    '第一卷_第18章',
    '第一卷_第19章',
    '第一卷_第19章#2',
    '第二卷_第19章'
  ]);
  assert.deepEqual(pm.chapters.map(c => c.ordinal), [0, 1, 2, 3]);

  const keys = pm.chapters.map(c => c.chapterKey);
  assert.equal(new Set(keys).size, keys.length, 'chapterKey 必须全局唯一');
});

test('resolveChapterKey 与 assignChapterKeys 结果一致，且兼容旧无后缀 key', () => {
  const pm = makePipeline([
    { volume: '第一卷', chapter: '第19章' },
    { volume: '第一卷', chapter: '第19章' }
  ]);
  const resolve = pm.projectProgress.resolveChapterKey;

  assert.equal(resolve('第一卷', '第19章', 0), '第一卷_第19章', '首个同名章沿用旧 key，历史进度不丢');
  assert.equal(resolve('第一卷', '第19章', 1), '第一卷_第19章#1');
  assert.equal(resolve('第一卷', '第20章', 2), '第一卷_第20章');
});

test('ProjectProgress.getEffectiveChapKey 传入 ordinal 后能区分重名章节', () => {
  const pp = Object.create(ProjectProgress.prototype);
  pp.data = { completed_chapters: {} };
  pp.resolveChapterKey = (volume, chapter, ordinal) => (
    Number.isInteger(ordinal) && ordinal > 0 ? `${volume}_${chapter}#${ordinal}` : `${volume}_${chapter}`
  );

  assert.equal(pp.getEffectiveChapKey('第一卷', '第19章', 0), '第一卷_第19章');
  assert.equal(pp.getEffectiveChapKey('第一卷', '第19章', 1), '第一卷_第19章#1');
  assert.equal(pp.getEffectiveChapKey('第一卷', '第19章'), '第一卷_第19章', '未传 ordinal 时保持旧行为');
});
