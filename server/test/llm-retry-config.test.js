import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LLM_429_MAX_RETRIES,
  DEFAULT_LLM_MAX_RETRIES,
  LLM_429_MAX_RETRIES_CEILING,
  LLM_MAX_RETRIES_CEILING,
  clampLlmRetries,
  resolveLlmRetryLimits
} from '../utils/llm-retry.js';
import { LLMExtractor } from '../services/llm-extractor.js';
import { ComicTextGenerator } from '../services/comic-text-generator.js';

test('resolveLlmRetryLimits 缺省值', () => {
  const limits = resolveLlmRetryLimits({});
  assert.equal(limits.maxRetries, DEFAULT_LLM_MAX_RETRIES);
  assert.equal(limits.max429Retries, DEFAULT_LLM_429_MAX_RETRIES);
  assert.equal(limits.maxRetries, 3);
  assert.equal(limits.max429Retries, 5);
  assert.deepEqual(resolveLlmRetryLimits(), resolveLlmRetryLimits({}));
});

test('resolveLlmRetryLimits 读取配置并夹到区间内', () => {
  assert.deepEqual(resolveLlmRetryLimits({ llm_max_retries: 6, llm_429_max_retries: 2 }), { maxRetries: 6, max429Retries: 2 });

  // 业务重试至少 1 次
  assert.equal(resolveLlmRetryLimits({ llm_max_retries: 0 }).maxRetries, 1);
  assert.equal(resolveLlmRetryLimits({ llm_max_retries: -5 }).maxRetries, 1);
  // 上限防手滑
  assert.equal(resolveLlmRetryLimits({ llm_max_retries: 999 }).maxRetries, LLM_MAX_RETRIES_CEILING);
  assert.equal(resolveLlmRetryLimits({ llm_429_max_retries: 999 }).max429Retries, LLM_429_MAX_RETRIES_CEILING);

  // 429 允许 0（完全不重试）
  assert.equal(resolveLlmRetryLimits({ llm_429_max_retries: 0 }).max429Retries, 0);
  assert.equal(resolveLlmRetryLimits({ llm_429_max_retries: -1 }).max429Retries, 0);
});

test('非数字 / 空值回落到默认值', () => {
  for (const value of ['', null, undefined, 'abc', {}, []]) {
    assert.equal(resolveLlmRetryLimits({ llm_max_retries: value }).maxRetries, DEFAULT_LLM_MAX_RETRIES, `maxRetries 应回落: ${JSON.stringify(value)}`);
  }
  assert.equal(resolveLlmRetryLimits({ llm_429_max_retries: 'x' }).max429Retries, DEFAULT_LLM_429_MAX_RETRIES);
});

test('clampLlmRetries 取整并夹紧', () => {
  assert.equal(clampLlmRetries('4.9'), 4);
  assert.equal(clampLlmRetries(0, 3, 1, 10), 1);
  assert.equal(clampLlmRetries(50, 3, 1, 10), 10);
  assert.equal(clampLlmRetries(undefined, 3), 3);
});

test('LLMExtractor 构造参数接管重试次数', () => {
  const extractor = new LLMExtractor({ maxRetries: 7, max429Retries: 1 });
  assert.equal(extractor.maxRetries, 7);
  assert.equal(extractor.max429Retries, 1);

  const fallback = new LLMExtractor({});
  assert.equal(fallback.maxRetries, DEFAULT_LLM_MAX_RETRIES);
  assert.equal(fallback.max429Retries, DEFAULT_LLM_429_MAX_RETRIES);

  // 越界值必须被夹住，不能把上游拖死
  assert.equal(new LLMExtractor({ maxRetries: 0 }).maxRetries, 1);
  assert.equal(new LLMExtractor({ max429Retries: 999 }).max429Retries, LLM_429_MAX_RETRIES_CEILING);
});

test('comic storyboard 按配置次数重试', async () => {
  const generator = new ComicTextGenerator();
  let calls = 0;
  generator.request = async () => { calls += 1; throw new Error('boom'); };

  await assert.rejects(
    () => generator.storyboard({
      pipeline: { config: { llm_max_retries: 5 }, projectProgress: { getGlobalCharacters: () => ({}) } },
      chapterKey: 'c1', source: 'src', title: 't', language: 'chinese',
      initialState: {}, count: 1, previous: [], instructions: '', validate: () => {}
    }),
    /分镜草稿未通过校验/
  );
  assert.equal(calls, 5, '应严格按 llm_max_retries 重试');
});

test('comic prompt 按配置次数重试，默认 3 次', async () => {
  const plan = { characterNames: ['甲'], storyboardDescription: 'scene' };
  const dna = { 甲: { tags: 'silver_hair' } };

  const run = async (config, expected) => {
    const generator = new ComicTextGenerator();
    let calls = 0;
    generator.request = async () => { calls += 1; throw new Error('boom'); };
    await assert.rejects(
      () => generator.prompt({ pipeline: { config }, plan, dna, entryState: {}, validate: () => {} }),
      /提示词生成未通过校验/
    );
    assert.equal(calls, expected);
  };

  await run({}, DEFAULT_LLM_MAX_RETRIES);
  await run({ llm_max_retries: 2 }, 2);
  await run({ llm_max_retries: 6 }, 6);
});
