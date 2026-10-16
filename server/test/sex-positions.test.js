import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_SEX_POSITIONS, STANDARD_SEX_POSITION_NAMES, findSexPosition } from '../utils/sex-positions.js';
import { normalizeSceneCard } from '../utils/scene-structure.js';
import { LLMExtractor } from '../services/llm-extractor.js';

test('STANDARD_SEX_POSITIONS contains exactly 26 well-defined positions', () => {
  assert.equal(STANDARD_SEX_POSITIONS.length, 26);
  assert.equal(STANDARD_SEX_POSITION_NAMES.length, 26);

  const expectedNames = [
    '传教士位', '种付位', '四足后入', '俯卧后入', '正向骑乘',
    '反向骑乘', '面对面对坐', '背向坐身', '站立后入', '单腿站立',
    '正向火车便当', '逆向火车便当', '汤匙侧卧', '侧卧提腿', '倒栽折叠位',
    '手交侍奉', '口交侍奉', '舔阴侍奉', '乳交侍奉', '足交侍奉',
    '股间素股', '69式互侍', '双女侍奉', '双男夹击', '群芳簇拥', '群像围攻'
  ];

  for (const name of expectedNames) {
    assert.ok(STANDARD_SEX_POSITION_NAMES.includes(name), `Missing position name: ${name}`);
    const pos = STANDARD_SEX_POSITIONS.find(p => p.name === name);
    assert.ok(pos, `Position ${name} not found`);
    assert.ok(pos.prompt && pos.prompt.length > 20, `Position ${name} prompt is too short`);
    assert.ok(pos.aliases && pos.aliases.length >= 2, `Position ${name} has insufficient aliases`);
  }
});

test('findSexPosition resolves exact names, English aliases, and fuzzy keywords', () => {
  // Exact names (Core 15)
  assert.equal(findSexPosition('传教士位')?.id, 'missionary');
  assert.equal(findSexPosition('种付位')?.id, 'mating_press');
  assert.equal(findSexPosition('四足后入')?.id, 'doggystyle');
  assert.equal(findSexPosition('俯卧后入')?.id, 'prone_bone');
  assert.equal(findSexPosition('正向骑乘')?.id, 'cowgirl');
  assert.equal(findSexPosition('反向骑乘')?.id, 'reverse_cowgirl');
  assert.equal(findSexPosition('面对面对坐')?.id, 'lap_sitting');
  assert.equal(findSexPosition('背向坐身')?.id, 'reverse_lap');
  assert.equal(findSexPosition('站立后入')?.id, 'standing_doggystyle');
  assert.equal(findSexPosition('单腿站立')?.id, 'one_leg_lift');
  assert.equal(findSexPosition('正向火车便当')?.id, 'suspended_congress');
  assert.equal(findSexPosition('逆向火车便当')?.id, 'reverse_suspended');
  assert.equal(findSexPosition('汤匙侧卧')?.id, 'spooning');
  assert.equal(findSexPosition('侧卧提腿')?.id, 'side_split');
  assert.equal(findSexPosition('倒栽折叠位')?.id, 'piledriver');

  // Exact names (Services 7 & Group 4)
  assert.equal(findSexPosition('手交侍奉')?.id, 'handjob');
  assert.equal(findSexPosition('口交侍奉')?.id, 'fellatio');
  assert.equal(findSexPosition('舔阴侍奉')?.id, 'cunnilingus');
  assert.equal(findSexPosition('乳交侍奉')?.id, 'paizuri');
  assert.equal(findSexPosition('足交侍奉')?.id, 'footjob');
  assert.equal(findSexPosition('股间素股')?.id, 'sumata');
  assert.equal(findSexPosition('69式互侍')?.id, 'sixty_nine');
  assert.equal(findSexPosition('双女侍奉')?.id, 'threesome_ffm');
  assert.equal(findSexPosition('双男夹击')?.id, 'threesome_mmf');
  assert.equal(findSexPosition('群芳簇拥')?.id, 'group_harem');
  assert.equal(findSexPosition('群像围攻')?.id, 'group_gangbang');

  // Aliases & English
  assert.equal(findSexPosition('missionary')?.id, 'missionary');
  assert.equal(findSexPosition('mating press')?.id, 'mating_press');
  assert.equal(findSexPosition('doggystyle')?.id, 'doggystyle');
  assert.equal(findSexPosition('狗趴')?.id, 'doggystyle');
  assert.equal(findSexPosition('趴在床上后入')?.id, 'prone_bone');
  assert.equal(findSexPosition('骑乘位')?.id, 'cowgirl');
  assert.equal(findSexPosition('反骑乘')?.id, 'reverse_cowgirl');
  assert.equal(findSexPosition('树袋熊坐位')?.id, 'lap_sitting');
  assert.equal(findSexPosition('椅子后入坐位')?.id, 'reverse_lap');
  assert.equal(findSexPosition('按在墙上后入')?.id, 'standing_doggystyle');
  assert.equal(findSexPosition('扶墙提腿')?.id, 'one_leg_lift');
  assert.equal(findSexPosition('火车便当')?.id, 'suspended_congress');
  assert.equal(findSexPosition('反向火车便当')?.id, 'reverse_suspended');
  assert.equal(findSexPosition('勺子位')?.id, 'spooning');
  assert.equal(findSexPosition('侧卧一字马')?.id, 'side_split');
  assert.equal(findSexPosition('倒栽葱')?.id, 'piledriver');
  assert.equal(findSexPosition('折叠打桩')?.id, 'piledriver');

  // New Services & Group Aliases
  assert.equal(findSexPosition('handjob')?.id, 'handjob');
  assert.equal(findSexPosition('撸管')?.id, 'handjob');
  assert.equal(findSexPosition('fellatio')?.id, 'fellatio');
  assert.equal(findSexPosition('blowjob')?.id, 'fellatio');
  assert.equal(findSexPosition('深喉')?.id, 'fellatio');
  assert.equal(findSexPosition('cunnilingus')?.id, 'cunnilingus');
  assert.equal(findSexPosition('口部承欢')?.id, 'cunnilingus');
  assert.equal(findSexPosition('paizuri')?.id, 'paizuri');
  assert.equal(findSexPosition('夹胸')?.id, 'paizuri');
  assert.equal(findSexPosition('footjob')?.id, 'footjob');
  assert.equal(findSexPosition('玉足侍奉')?.id, 'footjob');
  assert.equal(findSexPosition('sumata')?.id, 'sumata');
  assert.equal(findSexPosition('腿间摩擦')?.id, 'sumata');
  assert.equal(findSexPosition('69式')?.id, 'sixty_nine');
  assert.equal(findSexPosition('sixty-nine')?.id, 'sixty_nine');
  assert.equal(findSexPosition('双飞')?.id, 'threesome_ffm');
  assert.equal(findSexPosition('2女1男')?.id, 'threesome_ffm');
  assert.equal(findSexPosition('双龙')?.id, 'threesome_mmf');
  assert.equal(findSexPosition('1女2男')?.id, 'threesome_mmf');
  assert.equal(findSexPosition('后宫簇拥')?.id, 'group_harem');
  assert.equal(findSexPosition('众女相伴')?.id, 'group_harem');
  assert.equal(findSexPosition('群像包围')?.id, 'group_gangbang');
  assert.equal(findSexPosition('轮番包围')?.id, 'group_gangbang');

  // Non-matching
  assert.equal(findSexPosition(''), null);
  assert.equal(findSexPosition('普通散步'), null);
});

test('normalizeSceneCard normalizes sex_position correctly', () => {
  // Standard position alias normalized to canonical Chinese name
  const scene1 = normalizeSceneCard({
    scene_idx: 1,
    trigger_sentence: '他在床榻上将她双腿架起折叠。',
    nsfw_rating: 'nsfw_explicit',
    sex_position: '种付',
    visual_description: '床榻上，少女被深深折叠双腿，赤裸交合。'
  });
  assert.equal(scene1.sex_position, '种付位');

  // Custom position preserved
  const scene2 = normalizeSceneCard({
    scene_idx: 2,
    trigger_sentence: '两人站立在走廊深处。',
    nsfw_rating: 'nsfw_explicit',
    sex_position: '站立老汉推车',
    visual_description: '走廊深处，两人站立交合。'
  });
  assert.equal(scene2.sex_position, '站立老汉推车');

  // Empty when not provided
  const scene3 = normalizeSceneCard({
    scene_idx: 3,
    trigger_sentence: '她站在门前看着庭院。',
    nsfw_rating: 'sfw',
    visual_description: '庭院中，少女独自站立。'
  });
  assert.equal(scene3.sex_position, '');
});

test('generateScenePromptAdvanced injects standard reference prompt for selected sex_position', async () => {
  let capturedPayload = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/chat/completions')) {
      capturedPayload = JSON.parse(options.body);
      const mockResponse = {
        choices: [
          {
            message: {
              content: [
                '/thinking/',
                '1. visible characters: 2',
                '2. scene: bedroom, missionary position',
                '/thinking/',
                '/JSON/',
                JSON.stringify({
                  orientation: 'square',
                  base_prompt: '1girl, 1boy, missionary, on bed, from side, 1.3::rim light::',
                  character_prompts: [
                    { name: '女主', prompt: 'girl, on back, spread legs, arched back, blushing' },
                    { name: '男主', prompt: 'boy, on top, looking down' }
                  ],
                  negative_prompt: '-1.5::multiple views::'
                }),
                '/JSON/'
              ].join('\n')
            }
          }
        ]
      };
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(url, options);
  };

  try {
    const extractor = new LLMExtractor({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false
    });

    const sceneDesc = {
      scene_idx: 1,
      trigger_sentence: '两人在凌乱的被褥间相拥交合。',
      nsfw_rating: 'nsfw_explicit',
      sex_position: '传教士位',
      visual_description: '昏暗卧室大床上，两人仰卧正身交合。',
      characters: [
        { name: '女主', gender: 'girl', clothing: 'nude' },
        { name: '男主', gender: 'boy', clothing: 'nude' }
      ]
    };

    const result = await extractor.generateScenePromptAdvanced(sceneDesc);
    assert.ok(result);
    assert.ok(capturedPayload);

    const userMessage = capturedPayload.messages.find(m => m.role === 'user')?.content || '';
    // Must contain position name and standard reference prompt
    assert.ok(userMessage.includes('【性爱体位与参考 Prompt（最高参考优先级）】检测到体位：传教士位'));
    assert.ok(userMessage.includes('missionary, on back, lying, spread legs, boy on top'));
    assert.ok(userMessage.includes('该体位的标准参考提示词模组为：'));

    // Check that formatStructuredSceneForLlm includes sex_position
    const formatted = extractor.formatStructuredSceneForLlm(sceneDesc);
    assert.ok(formatted.includes('"sex_position": "传教士位"'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateScenePromptAdvanced injects reference prompt for all 26 positions correctly', async () => {
  const originalFetch = globalThis.fetch;

  for (const pos of STANDARD_SEX_POSITIONS) {
    let capturedPayload = null;
    globalThis.fetch = async (url, options = {}) => {
      capturedPayload = JSON.parse(options.body);
      const mockResponse = {
        choices: [
          {
            message: {
              content: `/JSON/\n${JSON.stringify({
                orientation: 'square',
                base_prompt: `1girl, 1boy, ${pos.prompt.slice(0, 30)}`,
                character_prompts: [{ name: '女主', prompt: 'girl, nude' }],
                negative_prompt: ''
              })}\n/JSON/`
            }
          }
        ]
      };
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const extractor = new LLMExtractor({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false
    });

    const sceneDesc = {
      scene_idx: 1,
      trigger_sentence: '两人亲密接触。',
      nsfw_rating: 'nsfw_explicit',
      sex_position: pos.name,
      visual_description: '两人交合。',
      characters: [{ name: '女主', gender: 'girl', clothing: 'nude' }]
    };

    await extractor.generateScenePromptAdvanced(sceneDesc);
    const userMessage = capturedPayload.messages.find(m => m.role === 'user')?.content || '';
    assert.ok(
      userMessage.includes(`检测到体位：${pos.name}`),
      `User message did not detect position: ${pos.name}`
    );
    assert.ok(
      userMessage.includes(pos.prompt),
      `User message did not include reference prompt for: ${pos.name}`
    );

    const isGroup = /threesome|group|harem|gangbang/i.test(pos.id) || /双|群|多/.test(pos.name);
    if (isGroup) {
      assert.ok(
        userMessage.includes('【多人群像特规】'),
        `User message did not include multi-person rule for: ${pos.name}`
      );
    }
  }

  globalThis.fetch = originalFetch;
});

test('generateScenePromptAdvanced handles custom sex_position', async () => {
  let capturedPayload = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    capturedPayload = JSON.parse(options.body);
    const mockResponse = {
      choices: [
        {
          message: {
            content: `/JSON/\n${JSON.stringify({
              orientation: 'square',
              base_prompt: '1girl, 1boy, custom pose',
              character_prompts: [{ name: '女主', prompt: 'girl, nude' }],
              negative_prompt: ''
            })}\n/JSON/`
          }
        }
      ]
    };
    return new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const extractor = new LLMExtractor({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false
    });

    const sceneDesc = {
      scene_idx: 1,
      trigger_sentence: '特殊体位测试。',
      nsfw_rating: 'nsfw_explicit',
      sex_position: '空中旋转360度坐身位',
      visual_description: '两人特殊姿态。',
      characters: [{ name: '女主', gender: 'girl', clothing: 'nude' }]
    };

    await extractor.generateScenePromptAdvanced(sceneDesc);
    const userMessage = capturedPayload.messages.find(m => m.role === 'user')?.content || '';
    assert.ok(userMessage.includes('【性爱体位（最高参考优先级）】检测到体位：空中旋转360度坐身位'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
