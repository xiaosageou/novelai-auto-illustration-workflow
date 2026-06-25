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
  postChatCompletionWith429Retry,
  readLlmResponse,
  SCENES_JSON_END,
  SCENES_JSON_START
} from '../services/llm-extractor.js';
import { NovelAIClient } from '../services/nai-client.js';
import { globalCooldownManager } from '../utils/cooldown.js';
import {
  buildFinalImagePrompt,
  enforceV45PromptBudget,
  estimateV45Tokens
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
  assert.match(userMessage, /core_action/);
  assert.doesNotMatch(userMessage, /selection_reason/);
  assert.match(userMessage, /瞬间定格|单帧|过程动作/);
  assert.match(userMessage, /NSFW/);
  assert.match(userMessage, /多选取.*NSFW|向\s*NSFW\s*场景倾斜/);
  assert.match(userMessage, /适当选取.*SFW|保留.*SFW/);
});

test('scene extraction requests streaming and parses SSE response bodies', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  let capturedPayload;
  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    const scenes = wrapScenes([
      { scene_idx: 1, trigger_sentence: '第一幕', visual_description: '场景一' },
      { scene_idx: 2, trigger_sentence: '第二幕', visual_description: '场景二' }
    ]);
    return {
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: scenes.slice(0, 20) } }] })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: scenes.slice(20) } }] })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      }),
      headers: { get: () => 'text/event-stream' }
    };
  };

  try {
    const scenes = await extractor.extractChapterScenes('测试章', '字'.repeat(601), 'test-model');
    assert.equal(capturedPayload.stream, true);
    assert.equal(scenes.length, 2);
    assert.equal(scenes[1].trigger_sentence, '第二幕');
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    assert.match(userMessage, /瞬间定格|单帧|禁止.*然后|随后|接着/);
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

test('chapter scene extraction event publishes full progress immediately', () => {
  const pipeline = new PipelineManager({ projectName: 'scene-progress-test' });
  const events = [];
  pipeline.projectProgress = {
    data: {
      completed_chapters: {
        卷一_第一章: {
          status: 'generating',
          scenes: [{ scene_idx: 1 }]
        }
      }
    }
  };
  pipeline.uiProgressCallback = (payload) => {
    events.push(payload);
  };

  pipeline._emitChapterScenesExtracted(
    { chapter: '第一章' },
    '卷一_第一章',
    [{ scene_idx: 1, trigger_sentence: '她抬头' }]
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'chapter_scenes_extracted');
  assert.equal(events[0].chapterKey, '卷一_第一章');
  assert.equal(events[0].totalScenes, 1);
  assert.equal(events[0].fullProgress.completed_chapters['卷一_第一章'].status, 'generating');
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

test('scene normalization limits visible characters to four primary people', () => {
  const groupScene = normalizeSceneCard({
    visual_description: '甲乙丙丁戊五人站在庭院中对峙',
    character_names: ['甲', '乙', '丙', '丁', '戊'],
    characters: [
      { name: '甲', pose: '站在最前' },
      { name: '乙', pose: '站在左侧' },
      { name: '丙', pose: '站在右侧' },
      { name: '丁', pose: '站在后方' },
      { name: '戊', pose: '站在远处' }
    ],
    interaction_actions: [
      { action: 'staring', source: '甲', target: '乙', mutual: false },
      { action: 'staring', source: '戊', target: '甲', mutual: false }
    ]
  });

  assert.equal(groupScene.characters.length, 4);
  assert.deepEqual(groupScene.character_names, ['甲', '乙', '丙', '丁']);
  assert.deepEqual(groupScene.characters.map(char => char.name), ['甲', '乙', '丙', '丁']);
  assert.equal(groupScene.interaction_actions.length, 1);
  assert.equal(groupScene.interaction_actions[0].source, '甲');
});

test('scene normalization preserves lightweight scene-card fields without selection reason', () => {
  const scene = normalizeSceneCard({
    scene_idx: 1,
    trigger_sentence: '她抬起了头',
    visual_description: '雨夜里她抬头看向门外',
    core_action: '她抬头看向门外来人',
    character_names: ['她']
  });

  assert.equal(scene.core_action, '她抬头看向门外来人');
  assert.ok(!('selection_reason' in scene) || !scene.selection_reason);
});

test('updateSceneCard persists edited structured scene fields', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-update-scene-'));
  const projectDir = path.join(outputDir, 'projects', 'scene-edit-test');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'book.txt'),
    '第一卷\n第一章\n\n她抬起了头，看向门外。\n',
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, 'pipeline_progress.json'),
    JSON.stringify({
      completed_chapters: {
        '第一卷_第一章': {
          status: 'generating',
          scenes: [
            {
              scene_idx: 1,
              trigger_sentence: '她抬起了头',
              visual_description: '旧描述',
              character_names: ['甲', '乙', '丙', '丁', '戊'],
              characters: [{ name: '甲' }, { name: '乙' }, { name: '丙' }, { name: '丁' }, { name: '戊' }]
            }
          ]
        }
      },
      global_characters: {},
      character_dna_slices: {},
      pipeline_pause: null
    }, null, 2),
    'utf-8'
  );

  const pipeline = new PipelineManager({ projectName: 'scene-edit-test' });
  pipeline.baseDir = outputDir;
  pipeline.switchProject('scene-edit-test');

  const result = await pipeline.updateSceneCard('第一卷_第一章', 1, {
    trigger_sentence: '她抬起了头',
    visual_description: '新描述',
    nsfw_rating: 'nsfw_mild',
    environment: '夜晚庭院',
    cinematography: '中景，侧面',
    interactions: '甲与乙对视，丙丁在后方',
    characters: [
      { name: '甲', pose: '前景' },
      { name: '乙', pose: '左侧' },
      { name: '丙', pose: '右侧' },
      { name: '丁', pose: '后方' },
      { name: '戊', pose: '远景路人' }
    ],
    character_names: ['甲', '乙', '丙', '丁', '戊'],
    negative_character_prompts: ['avoid_long_hair', 'avoid_armor']
  });

  assert.equal(result.scene.visual_description, '新描述');
  assert.equal(result.scene.characters.length, 4);
  assert.deepEqual(result.scene.character_names, ['甲', '乙', '丙', '丁']);
  assert.deepEqual(result.scene.negative_character_prompts, ['avoid_long_hair', 'avoid_armor']);

  const saved = JSON.parse(await fs.readFile(path.join(projectDir, 'pipeline_progress.json'), 'utf-8'));
  assert.equal(saved.completed_chapters['第一卷_第一章'].scenes[0].visual_description, '新描述');
  assert.equal(saved.completed_chapters['第一卷_第一章'].scenes[0].characters.length, 4);
  assert.deepEqual(saved.completed_chapters['第一卷_第一章'].scenes[0].negative_character_prompts, ['avoid_long_hair', 'avoid_armor']);
});

test('updateSceneCard clears stale derived context when lightweight scene fields change', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-update-scene-stale-'));
  const projectDir = path.join(outputDir, 'projects', 'scene-stale-test');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'book.txt'),
    '第一卷\n第一章\n\n她抬起了头，看向门外。\n',
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, 'pipeline_progress.json'),
    JSON.stringify({
      completed_chapters: {
        '第一卷_第一章': {
          status: 'generating',
          scenes: [
            {
              scene_idx: 1,
              trigger_sentence: '她抬起了头',
              visual_description: '旧描述',
              core_action: '旧动作',
              environment: '旧环境',
              cinematography: '旧镜头',
              interactions: '旧互动',
              plot_traces: '旧痕迹',
              text_elements: '旧文字',
              must_show: ['old_tag'],
              must_not_show: ['old_negative']
            }
          ]
        }
      },
      global_characters: {},
      character_dna_slices: {},
      pipeline_pause: null
    }, null, 2),
    'utf-8'
  );

  const pipeline = new PipelineManager({ projectName: 'scene-stale-test' });
  pipeline.baseDir = outputDir;
  pipeline.switchProject('scene-stale-test');

  const result = await pipeline.updateSceneCard('第一卷_第一章', 1, {
    trigger_sentence: '她抬起了头',
    visual_description: '新描述',
    core_action: '新动作',
    environment: '旧环境',
    cinematography: '旧镜头',
    interactions: '旧互动',
    plot_traces: '旧痕迹',
    text_elements: '旧文字',
    must_show: ['old_tag'],
    must_not_show: ['old_negative']
  });

  assert.equal(result.scene.environment, '');
  assert.equal(result.scene.cinematography, '');
  assert.equal(result.scene.interactions, '');
  assert.equal(result.scene.plot_traces, '');
  assert.equal(result.scene.text_elements, '');
  assert.deepEqual(result.scene.must_show, []);
  assert.deepEqual(result.scene.must_not_show, []);
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

test('character dna cleanup keeps stable nsfw traits and drops transient ones', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify([{
            name: '女主',
            gender: 'woman',
            role_type: '主角',
            tags: 'long hair, large breasts, erection, pale skin',
            features: {
              外貌标签: ['beautiful'],
              身材标签: ['slim'],
              胸部标签: ['large breasts'],
              NSFW标签: ['large breasts', 'erection'],
              发型标签: ['long hair'],
              发色标签: ['black hair'],
              眼睛标签: ['red eyes'],
              肤色标签: ['pale skin'],
              年龄感标签: ['young woman'],
              服装基底标签: ['white dress'],
              特殊特征标签: []
            },
            evidence: [],
            confidence: 0.9,
            source_chapters: ['第1章']
          }])
        }
      }]
    })
  });

  try {
    const result = await extractor.extractCharacterDNA('测试正文', 'test-model', { knownCharacters: {}, sourceChapters: ['第1章'] });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].features.NSFW标签, ['large breasts']);
    assert.match(result[0].tags, /large breasts/);
    assert.doesNotMatch(result[0].tags, /\berection\b/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normal scene prompt inherits stable nsfw dna traits', () => {
  const result = buildFinalImagePrompt('1girl, 1boy, bedroom, nsfw', {
    sceneCharacters: [
      { name: '甲', gender: 'woman' },
      { name: '乙', gender: 'man' }
    ],
    characterAnchors: [
      {
        name: '甲',
        正面提示词: 'woman, long hair, pale skin',
        结构化特征: {
          外貌标签: ['beautiful'],
          身材标签: ['slim'],
          胸部标签: ['medium breasts'],
          NSFW标签: ['large breasts'],
          发型标签: ['long hair'],
          发色标签: ['black hair'],
          眼睛标签: ['red eyes'],
          肤色标签: ['pale skin'],
          年龄感标签: ['young woman'],
          服装基底标签: [],
          特殊特征标签: []
        }
      },
      {
        name: '乙',
        正面提示词: 'man, short hair',
        结构化特征: {
          外貌标签: ['handsome'],
          身材标签: ['athletic build'],
          胸部标签: [],
          NSFW标签: ['large penis'],
          发型标签: ['short hair'],
          发色标签: ['black hair'],
          眼睛标签: ['dark eyes'],
          肤色标签: ['fair skin'],
          年龄感标签: ['young man'],
          服装基底标签: [],
          特殊特征标签: []
        }
      }
    ],
    useCharacterSegments: false
  });

  assert.match(result.finalPositive, /large breasts/i);
  assert.match(result.finalPositive, /large penis/i);
});

test('portrait composition excludes nsfw dna traits', () => {
  const result = buildFinalImagePrompt('1girl, portrait, upper body', {
    composition: '头像',
    sceneCharacters: [{ name: '甲', gender: 'woman' }],
    characterAnchors: [{
      name: '甲',
      正面提示词: 'woman, long hair, pale skin',
      结构化特征: {
        外貌标签: ['beautiful'],
        身材标签: ['slim'],
        胸部标签: ['huge breasts'],
        NSFW标签: ['huge breasts'],
        发型标签: ['long hair'],
        发色标签: ['black hair'],
        眼睛标签: ['red eyes'],
        肤色标签: ['pale skin'],
        年龄感标签: ['young woman'],
        服装基底标签: [],
        特殊特征标签: []
      }
    }],
    useCharacterSegments: false
  });

  assert.doesNotMatch(result.finalPositive, /huge breasts/i);
});

test('chest close-up can inherit chest-related nsfw dna traits', () => {
  const result = buildFinalImagePrompt('1girl, nsfw', {
    composition: '部位特写',
    sceneType: '胸部',
    sceneCharacters: [{ name: '甲', gender: 'woman' }],
    characterAnchors: [{
      name: '甲',
      正面提示词: 'woman, pale skin',
      结构化特征: {
        外貌标签: ['beautiful'],
        身材标签: ['slim'],
        胸部标签: ['large breasts'],
        NSFW标签: ['huge breasts'],
        发型标签: ['long hair'],
        发色标签: ['black hair'],
        眼睛标签: ['red eyes'],
        肤色标签: ['pale skin'],
        年龄感标签: ['young woman'],
        服装基底标签: [],
        特殊特征标签: []
      }
    }],
    useCharacterSegments: false
  });

  assert.match(result.finalPositive, /large breasts|huge breasts/i);
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

test('final negative prompt includes mosaic globally', () => {
  const result = buildFinalImagePrompt('1girl, bedroom, simple_background', {
    sceneCharacters: [{ name: '女', gender: 'woman' }],
    structuredCharacterPrompts: [{ name: '女', prompt: '1girl, standing', negative_prompt: '' }],
    extraNegative: ''
  });

  assert.match(result.finalNegative, /\bmosaic\b/i);
});

test('multi-character prompts keep scale without forcing interaction composition', () => {
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
  assert.match(balanced.basePrompt, /consistent character scale/);
  assert.match(balanced.basePrompt, /same ground plane/);
  assert.doesNotMatch(balanced.basePrompt, /single unified composition|connected pose/);
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
  assert.match(result.finalPositive, /connected pose/);
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
  assert.doesNotMatch(result.characterPrompts[0], /closed mouth|relaxed lips/);
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
  assert.doesNotMatch(result.characterPrompts[1], /relaxed lips/);
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

  assert.equal(
    extractLlmResponseText([
      'data: {"choices":[{"delta":{"content":"Medical"}}]}',
      'data: {"choices":[{"delta":{"content":" room"}}]}',
      'data: {"choices":[{"delta":{"content":" interior"}}]}',
      'data: [DONE]'
    ].join('\n')),
    'Medical room interior'
  );
});

test('legacy LLM prompt output is rejected without deterministic fallback', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

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

test('advanced prompt asks LLM to self-trim when estimated tokens exceed 460', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let repairPrompt = '';
  const longTail = Array.from({ length: 220 }, (_, index) => `decorative_detail_${index}`).join(', ');

  globalThis.fetch = async (_url, options) => {
    fetchCount++;
    const request = JSON.parse(options.body);
    if (fetchCount === 2) {
      repairPrompt = request.messages.find(message => message.role === 'user')?.content || '';
    }
    const content = fetchCount === 1
      ? JSON.stringify({
          orientation: 'landscape',
          base_prompt: `1girl, forest, sunlight, ${longTail}`,
          character_prompts: [{
            name: '甲',
            prompt: `girl, white_robe, standing, ${longTail}`
          }],
          negative_prompt: ''
        })
      : JSON.stringify({
          orientation: 'landscape',
          base_prompt: '1girl, forest, sunlight',
          character_prompts: [{
            name: '甲',
            prompt: 'girl, white_robe, standing'
          }],
          negative_prompt: ''
        });
    return {
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
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

    assert.equal(fetchCount, 2);
    assert.match(repairPrompt, /超过 460 token|under 460 tokens/i);
    assert.match(result.base_prompt, /forest, sunlight/);
    assert.doesNotMatch(result.base_prompt, /decorative_detail_/);
    assert.equal(result.character_prompts[0].prompt, 'girl, white_robe, standing');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NSFW advanced prompt asks for camera choice and adds light fallback when LLM omits it', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

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

    assert.match(capturedUserMessage, /NSFW (?:透视与机位|镜头机位)/);
    assert.match(capturedUserMessage, /接触点|遮挡层次/);
    assert.match(capturedUserMessage, /不要超过 460 token|must stay within 460 tokens/i);
    assert.match(result.base_prompt, /clear single camera angle/i);
    assert.match(result.base_prompt, /foreground and background separation/i);
    assert.doesNotMatch(result.base_prompt, /dynamic_perspective|depth_of_field/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt receives lightweight scene-card context fields', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

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
              base_prompt: '1girl, rainy street',
              character_prompts: [{
                name: '甲',
                prompt: 'girl, wet_hair, looking_up',
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
    await extractor.generateScenePromptAdvanced({
      visual_description: '她在雨夜抬头看向门外',
      core_action: '她抬头看向门外来人',
      characters: [{ name: '甲', gender: 'woman' }]
    }, [], 'test');

    assert.match(capturedUserMessage, /core_action/);
    assert.doesNotMatch(capturedUserMessage, /source_context/);
    assert.doesNotMatch(capturedUserMessage, /selection_reason/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt tolerates character_prompts count mismatch without hard failure', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    return {
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              orientation: 'square',
              base_prompt: 'empty station platform, cold light',
              character_prompts: [
                { name: '甲', prompt: 'girl, black_hair', negative_prompt: '', interaction_actions: [] },
                { name: '乙', prompt: 'boy, white_shirt', negative_prompt: '', interaction_actions: [] }
              ],
              negative_prompt: ''
            })
          }
        }]
      })
    };
  };

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '空荡站台上只有冷光和风声，没有实际可见人物',
      characters: []
    }, [], 'test');

    assert.equal(result.base_prompt, 'empty station platform, cold light');
    assert.equal(result.character_prompts.length, 2);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('self-directed undressing does not require a target interaction marker on another character', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

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

test('advanced prompt tells LLM to map scene interactions into source and target character prompts', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

  const originalFetch = globalThis.fetch;
  let systemPrompt = '';
  let userPrompt = '';
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    systemPrompt = request.messages.find(message => message.role === 'system')?.content || '';
    userPrompt = request.messages.find(message => message.role === 'user')?.content || '';
    return {
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              orientation: 'square',
              base_prompt: 'A bedroom scene with both characters facing each other.',
              character_prompts: [
                { name: '钰慧', prompt: 'A young woman loosening her clothes with a shy expression.', negative_prompt: '' },
                { name: '阿宾', prompt: 'A young man watching her in tense surprise.', negative_prompt: '' }
              ],
              negative_prompt: ''
            })
          }
        }]
      })
    };
  };

  try {
    await extractor.generateScenePromptAdvanced({
      visual_description: '钰慧在阿宾面前脱衣',
      characters: [
        { name: '钰慧', gender: 'woman' },
        { name: '阿宾', gender: 'man' }
      ],
      interaction_actions: [
        { action: 'undressing', source: '钰慧', target: '阿宾', mutual: false }
      ]
    }, [], 'test');

    assert.match(systemPrompt, /source#|target#|mutual#/i);
    assert.match(userPrompt, /source 和 target/i);
    assert.match(userPrompt, /NovelAI V4/i);
    assert.match(userPrompt, /source#undressing/i);
    assert.match(userPrompt, /target#undressing/i);
    assert.match(userPrompt, /interaction_actions/i);
    assert.match(userPrompt, /"source":\s*"钰慧"/);
    assert.match(userPrompt, /"target":\s*"阿宾"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt validation accepts directional penetration roles', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

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

    assert.equal(result.character_prompts[0].name, '阿宾');
    assert.equal(result.character_prompts[1].name, '王忆如');
    assert.ok(!('interaction_actions' in result.character_prompts[0]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('advanced prompt validation ignores mutual hints for directional sex', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

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
            character_prompts: [
              {
                name: '阿宾',
                prompt: 'boy, short_hair, completely_nude, leaning_forward',
                negative_prompt: ''
              },
              {
                name: '王忆如',
                prompt: 'girl, long_hair, completely_nude, lying_on_back',
                negative_prompt: ''
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

    assert.equal(result.character_prompts[0].name, '阿宾');
    assert.equal(result.character_prompts[1].name, '王忆如');
    assert.equal(result.interaction_actions, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('directional sex actions add natural language interaction context without role markers', () => {
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

  assert.match(result.characterPrompts[0], /receives sex from the man on the right/i);
  assert.match(result.characterPrompts[1], /performs sex on the woman on the left/i);
  assert.doesNotMatch(result.characterPrompts.join(' '), /(?:source|target|mutual)#/);
});

test('directional sex actions ignore mutual hints in natural language context', () => {
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

  assert.match(result.characterPrompts[0], /receives sex from the man on the right/i);
  assert.match(result.characterPrompts[1], /performs sex on the woman on the left/i);
  assert.doesNotMatch(result.characterPrompts.join(' '), /(?:source|target|mutual)#/);
});

test('penetration scenes only keep inset xray guidance when explicitly requested', () => {
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

  const ordinaryPenetrationResult = buildFinalImagePrompt('1girl, 1boy, bedroom, sex', {
    sceneCharacters: [
      { name: '钰慧', gender: 'woman', position: 'left' },
      { name: '阿宾', gender: 'man', position: 'right' }
    ],
    sceneInteractions: '阿宾将性器官插入钰慧体内',
    sceneInteractionActions: [
      { action: 'penetration', source: '阿宾', target: '钰慧', mutual: false }
    ],
    sceneDescription: '阿宾与钰慧发生明确插入性交，普通外视角能看清双方姿态。',
    sceneNsfwRating: 'nsfw_explicit'
  });

  assert.doesNotMatch(ordinaryPenetrationResult.basePrompt, /magnified inset/i);
  assert.match(ordinaryPenetrationResult.finalNegative, /comic panel/i);

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
  assert.match(result.characterPrompts[0], /performs penetration on the woman in the center/i);
  assert.match(result.characterPrompts[0], /woman in the center/);
  assert.match(result.characterPrompts[1], /receives penetration from the man on the left/i);
  assert.match(result.characterPrompts[1], /receives sucking nipple from the woman on the right/i);
  assert.match(result.characterPrompts[1], /man on the left/);
  assert.match(result.characterPrompts[1], /woman on the right/);
  assert.match(result.characterPrompts[2], /performs sucking nipple on the woman in the center/i);
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

test('NAI generateImage does not restart cooldown after a successful submission', async () => {
  const client = new NovelAIClient({
    token: 'test-token',
    baseUrl: 'https://image.novelai.net',
    cooldownSeconds: 0
  });
  const originalFetch = globalThis.fetch;
  const originalWaitForCooldown = globalCooldownManager.waitForCooldown;
  const originalStartCooldown = globalCooldownManager.startCooldown;
  let startCooldownCount = 0;
  globalCooldownManager.waitForCooldown = async () => {};
  globalCooldownManager.startCooldown = () => { startCooldownCount += 1; };
  globalThis.fetch = async () => ({
    status: 200,
    arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer
  });

  try {
    await client.generateImage('1girl, indoors', {
      model: 'nai-diffusion-4-5-full'
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalCooldownManager.waitForCooldown = originalWaitForCooldown;
    globalCooldownManager.startCooldown = originalStartCooldown;
  }

  assert.equal(startCooldownCount, 0);
});

test('LLM 429 retries use exponential backoff delays', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits = [];
  let callCount = 0;

  globalThis.setTimeout = (callback, ms, ...args) => {
    waits.push(ms);
    callback(...args);
    return 0;
  };
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount <= 2) {
      return {
        status: 429,
        text: async () => 'rate limited'
      };
    }
    return {
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.close();
        }
      }),
      headers: { get: () => 'text/event-stream' }
    };
  };

  try {
    const res = await postChatCompletionWith429Retry({
      url: 'https://example.invalid/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'test', messages: [] },
      max429Retries: 5,
      initialDelaySeconds: 10
    });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(waits, [10000, 20000]);
});

test('LLM requests preserve original wording without sensitive-term replacement', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = '';

  globalThis.fetch = async (_url, options) => {
    capturedBody = options.body;
    return {
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.close();
        }
      }),
      headers: { get: () => 'text/event-stream' }
    };
  };

  try {
    await postChatCompletionWith429Retry({
      url: 'https://example.invalid/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'test',
        messages: [
          { role: 'user', content: '阴道 肛门 性交 高潮 精液' }
        ]
      },
      max429Retries: 0,
      initialDelaySeconds: 10
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(capturedBody, /阴道/);
  assert.match(capturedBody, /肛门/);
  assert.match(capturedBody, /性交/);
  assert.match(capturedBody, /高潮/);
  assert.match(capturedBody, /精液/);
  assert.doesNotMatch(capturedBody, /生理通道|生理后庭|生理交合|生理高潮|生理流体/);
});

test('LLM streaming response fails only after idle timeout', async () => {
  let pendingReject = null;
  const response = {
    body: {
      getReader() {
        return {
          read() {
            return new Promise((_, reject) => {
              pendingReject = reject;
            });
          },
          cancel(reason) {
            pendingReject?.(reason);
            return Promise.resolve();
          }
        };
      }
    }
  };

  await assert.rejects(
    readLlmResponse(response, { idleTimeoutMs: 20 }),
    error => error?.code === 'LLM_STREAM_IDLE_TIMEOUT'
  );
});

test('LLM streaming response may exceed idle timeout window in total as long as chunks keep arriving', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\n`),
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}\n\n`),
    encoder.encode('data: [DONE]\n\n')
  ];
  let index = 0;
  const response = {
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) {
              return { done: true, value: undefined };
            }
            await new Promise(resolve => setTimeout(resolve, 25));
            return { done: false, value: chunks[index++] };
          },
          cancel() {
            return Promise.resolve();
          }
        };
      }
    }
  };

  const { content } = await readLlmResponse(response, { idleTimeoutMs: 40 });
  assert.equal(content, 'AB');
});

test('LLM streaming response emits incremental stream text chunks', async () => {
  const encoder = new TextEncoder();
  const events = [
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`),
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`),
    encoder.encode('data: [DONE]\n\n')
  ];
  let index = 0;
  const chunks = [];
  const response = {
    body: {
      getReader() {
        return {
          async read() {
            if (index >= events.length) {
              return { done: true, value: undefined };
            }
            return { done: false, value: events[index++] };
          },
          cancel() {
            return Promise.resolve();
          }
        };
      }
    }
  };

  const { content } = await readLlmResponse(response, {
    idleTimeoutMs: 40,
    onStreamText: chunk => chunks.push(chunk)
  });

  assert.equal(content, 'Hello world');
  assert.deepEqual(chunks, ['Hello', 'world']);
});

test('NAI 429 retries use exponential backoff before degraded mode', async () => {
  const client = new NovelAIClient({
    token: 'test-token',
    baseUrl: 'https://image.novelai.net'
  });
  const originalFetch = globalThis.fetch;
  const originalWaitForCooldown = globalCooldownManager.waitForCooldown;
  const originalStartCooldown = globalCooldownManager.startCooldown;
  const originalSetTimeout = globalThis.setTimeout;
  const originalState = {
    baseCooldownSeconds: globalCooldownManager.baseCooldownSeconds,
    degradedCooldownSeconds: globalCooldownManager.degradedCooldownSeconds,
    cooldownSeconds: globalCooldownManager.cooldownSeconds,
    activeCooldownSeconds: globalCooldownManager.activeCooldownSeconds,
    mode: globalCooldownManager.mode,
    consecutive429: globalCooldownManager.consecutive429,
    degradedSuccesses: globalCooldownManager.degradedSuccesses,
    lastGenerationTime: globalCooldownManager.lastGenerationTime
  };
  const waits = [];
  let callCount = 0;

  globalCooldownManager.baseCooldownSeconds = 15;
  globalCooldownManager.degradedCooldownSeconds = 35;
  globalCooldownManager.cooldownSeconds = 15;
  globalCooldownManager.activeCooldownSeconds = 15;
  globalCooldownManager.mode = 'normal';
  globalCooldownManager.consecutive429 = 0;
  globalCooldownManager.degradedSuccesses = 0;
  globalCooldownManager.lastGenerationTime = 0;
  globalCooldownManager.waitForCooldown = async () => {};
  globalCooldownManager.startCooldown = () => {};
  globalThis.setTimeout = (callback, ms, ...args) => {
    waits.push(ms);
    callback(...args);
    return 0;
  };
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount <= 2) {
      return {
        status: 429,
        text: async () => 'rate limited'
      };
    }
    return {
      status: 200,
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    };
  };

  try {
    const result = await client.generateImage('1girl, indoors', {
      model: 'nai-diffusion-4-5-full'
    });
    assert.equal(result.mimeType, 'image/png');
  } finally {
    globalThis.fetch = originalFetch;
    globalCooldownManager.waitForCooldown = originalWaitForCooldown;
    globalCooldownManager.startCooldown = originalStartCooldown;
    globalThis.setTimeout = originalSetTimeout;
    globalCooldownManager.baseCooldownSeconds = originalState.baseCooldownSeconds;
    globalCooldownManager.degradedCooldownSeconds = originalState.degradedCooldownSeconds;
    globalCooldownManager.cooldownSeconds = originalState.cooldownSeconds;
    globalCooldownManager.activeCooldownSeconds = originalState.activeCooldownSeconds;
    globalCooldownManager.mode = originalState.mode;
    globalCooldownManager.consecutive429 = originalState.consecutive429;
    globalCooldownManager.degradedSuccesses = originalState.degradedSuccesses;
    globalCooldownManager.lastGenerationTime = originalState.lastGenerationTime;
  }

  assert.deepEqual(waits, [15000, 30000]);
});

test('V4.5 prompt budget keeps interaction and identity phrases under the shared limit', () => {
  const filler = Array.from({ length: 250 }, (_, index) => `decorative_detail_${index}`).join(', ');
  const budgeted = enforceV45PromptBudget(
    `1girl, 1boy, exactly_two_characters, ${filler}`,
    [
      `girl, blonde_hair, blue_eyes, performs hug on the man on the right, ${filler}`,
      `boy, black_hair, red_eyes, receives hug from the woman on the left, ${filler}`
    ],
    460
  );

  assert.ok(budgeted.estimatedTokens <= 460);
  assert.match(budgeted.basePrompt, /exactly_two_characters/);
  assert.match(budgeted.characterPrompts[0], /performs hug/);
  assert.match(budgeted.characterPrompts[1], /receives hug/);
});

test('V4.5 prompt budget preserves artist style prompt under the shared limit', () => {
  const filler = Array.from({ length: 240 }, (_, index) => `scene_detail_${index}`).join(', ');
  const result = buildFinalImagePrompt(`1girl, 1boy, exactly_two_characters, ${filler}`, {
    sceneCharacters: [{ name: '甲', gender: 'woman' }, { name: '乙', gender: 'man' }],
    structuredCharacterPrompts: [
      { name: '甲', prompt: `girl, pale_skin, long_hair, white_dress, ${filler}` },
      { name: '乙', prompt: `boy, black_hair, school_uniform, ${filler}` }
    ],
    artistStylePrompt: '1.3::artist:youngjoo kjy ::, artist:nardack, artist:rella, cinematic lighting',
    useNaturalLanguage: false,
    useCharacterSegments: false
  });

  assert.match(result.basePrompt, /artist:youngjoo kjy/);
  assert.match(result.basePrompt, /artist:nardack/);
  assert.match(result.basePrompt, /artist:rella/);
});

test('V4.5 token estimator stays close to NovelAI web count for mixed natural language prompts', () => {
  const basePrompt = `3girls, 3boys, Laboratory interior with cool fluorescent light. Symmetric composition: three girls bent over in rear compartments, three boys standing in front. Convex lenses reflect buttocks, mirrors show faces. Viewed from slightly elevated front angle, with clear foreground/background depth. nsfw, explicit. The main scene shows a full external view. A single magnified inset reveals vaginal penetration in cross-section, focusing on one couple., three-quarter_view, dynamic_perspective, depth_of_field, consistent character scale, same ground plane., single unified three-character composition, distinct left center right staging, readable interaction graph, single unified composition, shared central action, overlapping silhouettes, connected pose., single magnified inset showing cross-section penetration focus., single coherent image., 1.3::masterpiece, best quality ::, official art, year2024, year2025, 1.3::artist:youngjoo kjy ::, artist:nardack, artist:rella, artist:qiandaiyiyu, artist:atdan, artist:void_0, artist:stu_dts, artist:wo_jiushi_kanbudong, artist:nixeu, -3::3D ::, rim lighting, deep shadows, high contrast, no text`;
  const characterPrompts = [
    `1girl, exposing curly pubic hair. Bent over presenting hindquarters, expression blank with lips pressed., average height, receives vaginal penetration from the man in front`,
    `1boy, Black-haired lean boy with aristocratic features. Pants off, penis erect. Heavy breathing, burning gaze fixed on red-dressed woman, standing ready., slightly shorter, performs vaginal penetration on the woman behind`,
    `1girl, lower body nude. Bent over presenting hindquarters, slight smile on lips., slightly taller, receives vaginal penetration from the man in front`,
    `1boy, Short black-haired boy with average build. Shirt on, pants removed exposing erect penis. Standing with focused excited expression, preparing to penetrate., determined, focused eyes, firm expression, average height, performs vaginal penetration on the woman behind`,
    `1girl, Black-haired young woman with dark eyes, lower body exposed. Bent over presenting hindquarters, resigned frown on brow., average height, receives vaginal penetration from the man in front`,
    `1boy, Brown-haired stocky boy with large penis fully erect. Pants removed. Heavy breath, eager expression, standing with penis aimed forward., average height, performs vaginal penetration on the woman behind`
  ];

  const estimated = estimateV45Tokens([basePrompt, ...characterPrompts].join(', '));

  assert.ok(estimated >= 590, `expected estimator >= 590, got ${estimated}`);
  assert.ok(estimated <= 625, `expected estimator <= 625, got ${estimated}`);
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
  assert.doesNotMatch(result.characterPrompts.join(' '), /(?:source|target|mutual)#/);
  assert.match(result.characterPrompts[0], /performs hug on the man on the right from the left/);
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

test('scene prompt preparation continues while the NAI queue is still rendering', async () => {
  const pipeline = new PipelineManager({ projectName: 'parallel-single-chapter-test' });
  const events = [];
  let releaseFirstNai;
  const firstNaiStarted = new Promise(resolve => {
    pipeline.__resolveFirstNaiStarted = resolve;
  });
  const secondPromptStarted = new Promise(resolve => {
    pipeline.__resolveSecondPromptStarted = resolve;
  });
  const scenes = [
    { scene_idx: 1, status: 'PENDING', visual_description: '场景一' },
    { scene_idx: 2, status: 'PENDING', visual_description: '场景二' }
  ];

  pipeline.isRunning = true;
  pipeline.projBase = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-parallel-queue-'));
  pipeline.projectProgress = {
    setChapterStatus() {},
    save: async () => {}
  };
  pipeline.runPriorityJobs = async () => {
    await new Promise(resolve => setImmediate(resolve));
  };
  pipeline._runNaiConsumerLinear = async (naiQueue, isLlmDone, naiModel) => {
    while (!isLlmDone() || naiQueue.length > 0) {
      if (naiQueue.length === 0) {
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }
      const { chap, scene, scenes: chapterScenes, chapKey } = naiQueue.shift();
      await pipeline.generateSingleSceneFromPrompt(chap, scene, chapterScenes, chapKey, naiModel);
    }
  };
  pipeline.prepareSingleScenePrompt = async (_chap, scene) => {
    events.push(`prompt-${scene.scene_idx}`);
    if (scene.scene_idx === 2) pipeline.__resolveSecondPromptStarted();
    scene.prepared_prompt = { finalPositive: `prompt ${scene.scene_idx}` };
    scene.status = 'PROMPT_READY';
  };
  pipeline.generateSingleSceneFromPrompt = async (_chap, scene) => {
    events.push(`nai-${scene.scene_idx}`);
    if (scene.scene_idx === 1) {
      pipeline.__resolveFirstNaiStarted();
      await new Promise(resolve => {
        releaseFirstNai = resolve;
      });
    }
    scene.status = 'SUCCESS';
  };

  try {
    const runPromise = pipeline._prepareScenesAndRunNaiQueue(
      { chapter: '测试章', content: '正文' },
      scenes,
      scenes,
      '测试章',
      'test-llm',
      'nai-diffusion-4-5-full'
    );

    await firstNaiStarted;
    await secondPromptStarted;

    assert.ok(
      events.indexOf('prompt-2') > events.indexOf('nai-1'),
      `expected second prompt after first NAI started, got ${events.join(',')}`
    );
    assert.equal(scenes[1].status, 'PROMPT_READY');

    releaseFirstNai();
    await runPromise;
    assert.deepEqual(scenes.map(scene => scene.status), ['SUCCESS', 'SUCCESS']);
  } finally {
    pipeline.isRunning = false;
    await fs.rm(pipeline.projBase, { recursive: true, force: true });
  }
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
