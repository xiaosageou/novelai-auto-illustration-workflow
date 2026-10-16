import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeCharacterDnaEntry } from '../services/llm-extractor.js';
import { 构建角色锚点注入提示词 } from '../services/prompt-builder.js';
import { DEFAULT_CHARACTER_DNA_PROMPT } from '../utils/default-prompts.js';

test('DEFAULT_CHARACTER_DNA_PROMPT contains exact age or adult instruction', () => {
  assert.ok(DEFAULT_CHARACTER_DNA_PROMPT.includes('年龄标签'));
  assert.ok(DEFAULT_CHARACTER_DNA_PROMPT.includes('知道几岁就写确定的岁数'));
  assert.ok(DEFAULT_CHARACTER_DNA_PROMPT.includes('不知道具体岁数就写成年 adult'));
});

test('LLM Extractor post-processing defaults missing age to adult', () => {
  const rawCharacters = [
    {
      name: '林月',
      gender: 'girl',
      features: {
        '外貌标签': ['beautiful'],
        '发色标签': ['black_hair']
      }
    },
    {
      name: '苏云',
      gender: 'boy',
      features: {
        '外貌标签': ['handsome'],
        '年龄标签': ['20yo']
      }
    },
    {
      name: '柳青',
      gender: 'woman',
      features: {
        '外貌标签': ['mature'],
        '年龄感标签': ['mature female']
      }
    }
  ];

  const processed = rawCharacters.map(c => sanitizeCharacterDnaEntry(c));

  // 林月没有填年龄 -> 默认兜底 adult
  assert.deepEqual(processed[0].features['年龄标签'], ['adult']);
  // 苏云有确定岁数 20yo -> 保留 20yo
  assert.deepEqual(processed[1].features['年龄标签'], ['20yo']);
  // 柳青有旧数据 年龄感标签 -> 迁移至 年龄标签
  assert.deepEqual(processed[2].features['年龄标签'], ['mature female']);
});

test('构建角色锚点注入提示词 includes age tags from character features', () => {
  const anchor = {
    角色名: '林月',
    性别: 'girl',
    正面提示词: 'black hair',
    结构化特征: {
      '外貌标签': ['beautiful'],
      '发色标签': ['black hair'],
      '年龄标签': ['18yo']
    }
  };

  const injected = 构建角色锚点注入提示词(anchor, { mode: 'avatar' });
  assert.ok(injected.includes('18yo'), `Injected prompt should include age tag, got: ${injected}`);
});

test('Scene readiness logic correctly identifies scenes waiting for render', () => {
  const isSceneReadyForRender = (scene) => {
    if (!scene) return false;
    const hasPrompt = Boolean(
      scene.final_prompt?.trim() ||
      scene.prepared_prompt?.finalPositive?.trim() ||
      scene.prepared_prompt?.basePrompt?.trim()
    );
    const needsRender = !scene.image_path || scene.image_path === 'failed' || scene.status !== 'SUCCESS';
    return hasPrompt && needsRender;
  };

  // 1. 已有 prompt 且等待生图
  assert.equal(isSceneReadyForRender({
    status: 'PROMPT_READY',
    prepared_prompt: { finalPositive: '1girl, masterpiece' },
    image_path: null
  }), true);

  // 2. 已生图成功 -> 不需要生图
  assert.equal(isSceneReadyForRender({
    status: 'SUCCESS',
    final_prompt: '1girl, masterpiece',
    image_path: 'illustrations/test.png'
  }), false);

  // 3. 失败场景但有已保存的 prompt -> 属于待生图
  assert.equal(isSceneReadyForRender({
    status: 'FAILED',
    prepared_prompt: { basePrompt: '1girl, outdoors' },
    image_path: 'failed'
  }), true);

  // 4. 只有分镜描述，尚未生成 Prompt -> 无法仅生图
  assert.equal(isSceneReadyForRender({
    status: 'PENDING',
    visual_description: '一个女孩站在庭院中',
    image_path: null
  }), false);
});

test('updateSceneCard preserves sex_position and does not wipe derived fields', async () => {
  const { PipelineManager } = await import('../services/pipeline-manager.js');
  const os = await import('os');
  const path = await import('path');
  const { promises: fs } = await import('fs');

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-update-pos-test-'));
  const projectDir = path.join(outputDir, 'projects', 'pos-test');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'book.txt'),
    '第一卷\n第一章\n\n正文测试。\n',
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
              trigger_sentence: '正文测试',
              visual_description: '两人相拥',
              core_action: '相拥',
              sex_position: '',
              nsfw_rating: 'sfw',
              environment: '寝殿大床',
              cinematography: '侧面特写',
              interactions: '紧紧相拥',
              characters: [{ name: '林月', gender: 'girl', clothing: '白丝睡裙' }],
              must_show: ['bed'],
              must_not_show: ['text']
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

  const pipeline = new PipelineManager({ projectName: 'pos-test' });
  pipeline.baseDir = outputDir;
  pipeline.switchProject('pos-test');

  // 更新体位为 四足后入
  const result = await pipeline.updateSceneCard('第一卷_第一章', 1, {
    sex_position: '四足后入',
    nsfw_rating: 'nsfw_explicit'
  });

  assert.equal(result.scene.sex_position, '四足后入');
  assert.equal(result.scene.nsfw_rating, 'nsfw_explicit');
  // 关键：环境、镜头、角色、必须包含不得被意外清空
  assert.equal(result.scene.environment, '寝殿大床');
  assert.equal(result.scene.cinematography, '侧面特写');
  assert.equal(result.scene.interactions, '紧紧相拥');
  assert.equal(result.scene.characters.length, 1);
  assert.equal(result.scene.characters[0].name, '林月');
  assert.deepEqual(result.scene.must_show, ['bed']);
});

