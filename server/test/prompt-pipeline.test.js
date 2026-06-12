import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureAdvancedPromptContract,
  extractLlmResponseText,
  LLMExtractor
} from '../services/llm-extractor.js';
import { NovelAIClient } from '../services/nai-client.js';
import { globalCooldownManager } from '../utils/cooldown.js';
import { buildFinalImagePrompt } from '../services/prompt-builder.js';
import { normalizeSceneCard } from '../utils/scene-structure.js';

test('scene normalization reconciles named characters and infers shadow entities', () => {
  const groupScene = normalizeSceneCard({
    visual_description: '甲乙丙丁在雪中',
    character_names: ['甲', '乙', '丙', '丁'],
    characters: [{ name: '甲' }, { name: '乙' }, { name: '丙' }]
  });
  assert.equal(groupScene.characters.length, 4);
  assert.deepEqual(groupScene.character_names, ['甲', '乙', '丙', '丁']);

  const shadowScene = normalizeSceneCard({
    visual_description: '少年从门缝窥视屏风后两个交叠人影',
    characters: [{ name: '少年', gender: 'boy' }],
    interactions: '窥视屏风后男女剪影'
  });
  assert.equal(shadowScene.characters.length, 1);
  assert.equal(shadowScene.visual_entities[0].type, 'shadow_silhouette');
  assert.ok(shadowScene.must_show.includes('two_human_silhouettes'));
  assert.ok(shadowScene.must_show.includes('view_through_door_crack'));
});

test('legacy custom advanced prompt receives the current structured output contract', () => {
  const legacyPrompt = `Output JSON:
{
  "orientation": "portrait",
  "prompt": "comma-separated tags",
  "negative_prompt": ""
}`;
  const normalized = ensureAdvancedPromptContract(legacyPrompt);

  assert.match(normalized, /CURRENT OUTPUT CONTRACT \(HIGHEST PRIORITY\)/);
  assert.match(normalized, /"base_prompt"/);
  assert.match(normalized, /"character_prompts"/);
  assert.match(normalized, /legacy schema containing only "prompt" is obsolete/i);
});

test('current scene state overrides conflicting DNA clothing, hair, and poses', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, indoors', {
    sceneCharacters: [
      { name: '女', gender: 'woman', appearance: '长发散乱', clothing: '全裸', pose: '趴在床上' },
      { name: '男', gender: 'man', clothing: '全裸', expression: '面容扭曲，带着狰狞而兴奋的怪笑', pose: '跪在身后' }
    ],
    characterAnchors: [
      {
        name: '女',
        正面提示词: 'hair_bun, hair_ornament, black_and_white_robe, long_hair, pale_skin',
        结构化特征: {
          发型标签: ['hair_bun', 'long_hair'],
          特殊特征标签: ['hair_ornament'],
          服装基底标签: ['black_and_white_robe'],
          肤色标签: ['pale_skin']
        }
      },
      { name: '男', 正面提示词: 'daoist_robe, black_robe' }
    ],
    structuredCharacterPrompts: [
      { name: '女', prompt: '1girl, on_back, black_and_white_robe, completely_nude' },
      { name: '男', prompt: '1man, daoist_robe, kneeling, crazed_expression, grin' }
    ],
    artistStylePrompt: '4::masterpiece, best quality::, 1.5::artist:nardack::',
    useCharacterSegments: false
  });

  assert.match(result.characterPrompts[0], /completely_nude/);
  assert.doesNotMatch(result.characterPrompts[0], /on_back|hair_bun|hair_ornament|robe/);
  assert.doesNotMatch(result.characterPrompts[1], /daoist_robe|black_robe/);
  assert.match(result.characterPrompts[1], /^1boy,/);
  assert.match(result.characterPrompts[1], /crazed_expression/);
  assert.match(result.characterPrompts[1], /\bgrin\b/);
  assert.doesNotMatch(result.characterPrompts[1], /closed mouth|natural expression/);
  assert.equal((result.finalPositive.match(/\b1girl\b/g) || []).length, 1);
  assert.equal((result.finalPositive.match(/\b1boy\b/g) || []).length, 1);
  assert.doesNotMatch(result.finalPositive, /\b1man\b/);
  assert.match(result.basePrompt, /masterpiece/);
  assert.match(result.basePrompt, /artist:nardack/);
});

test('final NAI prompts remove untranslated CJK tag fragments', () => {
  const result = buildFinalImagePrompt('1girl, bedroom, 清幽寝殿', {
    sceneCharacters: [{ name: '女', gender: 'woman' }],
    characterAnchors: [{
      name: '女',
      正面提示词: 'elegant, 清冷矜贵, slim, 前凸后翘, 灿金色发丝'
    }],
    structuredCharacterPrompts: [{
      name: '女',
      prompt: '1girl, blonde_hair, 莹白肌肤, calm expression'
    }],
    extraNegative: 'bad anatomy, 中文残留',
    useCharacterSegments: true
  });

  assert.doesNotMatch(result.basePrompt, /[\p{Script=Han}]/u);
  assert.doesNotMatch(result.characterPrompts.join(', '), /[\p{Script=Han}]/u);
  assert.doesNotMatch(result.finalPositive, /[\p{Script=Han}]/u);
  assert.doesNotMatch(result.finalNegative, /[\p{Script=Han}]/u);
  assert.match(result.finalPositive, /blonde_hair/);
  assert.match(result.finalPositive, /elegant/);
});

test('multi-character prompts balance detail unless a character is intentionally backgrounded', () => {
  const balanced = buildFinalImagePrompt(
    '2characters, close-up, focus on lower body, focus on buttocks, bedroom',
    {
      sceneCharacters: [
        { name: '甲', gender: 'woman', position: 'left' },
        { name: '乙', gender: 'man', position: 'right' }
      ],
      structuredCharacterPrompts: [
        { name: '甲', prompt: '1girl, lying_on_side' },
        { name: '乙', prompt: '1boy, standing' }
      ],
      useCharacterSegments: false
    }
  );

  assert.doesNotMatch(balanced.basePrompt, /\bclose-up\b|focus on lower body|focus on buttocks/i);
  assert.match(balanced.basePrompt, /single unified composition/);
  assert.match(balanced.basePrompt, /shared central action/);
  assert.match(balanced.basePrompt, /overlapping silhouettes/);
  assert.match(balanced.basePrompt, /same focal plane/);
  assert.match(balanced.finalNegative, /simplified background character/);

  const intentionalBackground = buildFinalImagePrompt('2characters, close-up, shadow_play', {
    sceneCharacters: [
      { name: '甲', gender: 'boy', position: 'foreground' },
      { name: '乙', gender: 'woman', position: 'background_shadow', appearance: '屏风剪影' }
    ]
  });
  assert.match(intentionalBackground.basePrompt, /\bclose-up\b/);
  assert.doesNotMatch(intentionalBackground.basePrompt, /single unified composition/);
});

test('interactive two-character prompt avoids side-by-side character card composition', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, handjob, left_side, right_side, close-up', {
    sceneCharacters: [
      { name: '甲', gender: 'woman', position: 'left' },
      { name: '乙', gender: 'man', position: 'right' }
    ],
    structuredCharacterPrompts: [
      { name: '甲', prompt: '1girl, blonde_hair, hand_on_penis, on_left' },
      { name: '乙', prompt: '1boy, black_hair, standing, right_foreground' }
    ],
    useCharacterSegments: false
  });

  assert.doesNotMatch(result.finalPositive, /\bleft_side\b|\bright_side\b|\bon_left\b|\bright_foreground\b/);
  assert.doesNotMatch(result.finalPositive, /both characters fully rendered|equal character detail/);
  assert.match(result.finalPositive, /single unified composition/);
  assert.match(result.finalPositive, /shared central action/);
  assert.match(result.finalPositive, /overlapping silhouettes/);
  assert.match(result.finalNegative, /vertical divider/);
  assert.match(result.finalNegative, /side-by-side character cards/);
  assert.match(result.finalNegative, /separate backgrounds/);
});

test('scene prompt allows simple or solid backgrounds without forced environment detail', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bed, dim_lighting, simple_background', {
    sceneEnvironment: '深夜卧室，床铺凌乱，窗边有月光与帷幔',
    sceneDescription: '两个人位于床边',
    sceneCharacters: [
      { name: '甲', gender: 'woman' },
      { name: '乙', gender: 'man' }
    ],
    structuredCharacterPrompts: [
      { name: '甲', prompt: '1girl, sitting' },
      { name: '乙', prompt: '1boy, standing' }
    ]
  });

  assert.match(result.basePrompt, /simple_background/);
  assert.doesNotMatch(result.basePrompt, /detailed bedroom interior|visible environment|layered environment/);
  assert.doesNotMatch(result.finalNegative, /white background|black background|empty background|simple background/);
});

test('character expression cleanup keeps restrained scene emotion without flattening it', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, indoors', {
    sceneCharacters: [
      { name: '甲', gender: 'woman', expression: '担忧而紧张地看向门外' },
      { name: '乙', gender: 'man', expression: '惊讶错愕' }
    ],
    structuredCharacterPrompts: [
      { name: '甲', prompt: '1girl, calm_expression, natural_expression, crazy_grin' },
      { name: '乙', prompt: '1boy, expressionless, surprised, bared_teeth' }
    ]
  });

  assert.match(result.characterPrompts[0], /worried/);
  assert.match(result.characterPrompts[0], /slightly furrowed brows/);
  assert.doesNotMatch(result.characterPrompts[0], /calm_expression|natural_expression|crazy_grin/);
  assert.match(result.characterPrompts[1], /surprised/);
  assert.match(result.characterPrompts[1], /raised eyebrows/);
  assert.match(result.characterPrompts[1], /slightly parted lips/);
  assert.doesNotMatch(result.characterPrompts[1], /expressionless|bared_teeth/);
});

test('NSFW character expressions follow each character state without exaggerated faces', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bedroom, nsfw', {
    sceneNsfwRating: 'nsfw_explicit',
    sceneCharacters: [
      { name: '甲', gender: 'woman', expression: '高潮后的快感与迷离，脸颊潮红' },
      { name: '乙', gender: 'man', expression: '事后虚脱疲惫，眼神失焦' }
    ],
    structuredCharacterPrompts: [
      { name: '甲', prompt: '1girl, expressionless, crazy_grin, ahegao' },
      { name: '乙', prompt: '1boy, calm_expression, evil_smile, distorted_mouth' }
    ]
  });

  assert.match(result.characterPrompts[0], /pleasured expression/);
  assert.match(result.characterPrompts[0], /half-closed eyes/);
  assert.match(result.characterPrompts[0], /slightly parted lips/);
  assert.doesNotMatch(result.characterPrompts[0], /expressionless|crazy_grin/);
  assert.match(result.characterPrompts[1], /dazed expression/);
  assert.match(result.characterPrompts[1], /unfocused eyes/);
  assert.match(result.characterPrompts[1], /lowered eyelids/);
  assert.doesNotMatch(result.characterPrompts[1], /calm_expression|evil_smile|distorted_mouth/);
});

test('LLM response extraction supports content parts and fake-stream SSE chunks', () => {
  assert.equal(
    extractLlmResponseText({
      choices: [{
        message: {
          content: [
            { type: 'text', text: '{"base_' },
            { type: 'text', text: 'prompt":"forest"}' }
          ]
        }
      }]
    }),
    '{"base_prompt":"forest"}'
  );

  assert.equal(
    extractLlmResponseText([
      'data: {"choices":[{"delta":{"content":"{\\\"base_prompt\\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"\\\"forest\\\"}"}}]}',
      'data: [DONE]'
    ].join('\n')),
    '{"base_prompt":"forest"}'
  );
});

test('legacy LLM prompt output falls back to deterministic structured compilation', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => {
      fetchCount++;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              orientation: 'landscape',
              prompt: '1girl, 1boy, forest'
            })
          }
        }]
      };
    }
  });

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '女子用剑尖抵住男人喉咙',
      environment: '树林',
      cinematography: '侧面中景',
      characters: [
        { name: '甲', gender: 'woman', clothing: '白衣', pose: '持剑抵住乙喉咙' },
        { name: '乙', gender: 'man', pose: '后仰' }
      ],
      interactions: '甲的剑尖抵住乙的喉咙',
      plot_traces: 'sharp_blade',
      must_show: ['sword_tip_touching_throat'],
      must_not_show: ['swinging_sword']
    }, [], 'test');

    assert.match(result.base_prompt, /sword_tip_touching_throat/);
    assert.match(result.base_prompt, /side_view/);
    assert.equal(result.character_prompts.length, 2);
    assert.equal(result.character_prompts[0].name, '甲');
    assert.match(result.negative_prompt, /swinging_sword/);
    assert.equal(fetchCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt retries truncated JSON before deterministic fallback', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    const content = fetchCount < 3
      ? '{"orientation":"landscape","base_prompt":"forest"'
      : JSON.stringify({
          orientation: 'landscape',
          base_prompt: '1girl, forest, sunlight',
          character_prompts: [{ name: '甲', prompt: '1girl, white_robe, standing' }],
          negative_prompt: ''
        });
    return {
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: fetchCount < 3 ? 'length' : 'stop',
          message: { content }
        }]
      })
    };
  };

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '女子站在林中',
      characters: [{ name: '甲', gender: 'woman', clothing: '白衣', pose: '站立' }]
    }, [], 'test');

    assert.equal(fetchCount, 3);
    assert.equal(result.base_prompt, 'forest, sunlight');
    assert.equal(result.character_prompts[0].name, '甲');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NAI V4 structured character payload mirrors official character slots', async () => {
  const client = new NovelAIClient({
    token: 'test-token',
    baseUrl: 'https://image.novelai.net',
    cooldownSeconds: 0
  });
  const originalFetch = globalThis.fetch;
  const originalWaitForCooldown = globalCooldownManager.waitForCooldown;
  const originalStartCooldown = globalCooldownManager.startCooldown;
  let capturedPayload;
  globalCooldownManager.waitForCooldown = async () => {};
  globalCooldownManager.startCooldown = () => {};
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      status: 200,
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    };
  };

  try {
    await client.generateImage('1girl, 1boy, indoors, girl details, boy details', {
      model: 'nai-diffusion-4-5-full',
      basePrompt: '1girl, 1boy, indoors',
      characterPrompts: [
        '1girl, long_hair, white_robe',
        '1man, short_hair, black_robe'
      ],
      useStructuredCharacterCaptions: true,
      negativePrompt: 'bad anatomy'
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalCooldownManager.waitForCooldown = originalWaitForCooldown;
    globalCooldownManager.startCooldown = originalStartCooldown;
  }

  const params = capturedPayload.parameters;
  assert.equal(params.use_coords, false);
  assert.equal(params.v4_prompt.use_coords, false);
  assert.equal(params.v4_prompt.caption.base_caption, '1girl, 1boy, indoors');
  assert.equal(params.v4_prompt.caption.char_captions.length, 2);
  assert.equal(params.v4_negative_prompt.caption.char_captions.length, 2);
  assert.equal(params.characterPrompts.length, 2);
  assert.match(params.v4_prompt.caption.char_captions[0].char_caption, /^girl,/);
  assert.match(params.v4_prompt.caption.char_captions[1].char_caption, /^boy,/);
  assert.doesNotMatch(params.v4_prompt.caption.char_captions[0].char_caption, /\b1girl\b/);
  assert.doesNotMatch(params.v4_prompt.caption.char_captions[1].char_caption, /\b1man\b|\b1boy\b/);
  assert.deepEqual(
    params.v4_prompt.caption.char_captions.map(item => item.centers[0]),
    [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]
  );
  assert.deepEqual(
    params.v4_negative_prompt.caption.char_captions.map(item => item.centers[0]),
    [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]
  );
  assert.deepEqual(params.characterPrompts[0], {
    prompt: 'girl, long_hair, white_robe',
    uc: '',
    center: { x: 0.2, y: 0.5 },
    enabled: true
  });
});
