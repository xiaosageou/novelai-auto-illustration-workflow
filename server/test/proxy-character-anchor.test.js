import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { sanitizeCharacterDnaEntry, LLMExtractor } from '../services/llm-extractor.js';
import { ProjectProgress } from '../utils/db.js';
import { normalizeCharacterDnaPromptForConfig } from '../utils/advanced-prompt-contract.js';
import { DEFAULT_CHARACTER_DNA_PROMPT } from '../utils/default-prompts.js';

test('sanitizeCharacterDnaEntry parses and normalizes proxy_character', () => {
  const rawEntry = {
    name: '林月如',
    gender: 'girl',
    features: {
      '发型发色标签': ['long hair', 'brown hair', 'ponytail']
    },
    proxy_character: {
      danbooru_tag: '  Asuka_Langley_Soryu  ',
      character_name_cn: '惣流·明日香·兰格雷',
      series: '新世纪福音战士',
      reason: '傲娇好胜性格、高马尾、红褐色长发',
      suppress_tags: 'plugsuit, hair_clips, school_uniform'
    }
  };

  const sanitized = sanitizeCharacterDnaEntry(rawEntry);
  assert.ok(sanitized.proxy_character, 'proxy_character should be preserved');
  assert.equal(sanitized.proxy_character.danbooru_tag, 'asuka_langley_soryu', 'danbooru tag normalized');
  assert.equal(sanitized.proxy_character.character_name_cn, '惣流·明日香·兰格雷');
  assert.equal(sanitized.proxy_character.series, '新世纪福音战士');
  assert.deepEqual(sanitized.proxy_character.suppress_tags, ['plugsuit', 'hair_clips', 'school_uniform'], 'suppress_tags converted to array');
});

test('sanitizeCharacterDnaEntry returns null for invalid proxy_character', () => {
  const entryNoTag = {
    name: '测试路人',
    gender: 'man',
    proxy_character: {
      danbooru_tag: '   ',
      reason: '无匹配'
    }
  };
  const sanitized = sanitizeCharacterDnaEntry(entryNoTag);
  assert.equal(sanitized.proxy_character, null, 'invalid proxy_character becomes null');
});

test('db character proxy persistence and setCharacterDNAProxy', async () => {
  const originalGetProjectDir = path.resolve('./server/test/fixtures/tmp_proxy_proj');
  if (!fs.existsSync(originalGetProjectDir)) {
    fs.mkdirSync(originalGetProjectDir, { recursive: true });
  }

  // 初始化假数据
  const progressFilePath = path.join(originalGetProjectDir, 'pipeline_progress.json');
  fs.writeFileSync(progressFilePath, JSON.stringify({
    global_characters: {
      '穹妹': {
        name: '穹妹',
        gender: 'girl',
        features: { '发型发色标签': ['silver hair', 'twintails'] },
        proxy_character: {
          danbooru_tag: 'kasugano_sora',
          character_name_cn: '春日野穹',
          series: '缘之空',
          reason: '银白双马尾与病娇柔弱',
          suppress_tags: ['black_dress']
        }
      }
    }
  }, null, 2), 'utf8');

  try {
    const db = new ProjectProgress(originalGetProjectDir);
    await db.load();
    let chars = db.getGlobalCharacters();
    assert.equal(chars['穹妹'].proxy_character.danbooru_tag, 'kasugano_sora');

    // 测试 setCharacterDNAProxy 更新
    await db.setCharacterDNAProxy('穹妹', {
      danbooru_tag: 'frieren',
      character_name_cn: '芙莉莲',
      series: '葬送的芙莉莲',
      reason: '白发双马尾精灵',
      suppress_tags: ['striped_scarf', 'capelet']
    });

    chars = db.getGlobalCharacters();
    assert.equal(chars['穹妹'].proxy_character.danbooru_tag, 'frieren');
    assert.deepEqual(chars['穹妹'].proxy_character.suppress_tags, ['striped_scarf', 'capelet']);

    // 测试清空脸模
    await db.setCharacterDNAProxy('穹妹', null);
    chars = db.getGlobalCharacters();
    assert.equal(chars['穹妹'].proxy_character, null);
  } finally {
    if (fs.existsSync(progressFilePath)) {
      fs.unlinkSync(progressFilePath);
    }
    if (fs.existsSync(originalGetProjectDir)) {
      fs.rmdirSync(originalGetProjectDir);
    }
  }
});

test('generateScenePromptAdvanced includes proxy character instructions in characterContext', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUserMessage = null;

  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/chat/completions')) {
      const payload = JSON.parse(options.body);
      capturedUserMessage = payload.messages?.[1]?.content || '';
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: [
                '/thinking/',
                'test thinking',
                '/thinking/',
                '/JSON/',
                JSON.stringify({
                  orientation: 'portrait',
                  base_prompt: '1girl, indoors, bedroom, night',
                  character_prompts: [
                    { name: '穹妹', prompt: 'girl, kasugano_sora, silver hair, twintails, white nightgown' }
                  ],
                  negative_prompt: 'black_dress, hair_ornament'
                }),
                '/JSON/'
              ].join('\n')
            }
          }
        ]
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(url, options);
  };

  try {
    const sceneCard = {
      scene_idx: 1,
      trigger_sentence: '少女坐在床边静静看着窗外。',
      visual_description: '银发双马尾少女坐在卧室床边，身穿白色睡裙。',
      characters: [
        {
          name: '穹妹',
          gender: 'girl',
          appearance: 'silver hair, twintails',
          clothing: 'white nightgown',
          expression: 'melancholic',
          pose: 'sitting on bed',
          position: 'center'
        }
      ]
    };

    const characterAnchors = [
      {
        name: '穹妹',
        gender: 'girl',
        features: {
          '发型发色标签': ['silver hair', 'twintails'],
          '瞳色标签': ['black eyes']
        },
        proxy_character: {
          danbooru_tag: 'kasugano_sora',
          character_name_cn: '春日野穹',
          series: '缘之空',
          reason: '银白双马尾与病娇纤细外貌高度吻合',
          suppress_tags: ['black_dress', 'hair_ornament']
        }
      }
    ];

    const extractor = new LLMExtractor({
      baseUrl: 'http://localhost:11434',
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false
    });
    const result = await extractor.generateScenePromptAdvanced(sceneCard, characterAnchors);
    assert.ok(result, 'advanced generation should succeed');
    assert.ok(capturedUserMessage, 'user message was captured');
    assert.ok(capturedUserMessage.includes('kasugano_sora'), 'proxy character danbooru tag included in context');
    assert.ok(capturedUserMessage.includes('春日野穹'), 'proxy character Chinese name included in context');
    assert.ok(capturedUserMessage.includes('black_dress, hair_ornament'), 'suppress_tags included in context');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizeCharacterDnaPromptForConfig upgrades legacy prompt to DEFAULT_CHARACTER_DNA_PROMPT', () => {
  const legacyPrompt = `
  [系统指令] 你现在不是一个 AI 聊天助手。你的身份是一位服务于顶级日本动漫出版社的「资深角色设定美术总监」...
  角色设定 DNA 资料表
  输出格式：
  [ { "name": "角色名", "tags": "..." } ]
  `;
  const result = normalizeCharacterDnaPromptForConfig(legacyPrompt);
  assert.equal(result, DEFAULT_CHARACTER_DNA_PROMPT, 'legacy default prompt should be upgraded to current DEFAULT_CHARACTER_DNA_PROMPT');
  assert.ok(result.includes('proxy_character'), 'upgraded prompt must include proxy_character');
  assert.ok(result.includes('同人动漫角色脸模代理'), 'upgraded prompt must include 同人动漫角色脸模代理');
});

test('normalizeCharacterDnaPromptForConfig preserves modern prompt with proxy_character', () => {
  const modernPrompt = `
  自定义提示词
  同人动漫角色脸模代理
  "proxy_character": { "danbooru_tag": "asuka" }
  `;
  const result = normalizeCharacterDnaPromptForConfig(modernPrompt);
  assert.equal(result, modernPrompt.trim());
});

test('normalizeCharacterDnaPromptForConfig appends proxy anchor contract to custom prompt missing it', () => {
  const customPrompt = `
  你是一个自制助手，请提取角色 tags。
  `;
  const result = normalizeCharacterDnaPromptForConfig(customPrompt);
  assert.ok(result.includes('同人动漫角色脸模代理'), 'must append proxy anchor');
  assert.ok(result.includes('"proxy_character"'), 'must include proxy_character schema');
});

