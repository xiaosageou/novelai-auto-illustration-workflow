import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureAdvancedPromptContract,
  extractBoundedScenesJson,
  extractLlmResponseText,
  calculateSceneCount,
  countChapterCharacters,
  countEnglishWords,
  getSceneCountMetrics,
  LLMExtractor,
  mapVisualTextToTags,
  SCENES_JSON_END,
  SCENES_JSON_START
} from '../services/llm-extractor.js';
import { NovelAIClient } from '../services/nai-client.js';
import { globalCooldownManager } from '../utils/cooldown.js';
import {
  buildCharacterInteractionTags,
  buildFinalImagePrompt,
  enforceV45PromptBudget
} from '../services/prompt-builder.js';
import { buildCharacterSpatialGuidance } from '../services/prompt-builder.js';
import { normalizeSceneCard } from '../utils/scene-structure.js';
import { resolveTaskLlmConfig } from '../services/pipeline-manager.js';
import { PipelineManager } from '../services/pipeline-manager.js';

test('task LLM configuration supports independent endpoints with legacy fallback', () => {
  const config = {
    llm_url: 'https://default.example/v1',
    llm_key: 'default-key',
    llm_model: 'default-model',
    llm_character_dna_url: 'https://dna.example/v1',
    llm_character_dna_key: 'dna-key',
    llm_character_dna_model: 'dna-model',
    llm_nai_tags_model: 'tags-model'
  };

  assert.deepEqual(resolveTaskLlmConfig(config, 'characterDna'), {
    baseUrl: 'https://dna.example/v1',
    apiKey: 'dna-key',
    model: 'dna-model'
  });
  assert.deepEqual(resolveTaskLlmConfig(config, 'scene'), {
    baseUrl: 'https://default.example/v1',
    apiKey: 'default-key',
    model: 'default-model'
  });
  assert.deepEqual(resolveTaskLlmConfig(config, 'naiTags'), {
    baseUrl: 'https://default.example/v1',
    apiKey: 'default-key',
    model: 'tags-model'
  });
});

test('scene count uses characters for CJK and words for English chapters', () => {
  assert.equal(countChapterCharacters('一 二\n三\t四'), 4);
  assert.equal(countEnglishWords("It's a well-written chapter."), 4);
  assert.equal(calculateSceneCount(''), 1);
  assert.equal(calculateSceneCount('字'.repeat(600)), 1);
  assert.equal(calculateSceneCount('字'.repeat(601)), 2);
  assert.equal(calculateSceneCount('字'.repeat(1800)), 3);
  assert.equal(calculateSceneCount(Array(350).fill('word').join(' ')), 1);
  assert.equal(calculateSceneCount(Array(351).fill('word').join(' ')), 2);
  assert.deepEqual(getSceneCountMetrics(Array(700).fill('word').join(' ')), {
    language: 'english',
    unit: 'words',
    count: 700,
    divisor: 350,
    sceneCount: 2
  });
  assert.equal(getSceneCountMetrics(`中文正文${'字'.repeat(20)} English Name`).language, 'cjk');
});

test('English scene extraction sends word-based count details to the LLM', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  let capturedPayload;
  const englishText = Array(351).fill('word').join(' ');
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: wrapScenes([
          { scene_idx: 1, trigger_sentence: 'first scene', visual_description: 'Scene one' },
          { scene_idx: 2, trigger_sentence: 'second scene', visual_description: 'Scene two' }
        ]) } }]
      })
    };
  };

  try {
    await extractor.extractChapterScenes('Chapter One', englishText, 'test-model');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const userMessage = capturedPayload.messages.find(message => message.role === 'user').content;
  assert.match(userMessage, /ceil\(英文总词数 \/ 350\)/);
  assert.match(userMessage, /本章英文总词数：351/);
  assert.match(userMessage, /必须输出恰好 2 个场景/);
});

function wrapScenes(scenes) {
  return `${SCENES_JSON_START}\n${JSON.stringify(scenes)}\n${SCENES_JSON_END}`;
}

test('scene output boundary parser rejects a missing end marker as truncation', () => {
  assert.equal(
    extractBoundedScenesJson(`${SCENES_JSON_START}\n[{"scene_idx":1}]\n${SCENES_JSON_END}`),
    '[{"scene_idx":1}]'
  );
  assert.throws(
    () => extractBoundedScenesJson(`${SCENES_JSON_START}\n[{"scene_idx":1}]`),
    /缺少场景输出终止符.*判定输出截断/
  );
});

test('scene extraction sends the locally calculated exact count to the LLM', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  let capturedPayload;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: wrapScenes([
              { scene_idx: 1, trigger_sentence: '第一幕', visual_description: '场景一' },
              { scene_idx: 2, trigger_sentence: '第二幕', visual_description: '场景二' }
            ])
          }
        }]
      })
    };
  };

  try {
    await extractor.extractChapterScenes('测试章', '字'.repeat(601), 'test-model');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const userMessage = capturedPayload.messages.find(message => message.role === 'user').content;
  assert.match(userMessage, /本章有效字符数：601/);
  assert.match(userMessage, /必须输出恰好 2 个场景/);
  assert.match(userMessage, /scene_idx 必须从 1 连续编号到 2/);
  assert.match(userMessage, /SCENES_JSON_START/);
  assert.match(userMessage, /SCENES_JSON_END/);
});

test('scene extraction retries failures before accepting a valid response', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    if (fetchCount === 1) {
      return { status: 502, json: async () => ({ error: 'bad gateway' }) };
    }
    if (fetchCount === 2) {
      return {
        status: 200,
        json: async () => ({
          choices: [{ message: { content: wrapScenes([
            { scene_idx: 1, trigger_sentence: '只有一个', visual_description: '数量不足' }
          ]) } }]
        })
      };
    }
    return {
      status: 200,
      json: async () => ({
        choices: [{ message: { content: wrapScenes([
          { scene_idx: 1, trigger_sentence: '第一幕', visual_description: '场景一' },
          { scene_idx: 2, trigger_sentence: '第二幕', visual_description: '场景二' }
        ]) } }]
      })
    };
  };

  try {
    const scenes = await extractor.extractChapterScenes('测试章', '字'.repeat(601), 'test-model');
    assert.equal(fetchCount, 3);
    assert.equal(scenes.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scene extraction retries when the LLM omits the end marker', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    const scenes = [
      { scene_idx: 1, trigger_sentence: '第一幕', visual_description: '场景一' },
      { scene_idx: 2, trigger_sentence: '第二幕', visual_description: '场景二' }
    ];
    return {
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: fetchCount === 1
              ? `${SCENES_JSON_START}\n${JSON.stringify(scenes)}`
              : wrapScenes(scenes)
          }
        }]
      })
    };
  };

  try {
    const scenes = await extractor.extractChapterScenes('测试章', '字'.repeat(601), 'test-model');
    assert.equal(fetchCount, 2);
    assert.equal(scenes.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scene extraction falls back only after three failed attempts', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return { status: 503, json: async () => ({ error: 'unavailable' }) };
  };

  try {
    const scenes = await extractor.extractChapterScenes('测试章', '这是用于兜底的完整句子。', 'test-model');
    assert.equal(fetchCount, 3);
    assert.equal(scenes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selected sentence regeneration includes its complete paragraph and full chapter context', async () => {
  const extractor = new LLMExtractor({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key'
  });
  let requestBody = null;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              scene_idx: 7,
              trigger_sentence: '她抬起了头',
              visual_description: '角色在雨夜抬头',
              environment: '雨夜街道',
              cinematography: '中景',
              characters: [],
              interactions: '',
              plot_traces: '',
              text_elements: ''
            })
          }
        }]
      })
    };
  };

  try {
    await extractor.regenerateSingleSceneCard(
      '测试章',
      '前一段。\n她抬起了头，雨水顺着脸颊滑落。\n后一段。',
      7,
      '她抬起了头',
      'test-model',
      '她抬起了头，雨水顺着脸颊滑落。'
    );
    const userMessage = requestBody.messages.find(item => item.role === 'user').content;
    assert.match(userMessage, /触发句所在完整段落/);
    assert.match(userMessage, /她抬起了头，雨水顺着脸颊滑落。/);
    assert.match(userMessage, /前一段。/);
    assert.match(userMessage, /后一段。/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('single scene regeneration retries and falls back when the model returns no JSON', async () => {
  const extractor = new LLMExtractor({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key'
  });
  let requestCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    requestCount++;
    return {
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: '这里是说明文字，没有 JSON。'
          }
        }]
      })
    };
  };

  try {
    const scene = await extractor.regenerateSingleSceneCard(
      '测试章',
      '前一段。\n她抬起了头，雨水顺着脸颊滑落。\n后一段。',
      7,
      '她抬起了头',
      'test-model',
      '她抬起了头，雨水顺着脸颊滑落。'
    );
    assert.equal(requestCount, 3);
    assert.equal(scene.scene_idx, 7);
    assert.equal(scene.trigger_sentence, '她抬起了头');
    assert.equal(scene.nsfw_rating, 'sfw');
    assert.match(scene.visual_description, /她抬起了头|测试章/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('selected paragraph scenes are generated in one LLM session', async () => {
  const extractor = new LLMExtractor({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key'
  });
  let requestCount = 0;
  let requestBody = null;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    requestCount++;
    requestBody = JSON.parse(options.body);
    return {
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: `${SCENES_JSON_START}${JSON.stringify([
              {
                selection_index: 1,
                scene_idx: 1,
                trigger_sentence: '她抬起了头',
                visual_description: '角色在雨夜抬头',
                environment: '雨夜街道',
                cinematography: '中景',
                characters: [],
                interactions: '',
                plot_traces: '',
                text_elements: ''
              },
              {
                selection_index: 2,
                scene_idx: 2,
                trigger_sentence: '她轻轻点头',
                visual_description: '角色在门边点头',
                environment: '门廊',
                cinematography: '近景',
                characters: [],
                interactions: '',
                plot_traces: '',
                text_elements: ''
              }
            ])}${SCENES_JSON_END}`
          }
        }]
      })
    };
  };

  try {
    const scenes = await extractor.regenerateSelectedParagraphScenes(
      '测试章',
      '前一段。\n她抬起了头，雨水顺着脸颊滑落。\n她轻轻点头。\n后一段。',
      [
        {
          paragraphIndex: 1,
          text: '她抬起了头',
          paragraph: '她抬起了头，雨水顺着脸颊滑落。'
        },
        {
          paragraphIndex: 2,
          text: '她轻轻点头',
          paragraph: '她轻轻点头。'
        }
      ],
      'test-model'
    );

    assert.equal(requestCount, 1);
    assert.equal(scenes.length, 2);
    assert.equal(scenes[0].trigger_sentence, '她抬起了头');
    assert.equal(scenes[1].trigger_sentence, '她轻轻点头');
    assert.match(requestBody.messages[0].content, /全章覆盖与碎段上下文合并约束/);
    assert.match(requestBody.messages.find(item => item.role === 'user').content, /正文选段列表/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('batch selected paragraph fallback keeps the original paragraph text', async () => {
  const extractor = new LLMExtractor({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key'
  });
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 200,
    json: async () => ({
      choices: [{
        message: { content: '' }
      }]
    })
  });

  try {
    const scenes = await extractor.regenerateSelectedParagraphScenes(
      '测试章',
      '前一段。\n她抬起了头，雨水顺着脸颊滑落。\n后一段。',
      [
        {
          paragraphIndex: 1,
          text: '她抬起了头',
          paragraph: '她抬起了头，雨水顺着脸颊滑落。'
        }
      ],
      'test-model'
    );

    assert.equal(scenes.length, 1);
    assert.equal(scenes[0].trigger_sentence, '她抬起了头');
    assert.match(scenes[0].visual_description, /她抬起了头，雨水顺着脸颊滑落。/);
    assert.doesNotMatch(scenes[0].visual_description, /根据正文选段生成的基础场景/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('priority jobs run without clearing the active pipeline state', async () => {
  const pipeline = new PipelineManager({ projectName: 'priority-test' });
  const observedStates = [];
  pipeline.isRunning = true;
  pipeline.priorityJobRunner = async () => {
    observedStates.push(pipeline.isRunning);
  };

  await pipeline.runPriorityJobs();

  assert.deepEqual(observedStates, [true]);
  assert.equal(pipeline.isRunning, true);
});

test('deleteScene removes the image file and reindexes remaining scenes', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-delete-scene-'));
  const imagePath = path.join(outputDir, 'illustrations', 'scene-2.png');
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, Buffer.from([1, 2, 3]));

  const pipeline = new PipelineManager({ projectName: 'delete-scene-test' });
  pipeline.initialize = async () => {};
  pipeline.projBase = outputDir;
  pipeline.chapters = [{ volume: '卷一', chapter: '第一章' }];
  pipeline.projectProgress = {
    getEffectiveChapKey: () => '卷一_第一章',
    normalizeKey: value => String(value).replace(/[\s_]+/g, '').toLowerCase(),
    getCompletedChapters: () => ({
      '卷一_第一章': {
        scenes: [
          { scene_idx: 1, status: 'SUCCESS', image_path: 'illustrations/scene-1.png' },
          { scene_idx: 2, status: 'SUCCESS', image_path: 'illustrations/scene-2.png' },
          { scene_idx: 3, status: 'SUCCESS', image_path: 'illustrations/scene-3.png' }
        ]
      }
    }),
    setChapterStatus: (key, status, scenes) => {
      pipeline.__saved = { key, status, scenes };
    },
    save: async () => {}
  };

  const result = await pipeline.deleteScene('卷一_第一章', 2);

  assert.equal(result.remainingScenes, 2);
  assert.equal(await fs.access(imagePath).then(() => true).catch(() => false), false);
  assert.deepEqual(pipeline.__saved.status, 'completed');
  assert.deepEqual(pipeline.__saved.scenes.map(scene => scene.scene_idx), [1, 2]);
  assert.deepEqual(pipeline.__saved.scenes.map(scene => scene.image_path), ['illustrations/scene-1.png', 'illustrations/scene-3.png']);
});

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

test('explicit vaginal fluids only map to generic physical evidence, leaving explicit tag choice to MCP and LLM', () => {
  const tagText = mapVisualTextToTags('钰慧的大腿间有大量的淫水顺着流下，滴在沙滩上。').join(', ');

  assert.match(tagText, /wet_thighs/);
  assert.doesNotMatch(tagText, /pussy_juice|cumdrip/);
  assert.doesNotMatch(tagText, /\bsweat\b/);
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

test('character prompt drops generic sweat when explicit lower-body fluid tags are present', () => {
  const result = buildFinalImagePrompt('1girl, beach, nsfw', {
    sceneCharacters: [
      { name: '钰慧', gender: 'woman', expression: '哭泣', pose: '坐在对方腿上' }
    ],
    structuredCharacterPrompts: [
      {
        name: '钰慧',
        prompt: 'girl, sweat, messy_hair, tears, vaginal_fluids, wet_thighs, crying',
        negative_prompt: ''
      }
    ],
    sceneNsfwRating: 'nsfw_moderate'
  });

  assert.doesNotMatch(result.characterPrompts[0], /\bsweat\b/);
  assert.match(result.characterPrompts[0], /vaginal_fluids/);
  assert.match(result.characterPrompts[0], /wet_thighs/);
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

test('legacy LLM prompt output is rejected without deterministic fallback', async () => {
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
    await assert.rejects(
      extractor.generateScenePromptAdvanced({
        visual_description: '女子用剑尖抵住男人喉咙',
        characters: [
          { name: '甲', gender: 'woman' },
          { name: '乙', gender: 'man' }
        ]
      }, [], 'test'),
      /缺少非空 base_prompt/
    );
    assert.equal(fetchCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt retries truncated JSON before accepting valid structured output', async () => {
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

test('NSFW advanced prompt requires perspective tags and fills them when LLM omits them', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  let capturedUserMessage = '';
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    capturedUserMessage = request.messages.find(message => message.role === 'user')?.content || '';
    return {
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              orientation: 'square',
              base_prompt: 'nsfw, explicit, 1girl, bedroom, dim_lighting',
              character_prompts: [{
                name: '甲',
                prompt: 'girl, long_hair, completely_nude, kneeling, embarrassed',
                negative_prompt: '',
                interaction_actions: []
              }],
              negative_prompt: ''
            })
          }
        }]
      })
    };
  };

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '女子跪在昏暗卧室中',
      nsfw_rating: 'nsfw_explicit',
      characters: [{ name: '甲', gender: 'woman', pose: '跪姿' }]
    }, [], 'test');

    assert.match(capturedUserMessage, /NSFW 透视与机位（必须）/);
    assert.match(capturedUserMessage, /关键身体互动、遮挡层次和接触点清楚可见/);
    assert.match(result.base_prompt, /three-quarter_view/);
    assert.match(result.base_prompt, /dynamic_perspective/);
    assert.match(result.base_prompt, /depth_of_field/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('self-directed undressing does not require a target interaction marker on another character', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            orientation: 'square',
            base_prompt: 'nsfw, 1girl, 1boy, bedroom',
            interaction_requirements: [
              {
                action: 'undressing',
                source: '钰慧',
                target: '阿宾',
                requires_pairing: false
              }
            ],
            character_prompts: [
              {
                name: '钰慧',
                prompt: 'girl, long_hair, topless, embarrassed',
                negative_prompt: '',
                interaction_actions: [{ role: 'source', action: 'undressing' }]
              },
              {
                name: '阿宾',
                prompt: 'boy, short_hair, staring, surprised',
                negative_prompt: '',
                interaction_actions: [{ role: 'source', action: 'staring' }]
              }
            ],
            negative_prompt: ''
          })
        }
      }]
    })
  });

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '钰慧在阿宾面前脱衣',
      nsfw_rating: 'nsfw_moderate',
      characters: [
        { name: '钰慧', gender: 'woman' },
        { name: '阿宾', gender: 'man' }
      ],
      interaction_actions: [
        { action: 'undressing', source: '钰慧', target: '阿宾', mutual: false }
      ]
    }, [], 'test');

    assert.equal(result.character_prompts[0].name, '钰慧');
    assert.equal(result.character_prompts[1].name, '阿宾');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLM can explicitly disable pairing validation for non-paired actions like crying', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            orientation: 'square',
            base_prompt: '1girl, 1boy, rain, street',
            interaction_requirements: [
              {
                action: 'crying',
                source: '钰慧',
                target: '阿宾',
                requires_pairing: false
              }
            ],
            character_prompts: [
              {
                name: '钰慧',
                prompt: 'girl, long_hair, crying, tearful',
                negative_prompt: '',
                interaction_actions: []
              },
              {
                name: '阿宾',
                prompt: 'boy, short_hair, worried, standing',
                negative_prompt: '',
                interaction_actions: []
              }
            ],
            negative_prompt: ''
          })
        }
      }]
    })
  });

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '钰慧在阿宾面前哭泣',
      characters: [
        { name: '钰慧', gender: 'woman' },
        { name: '阿宾', gender: 'man' }
      ],
      interaction_actions: [
        { action: 'crying', source: '钰慧', target: '阿宾', mutual: false }
      ]
    }, [], 'test');

    assert.equal(result.character_prompts[0].name, '钰慧');
    assert.equal(result.character_prompts[1].name, '阿宾');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt validation accepts directional penetration roles', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            orientation: 'square',
            base_prompt: 'nsfw, explicit, 1girl, 1boy, bedroom',
            interaction_requirements: [{
              action: 'penetration',
              source: '阿宾',
              target: '王忆如',
              requires_pairing: true,
              mutual: false
            }],
            character_prompts: [
              {
                name: '阿宾',
                prompt: 'boy, short_hair, completely_nude, leaning_forward',
                negative_prompt: '',
                interaction_actions: [{ role: 'source', action: 'penetration' }]
              },
              {
                name: '王忆如',
                prompt: 'girl, long_hair, completely_nude, lying_on_back',
                negative_prompt: '',
                interaction_actions: [{ role: 'target', action: 'penetration' }]
              }
            ],
            negative_prompt: ''
          })
        }
      }]
    })
  });

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '阿宾压在王忆如身上进行插入',
      nsfw_rating: 'nsfw_explicit',
      characters: [
        { name: '阿宾', gender: 'man' },
        { name: '王忆如', gender: 'woman' }
      ],
      interaction_actions: [{
        action: 'penetration',
        source: '阿宾',
        target: '王忆如',
        mutual: false
      }]
    }, [], 'test');

    assert.equal(result.character_prompts[0].interaction_actions[0].role, 'source');
    assert.equal(result.character_prompts[1].interaction_actions[0].role, 'target');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt validation ignores mutual hints for directional sex', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  extractor.searchDanbooruTags = async () => ({ results: [] });
  extractor.getRelatedDanbooruTags = async () => ({ results: [] });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            orientation: 'square',
            base_prompt: 'nsfw, explicit, 1girl, 1boy, bedroom',
            interaction_requirements: [{
              action: 'sex',
              source: '阿宾',
              target: '王忆如',
              requires_pairing: true,
              mutual: false
            }],
            character_prompts: [
              {
                name: '阿宾',
                prompt: 'boy, short_hair, completely_nude, leaning_forward',
                negative_prompt: '',
                interaction_actions: [{ role: 'source', action: 'sex' }]
              },
              {
                name: '王忆如',
                prompt: 'girl, long_hair, completely_nude, lying_on_back',
                negative_prompt: '',
                interaction_actions: [{ role: 'target', action: 'sex' }]
              }
            ],
            negative_prompt: ''
          })
        }
      }]
    })
  });

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '阿宾压在王忆如身上进行性交',
      nsfw_rating: 'nsfw_explicit',
      characters: [
        { name: '阿宾', gender: 'man' },
        { name: '王忆如', gender: 'woman' }
      ],
      interaction_actions: [{
        action: 'sex',
        source: '阿宾',
        target: '王忆如',
        mutual: true
      }]
    }, [], 'test');

    assert.equal(result.character_prompts[0].interaction_actions[0].role, 'source');
    assert.equal(result.character_prompts[1].interaction_actions[0].role, 'target');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('directional sex actions preserve source and target markers in final prompts', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bedroom, sex', {
    sceneCharacters: [
      { name: '钰慧', gender: 'woman', position: 'left' },
      { name: '阿宾', gender: 'man', position: 'right' }
    ],
    sceneInteractionActions: [
      { action: 'sex', source: '阿宾', target: '钰慧', mutual: false }
    ],
    structuredCharacterPrompts: [
      { name: '钰慧', prompt: 'girl, naked, sitting, crying, vaginal_fluids, sweat' },
      { name: '阿宾', prompt: 'boy, naked, standing' }
    ],
    sceneNsfwRating: 'nsfw_explicit'
  });

  assert.match(result.characterPrompts[0], /target#sex/);
  assert.match(result.characterPrompts[1], /source#sex/);
  assert.doesNotMatch(result.characterPrompts.join(' '), /mutual#sex/);
});

test('directional sex actions ignore mutual hints and still emit source target markers', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bedroom, sex', {
    sceneCharacters: [
      { name: '王忆如', gender: 'woman', position: 'left' },
      { name: '阿宾', gender: 'man', position: 'right' }
    ],
    sceneInteractionActions: [
      { action: 'sex', source: '阿宾', target: '王忆如', mutual: true }
    ],
    structuredCharacterPrompts: [
      { name: '王忆如', prompt: 'girl, naked, lying, sweating, vaginal_fluids' },
      { name: '阿宾', prompt: 'boy, naked, standing' }
    ],
    sceneNsfwRating: 'nsfw_explicit'
  });

  assert.match(result.characterPrompts[0], /target#sex/);
  assert.match(result.characterPrompts[1], /source#sex/);
  assert.doesNotMatch(result.characterPrompts.join(' '), /mutual#sex/);
});

test('penetration scenes require inset xray guidance while non-penetrative scenes do not', () => {
  const penetrationResult = buildFinalImagePrompt('1girl, 1boy, bedroom, sex', {
    sceneCharacters: [
      { name: '钰慧', gender: 'woman', position: 'left' },
      { name: '阿宾', gender: 'man', position: 'right' }
    ],
    sceneInteractions: '阿宾将性器官插入钰慧体内',
    sceneInteractionActions: [
      { action: 'penetration', source: '阿宾', target: '钰慧', mutual: false }
    ],
    sceneDescription: '阿宾与钰慧发生明确插入性交，主图保持外视角，插入点放入局部放大图。',
    sceneNsfwRating: 'nsfw_explicit'
  });

  assert.match(penetrationResult.basePrompt, /magnified inset/i);
  assert.match(penetrationResult.basePrompt, /x-ray inset/i);
  assert.doesNotMatch(penetrationResult.finalNegative, /comic panel/i);
  assert.doesNotMatch(penetrationResult.finalNegative, /inset image/i);

  const handjobResult = buildFinalImagePrompt('1girl, 1boy, handjob', {
    sceneCharacters: [
      { name: '淑华', gender: 'woman', position: 'left' },
      { name: '明健', gender: 'man', position: 'right' }
    ],
    sceneInteractions: '淑华用手上下套弄明健暴露的性器官',
    sceneInteractionActions: [
      { action: 'handjob', source: '淑华', target: '明健', mutual: false }
    ],
    sceneDescription: '淑华在围墙边给明健手交，没有插入动作。',
    sceneNsfwRating: 'nsfw_explicit'
  });

  assert.doesNotMatch(handjobResult.basePrompt, /magnified inset/i);
  assert.match(handjobResult.finalNegative, /comic panel/i);
});

test('three-character interaction graph keeps both directed contacts and partner positions', () => {
  const result = buildFinalImagePrompt('2girls, 1boy, bedroom, explicit', {
    sceneCharacters: [
      { name: '阿宾', gender: 'man', position: 'left foreground' },
      { name: '王忆如', gender: 'woman', position: 'center midground' },
      { name: '柳敏霓', gender: 'woman', position: 'right foreground' }
    ],
    sceneInteractions: '阿宾从左侧与中央的王忆如发生插入动作，右侧柳敏霓吸吮王忆如乳头',
    sceneInteractionActions: [
      { action: 'penetration', source: '阿宾', target: '王忆如', mutual: false },
      { action: 'sucking_nipple', source: '柳敏霓', target: '王忆如', mutual: false }
    ],
    structuredCharacterPrompts: [
      { name: '阿宾', prompt: 'boy, short_hair, completely_nude, leaning_forward' },
      { name: '王忆如', prompt: 'girl, long_hair, completely_nude, lying_on_back' },
      { name: '柳敏霓', prompt: 'girl, black_hair, completely_nude, kneeling' }
    ],
    sceneNsfwRating: 'nsfw_explicit'
  });

  assert.deepEqual(result.characterCenters, [
    { x: 0.3, y: 0.7 },
    { x: 0.5, y: 0.5 },
    { x: 0.7, y: 0.7 }
  ]);
  assert.match(result.characterPrompts[0], /source#penetration/);
  assert.match(result.characterPrompts[0], /woman in the center/);
  assert.match(result.characterPrompts[1], /target#penetration/);
  assert.match(result.characterPrompts[1], /target#sucking_nipple/);
  assert.match(result.characterPrompts[1], /man on the left/);
  assert.match(result.characterPrompts[1], /woman on the right/);
  assert.match(result.characterPrompts[2], /source#sucking_nipple/);
  assert.match(result.characterPrompts[2], /woman in the center/);
  assert.match(result.basePrompt, /single unified three-character composition/);
  assert.match(result.basePrompt, /readable interaction graph/);
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
      negativeCharacterPrompts: [
        'black_hair, black_robe',
        'long_hair, white_robe'
      ],
      characterCenters: [
        { x: 0.3, y: 0.5 },
        { x: 0.7, y: 0.5 }
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
  assert.equal(capturedPayload.input, '1girl, 1boy, indoors');
  assert.equal(params.use_coords, true);
  assert.equal(params.v4_prompt.use_coords, true);
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
    [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }]
  );
  assert.deepEqual(
    params.v4_negative_prompt.caption.char_captions.map(item => item.centers[0]),
    [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }]
  );
  assert.deepEqual(params.characterPrompts[0], {
    prompt: 'girl, long_hair, white_robe',
    uc: 'black_hair, black_robe',
    center: { x: 0.3, y: 0.5 },
    enabled: true
  });
  assert.equal(
    params.v4_negative_prompt.caption.char_captions[1].char_caption,
    'long_hair, white_robe'
  );
});

test('character spatial guidance maps positions and interaction direction', () => {
  const guidance = buildCharacterSpatialGuidance([
    { name: '甲', position: 'left' },
    { name: '乙', position: 'right' }
  ], '甲抱住乙并看向乙');

  assert.deepEqual(guidance.centers, [
    { x: 0.3, y: 0.5 },
    { x: 0.7, y: 0.5 }
  ]);
  assert.equal(guidance.characterDirections[0], 'facing right');
  assert.equal(guidance.characterDirections[1], 'facing left');
  assert.match(guidance.basePrompt, /characters facing each other/);
  assert.match(guidance.basePrompt, /interaction directed from left to right/);
});

test('NAI rejects once without dropping coordinates or character prompts', async () => {
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
    return { status: 500, text: async () => 'coordinate payload rejected' };
  };

  try {
    await assert.rejects(
      client.generateImage('1girl, 1boy, hugging', {
        model: 'nai-diffusion-4-5-full',
        basePrompt: '1girl, 1boy, hugging',
        characterPrompts: ['girl, blonde hair', 'boy, black hair'],
        characterCenters: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }],
        useStructuredCharacterCaptions: true
      }),
      /coordinate payload rejected/
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalCooldownManager.waitForCooldown = originalWaitForCooldown;
    globalCooldownManager.startCooldown = originalStartCooldown;
  }

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].parameters.v4_prompt.use_coords, true);
  assert.equal(payloads[0].parameters.v4_prompt.caption.char_captions.length, 2);
});

test('interaction actions map source, target, and mutual roles to NAI V4.5 tags', () => {
  const characters = [{ name: '甲' }, { name: '乙' }];
  assert.deepEqual(
    buildCharacterInteractionTags(characters, [
      { action: 'hug', source: '甲', target: '乙', mutual: false }
    ]),
    [['source#hug'], ['target#hug']]
  );
  assert.deepEqual(
    buildCharacterInteractionTags(characters, [
      { action: 'kiss', source: '甲', target: '乙', mutual: true }
    ]),
    [['mutual#kiss'], ['mutual#kiss']]
  );
  assert.deepEqual(
    buildCharacterInteractionTags(characters, [], [
      {
        name: '甲',
        interaction_actions: [
          { role: 'source', action: 'grabbing' },
          { role: 'mutual', action: 'looking_at_another' }
        ]
      },
      {
        name: '乙',
        interaction_actions: [
          { role: 'target', action: 'grabbing' },
          { role: 'mutual', action: 'looking_at_another' }
        ]
      }
    ]),
    [
      ['source#grabbing', 'mutual#looking_at_another'],
      ['target#grabbing', 'mutual#looking_at_another']
    ]
  );
});

test('V4.5 prompt budget keeps interaction and identity tags under the shared limit', () => {
  const filler = Array.from({ length: 250 }, (_, index) => `decorative_detail_${index}`).join(', ');
  const budgeted = enforceV45PromptBudget(
    `1girl, 1boy, exactly_two_characters, ${filler}`,
    [
      `girl, blonde_hair, blue_eyes, source#hug, ${filler}`,
      `boy, black_hair, red_eyes, target#hug, ${filler}`
    ],
    480
  );

  assert.ok(budgeted.estimatedTokens <= 480);
  assert.match(budgeted.basePrompt, /exactly_two_characters/);
  assert.match(budgeted.characterPrompts[0], /source#hug/);
  assert.match(budgeted.characterPrompts[1], /target#hug/);
});

test('character prompts follow left-to-right order with aligned UC and interaction language', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, indoors, hugging', {
    sceneCharacters: [
      { name: '乙', gender: 'man', position: 'right' },
      { name: '甲', gender: 'woman', position: 'left' }
    ],
    sceneInteractions: '甲从左侧抱住乙',
    sceneInteractionActions: [
      { action: 'hug', source: '甲', target: '乙', mutual: false }
    ],
    structuredCharacterPrompts: [
      {
        name: '乙',
        prompt: 'boy, black_hair, black_shirt',
        negative_prompt: 'blonde_hair, white_dress'
      },
      {
        name: '甲',
        prompt: 'girl, blonde_hair, white_dress',
        negative_prompt: 'black_hair, black_shirt'
      }
    ]
  });

  assert.match(result.characterPrompts[0], /blonde_hair/);
  assert.match(result.characterPrompts[0], /source#hug/);
  assert.match(result.characterPrompts[0], /performs hug on the other character from the left/);
  assert.deepEqual(result.negativeCharacterPrompts, [
    'black_hair, black_shirt',
    'blonde_hair, white_dress'
  ]);
  assert.deepEqual(result.characterCenters, [
    { x: 0.3, y: 0.5 },
    { x: 0.7, y: 0.5 }
  ]);
});

test('pipeline regenerates the full prompt after NAI rejects it', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-prompt-retry-'));
  const pipeline = new PipelineManager({ projectName: 'prompt-retry-test' });
  const scene = {
    scene_idx: 1,
    visual_description: '甲从左侧拥抱乙',
    environment: 'indoors',
    interactions: '甲拥抱乙',
    interaction_actions: [
      { action: 'hug', source: '甲', target: '乙', mutual: false }
    ],
    characters: [
      { name: '甲', gender: 'woman', position: 'left' },
      { name: '乙', gender: 'man', position: 'right' }
    ]
  };
  let llmCalls = 0;
  let naiCalls = 0;
  pipeline.illustrationsDir = outputDir;
  pipeline.autoMatchCharacterDNA = () => [];
  pipeline.getVibeBundleForModel = async () => null;
  pipeline.naiTagsExtractor.generateScenePromptAdvanced = async () => {
    llmCalls++;
    return {
      orientation: 'square',
      base_prompt: `1girl, 1boy, indoors, prompt_version_${llmCalls}`,
      character_prompts: [
        { name: '甲', prompt: 'girl, white dress', interaction_role: 'source', interaction_action: 'hug' },
        { name: '乙', prompt: 'boy, black shirt', interaction_role: 'target', interaction_action: 'hug' }
      ],
      negative_prompt: ''
    };
  };
  pipeline.naiClient.generateImage = async (prompt) => {
    naiCalls++;
    if (naiCalls === 1) throw new Error('prompt rejected');
    assert.match(prompt, /prompt_version_2/);
    return { imageBytes: Uint8Array.from([137, 80, 78, 71]) };
  };
  pipeline.projectProgress = {
    setChapterStatus() {},
    save: async () => {}
  };

  try {
    await pipeline.generateSingleScene(
      { chapter: '测试章', content: '甲拥抱乙' },
      scene,
      [scene],
      '测试章',
      'test-llm',
      'nai-diffusion-4-5-full'
    );
    assert.equal(llmCalls, 2);
    assert.equal(naiCalls, 2);
    assert.equal(scene.status, 'SUCCESS');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('pipeline retries the complete scene flow three times for any error', async () => {
  const pipeline = new PipelineManager({ projectName: 'generic-retry-test' });
  const scene = {
    scene_idx: 1,
    visual_description: '女子站在庭院中',
    characters: [{ name: '甲', gender: 'woman' }]
  };
  let llmCalls = 0;
  pipeline.autoMatchCharacterDNA = () => [];
  pipeline.naiTagsExtractor.generateScenePromptAdvanced = async () => {
    llmCalls++;
    throw new Error(`arbitrary failure ${llmCalls}`);
  };
  pipeline.projectProgress = {
    setChapterStatus() {},
    save: async () => {}
  };

  const result = await pipeline.generateSingleScene(
    { chapter: '测试章', content: '女子站在庭院中' },
    scene,
    [scene],
    '测试章',
    'test-llm',
    'nai-diffusion-4-5-full'
  );

  assert.equal(result, false);
  assert.equal(llmCalls, 3);
  assert.equal(scene.status, 'FAILED');
});

test('scene normalization removes interactions whose endpoints are not characters', () => {
  const normalized = normalizeSceneCard({
    scene_idx: 1,
    characters: [{ name: '钰慧' }],
    interaction_actions: [
      { action: 'looking_at', source: '钰慧', target: '远处' }
    ]
  });

  assert.deepEqual(normalized.interaction_actions, []);
});

test('final prompt keeps characters separated while reinforcing interaction direction', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bedroom, hugging', {
    sceneCharacters: [
      { name: '甲', gender: 'woman', position: 'left', pose: '抱住乙' },
      { name: '乙', gender: 'man', position: 'right', pose: '回抱甲' }
    ],
    sceneInteractions: '甲从左侧抱住乙，乙转身面向甲',
    structuredCharacterPrompts: [
      { name: '甲', prompt: 'girl, blonde hair, white dress, hugging' },
      { name: '乙', prompt: 'boy, black hair, black shirt, hugging' }
    ]
  });

  assert.equal(result.characterCenters.length, 2);
  assert.match(result.characterPrompts[0], /facing right/);
  assert.match(result.characterPrompts[1], /facing left/);
  assert.match(result.basePrompt, /interaction directed from left to right/);
  assert.doesNotMatch(result.characterPrompts[0], /black hair|black shirt/);
  assert.doesNotMatch(result.characterPrompts[1], /blonde hair|white dress/);
});
