import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFinalImagePrompt } from '../services/prompt-builder.js';
import { NovelAIClient } from '../services/nai-client.js';
import { globalCooldownManager } from '../utils/cooldown.js';

test('buildFinalImagePrompt injects uncensored and anti-censor negative words for explicit NSFW scenes', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, nsfw, explicit, bedroom, sex', {
    sceneCharacters: [
      { name: '女主', gender: 'girl' },
      { name: '男主', gender: 'boy' }
    ],
    structuredCharacterPrompts: [
      { name: '女主', prompt: 'girl, blush, arched back', negative_prompt: '' },
      { name: '男主', prompt: 'boy, grabbing hips', negative_prompt: '' }
    ],
    sceneNsfwRating: 'nsfw_explicit',
    sceneDescription: '两人在床上发生亲密关系'
  });

  // 正向：必须包含 uncensored 标签
  assert.match(result.basePrompt, /\buncensored\b/i, 'basePrompt should contain uncensored');
  assert.match(result.finalPositive, /\buncensored\b/i, 'finalPositive should contain uncensored');

  // 负向：必须包含去码/防马赛克关键词
  assert.match(result.finalNegative, /\bcensored\b/i, 'finalNegative should contain censored');
  assert.match(result.finalNegative, /\bmosaic\b/i, 'finalNegative should contain mosaic');
  assert.match(result.finalNegative, /\bbar censor\b/i, 'finalNegative should contain bar censor');
});

test('buildFinalImagePrompt auto-adds nsfw, explicit, uncensored when sceneNsfwRating is explicit but prompt lacks them', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bedroom', {
    sceneCharacters: [
      { name: '女主', gender: 'girl' },
      { name: '男主', gender: 'boy' }
    ],
    structuredCharacterPrompts: [
      { name: '女主', prompt: 'girl', negative_prompt: '' },
      { name: '男主', prompt: 'boy', negative_prompt: '' }
    ],
    sceneNsfwRating: 'nsfw_explicit',
    sceneDescription: '男女主角在卧室行房'
  });

  assert.match(result.basePrompt, /\buncensored\b/i, 'basePrompt should auto-inject uncensored');
  assert.match(result.basePrompt, /\bexplicit\b/i, 'basePrompt should auto-inject explicit');
  assert.match(result.finalNegative, /\bmosaic\b/i, 'finalNegative should include mosaic for explicit scene');
});

test('buildFinalImagePrompt keeps SFW scene clean without uncensored or mosaic tags', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, park, walking, daytime', {
    sceneCharacters: [
      { name: '女主', gender: 'girl' },
      { name: '男主', gender: 'boy' }
    ],
    structuredCharacterPrompts: [
      { name: '女主', prompt: 'girl, smiling', negative_prompt: '' },
      { name: '男主', prompt: 'boy, looking forward', negative_prompt: '' }
    ],
    sceneNsfwRating: 'sfw',
    sceneDescription: '两人漫步在公园林荫道上'
  });

  // SFW 正向不注入 uncensored
  assert.doesNotMatch(result.basePrompt, /\buncensored\b/i);
  assert.doesNotMatch(result.finalPositive, /\buncensored\b/i);

  // SFW 负向不注入 mosaic
  assert.doesNotMatch(result.finalNegative, /\bmosaic\b/i);
  assert.doesNotMatch(result.finalNegative, /\bbar censor\b/i);
});

test('NovelAIClient generateImage appends anti-censor words for NSFW requests and leaves SFW clean', async () => {
  const client = new NovelAIClient({
    token: 'test-token',
    baseUrl: 'https://image.novelai.net',
    cooldownSeconds: 0
  });

  const originalFetch = globalThis.fetch;
  const originalWaitForCooldown = globalCooldownManager.waitForCooldown;
  const originalStartCooldown = globalCooldownManager.startCooldown;
  const payloads = [];

  globalCooldownManager.waitForCooldown = async () => {};
  globalCooldownManager.startCooldown = () => {};
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { status: 500, text: async () => 'test inspection error' };
  };

  try {
    // 1. NSFW 请求
    await assert.rejects(
      client.generateImage('1girl, nsfw, uncensored, bedroom', {
        model: 'nai-diffusion-4-5-full',
        basePrompt: '1girl, nsfw, uncensored, bedroom'
      }),
      /test inspection error/
    );

    // 2. SFW 请求
    await assert.rejects(
      client.generateImage('1girl, garden, flowers, sunny', {
        model: 'nai-diffusion-4-5-full',
        basePrompt: '1girl, garden, flowers, sunny'
      }),
      /test inspection error/
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalCooldownManager.waitForCooldown = originalWaitForCooldown;
    globalCooldownManager.startCooldown = originalStartCooldown;
  }

  const nsfwNegative = String(payloads[0]?.parameters?.negative_prompt || '');
  assert.match(nsfwNegative, /\bmosaic\b/i, 'NSFW negative prompt should contain mosaic');
  assert.match(nsfwNegative, /\bcensored\b/i, 'NSFW negative prompt should contain censored');

  const sfwNegative = String(payloads[1]?.parameters?.negative_prompt || '');
  assert.doesNotMatch(sfwNegative, /\bmosaic\b/i, 'SFW negative prompt should NOT contain mosaic');
});
