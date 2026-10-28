import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineManager } from '../services/pipeline-manager.js';
import { ProjectProgress } from '../utils/db.js';

function makePipelineStub({ prepareImpl = null } = {}) {
  const pipeline = Object.create(PipelineManager.prototype);
  pipeline.isRunning = true;
  pipeline.projBase = process.cwd();
  pipeline.logs = [];
  pipeline.writeLog = (text) => pipeline.logs.push(String(text));
  pipeline.markSceneProcessing = () => {};
  pipeline.clearSceneProcessing = () => {};
  pipeline.uiProgressCallback = null;
  pipeline.projectProgress = {
    saved: 0,
    setChapterStatus() {},
    async save() { this.saved += 1; }
  };
  pipeline.calls = { prepare: 0 };
  pipeline.prepareSingleScenePrompt = async () => {
    pipeline.calls.prepare += 1;
    if (prepareImpl) return prepareImpl(pipeline.calls.prepare);
    return true;
  };
  return pipeline;
}

test('_recordSceneFailure 写入阶段、原因、次数与时间', () => {
  const pipeline = makePipelineStub();
  const scene = { scene_idx: 7 };

  pipeline._recordSceneFailure(scene, 'nai', new Error('NAI 429 rate limited'), 3);

  assert.equal(scene.status, 'FAILED');
  assert.equal(scene.failure.phase, 'nai');
  assert.equal(scene.failure.message, 'NAI 429 rate limited');
  assert.equal(scene.failure.attempts, 3);
  assert.match(scene.failure.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('_recordSceneFailure 对超长报错截断到 600 字并容错非 Error 输入', () => {
  const pipeline = makePipelineStub();
  const scene = {};

  pipeline._recordSceneFailure(scene, 'llm', 'x'.repeat(2000));
  assert.equal(scene.failure.message.length, 600);

  const scene2 = {};
  pipeline._recordSceneFailure(scene2, 'scene', undefined);
  assert.equal(scene2.failure.message, '未知错误');

  pipeline._recordSceneFailure(null, 'llm', new Error('noop'));
});

test('失败记录随 scenes 落盘，可在下次补完时读回', () => {
  const progress = new ProjectProgress(os.tmpdir());
  progress.data = { completed_chapters: {} };
  const scenes = [{ scene_idx: 5, status: 'FAILED', failure: { phase: 'nai', message: 'timeout', attempts: 3, at: '2026-01-01T00:00:00.000Z' } }];

  progress.setChapterStatus('v1#c1', 'generating', scenes);
  const saved = progress.getCompletedChapters()['v1#c1'];

  assert.equal(saved.scenes[0].status, 'FAILED');
  assert.equal(saved.scenes[0].failure.phase, 'nai');
  assert.equal(saved.scenes[0].failure.message, 'timeout');
});

test('上次 NAI 失败时补完直接复用已有 Prompt 重试出图，不重跑 LLM', async () => {
  const pipeline = makePipelineStub();
  const scene = {
    scene_idx: 3,
    status: 'FAILED',
    failure: { phase: 'nai', message: 'upstream 500', attempts: 3, at: '2026-01-01T00:00:00.000Z' },
    prepared_prompt: { finalPositive: 'masterpiece, 1girl', finalNegative: 'lowres' }
  };
  const scenes = [scene];
  const naiQueue = [];

  await pipeline._prepareSceneForNaiQueue({ chapter: '第一章' }, scene, scenes, 'v1#c1', 'model', naiQueue);

  assert.equal(pipeline.calls.prepare, 0, '不应重新调用 LLM 生成 Prompt');
  assert.equal(naiQueue.length, 1, '应直接推入 NAI 队列重试');
  assert.equal(scene.status, 'PROMPT_READY');
  assert.equal(scene.failure.phase, 'nai', '失败记录保留到出图成功后再清除');
  assert.ok(pipeline.logs.some(l => l.includes('复用现有 Prompt 重试出图')));
});

test('上次 LLM 阶段失败时补完会重新跑 Prompt 生成', async () => {
  const pipeline = makePipelineStub();
  const scene = {
    scene_idx: 4,
    status: 'FAILED',
    failure: { phase: 'llm', message: '缺少非空 base_prompt', attempts: 3, at: '2026-01-01T00:00:00.000Z' }
  };
  const scenes = [scene];
  const naiQueue = [];

  await pipeline._prepareSceneForNaiQueue({ chapter: '第一章' }, scene, scenes, 'v1#c1', 'model', naiQueue);

  assert.equal(pipeline.calls.prepare, 1, '应重新调用 LLM');
  assert.equal(scene.status, 'FAILED');
  assert.equal(naiQueue.length, 1, '成功准备后应入队');
  assert.equal(scene.failure, undefined, '成功后必须清除失败记录');
});

test('Prompt 生成连续失败 3 次会写入 llm 阶段失败记录并跳过', async () => {
  const pipeline = makePipelineStub({
    prepareImpl: () => { throw new Error('缺少非空 base_prompt'); }
  });
  const scene = { scene_idx: 8, status: 'PENDING' };
  const scenes = [scene];
  const naiQueue = [];

  await pipeline._prepareSceneForNaiQueue({ chapter: '第一章' }, scene, scenes, 'v1#c1', 'model', naiQueue);

  assert.equal(pipeline.calls.prepare, 3, '必须重试满 3 次');
  assert.equal(scene.status, 'FAILED');
  assert.equal(scene.failure.phase, 'llm');
  assert.equal(scene.failure.message, '缺少非空 base_prompt');
  assert.equal(naiQueue.length, 0, '失败场景不入队');
  assert.ok(pipeline.logs.some(l => l.includes('连续 3 次失败')));
});

test('已出图成功的场景补完时直接跳过，不重试也不入队', async () => {
  const pipeline = makePipelineStub();
  // image_path 是相对 projBase 拼的，所以把 projBase 指向本测试目录、用测试文件名冒充产物，
  // 不再依赖仓库根目录里是否存在某个文件（旧写法拿 package.json 当探针，根目录根本没这个文件）。
  const selfPath = fileURLToPath(import.meta.url);
  pipeline.projBase = path.dirname(selfPath);
  const existing = path.basename(selfPath);
  const scene = { scene_idx: 1, status: 'SUCCESS', image_path: existing, failure: undefined };
  const naiQueue = [];

  await pipeline._prepareSceneForNaiQueue({ chapter: '第一章' }, scene, [scene], 'v1#c1', 'model', naiQueue);

  assert.equal(pipeline.calls.prepare, 0);
  assert.equal(naiQueue.length, 0);
});

test('NAI 阶段失败但 Prompt 未就绪时不走复用分支', async () => {
  const pipeline = makePipelineStub();
  const scene = {
    scene_idx: 9,
    status: 'FAILED',
    failure: { phase: 'nai', message: 'boom', attempts: 3, at: '2026-01-01T00:00:00.000Z' }
  };
  const naiQueue = [];

  await pipeline._prepareSceneForNaiQueue({ chapter: '第一章' }, scene, [scene], 'v1#c1', 'model', naiQueue);

  assert.equal(pipeline.calls.prepare, 1, 'Prompt 缺失时必须重新生成');
  assert.equal(naiQueue.length, 1);
});
