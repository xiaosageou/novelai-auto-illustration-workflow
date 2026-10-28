import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ComicTextGenerator,
  buildComicDnaContext,
  buildComicFaceModelRule,
  compactDnaForLlm,
  pickPlanForImagePrompt,
  resolveDnaKeys
} from '../services/comic-text-generator.js';

const dna = {
  甲: {
    name: '甲',
    gender: 'girl',
    tags: 'silver_hair, red_eyes, white_dress',
    features: { 发色标签: ['silver_hair'], 年龄标签: ['15yo'] },
    height_class: 'short',
    body_proportion: 'childlike',
    evidence: [{ quote: '她站在门口', attribute: '发色', tags: ['silver_hair'] }],
    source_chapters: ['第一章', '第二章'],
    source_text_summary: '很长的原文摘要',
    confidence: 0.82,
    appearance_versions: [
      { start_chapter: '第二章', tags: 'short_hair', features: { 发型标签: ['short_hair'] }, evidence: [{ quote: '她剪了头发' }], persistent_change: true }
    ],
    proxy_character: {
      danbooru_tag: 'kasugano_sora',
      character_name_cn: '春日野穹',
      series: '缘之空',
      reason: '银白长发、病弱纤细',
      suppress_tags: ['black_dress']
    }
  },
  乙: { name: '乙', gender: 'boy', tags: 'black_hair' },
  丙: {
    name: '丙',
    aliases: ['阿丙 (剑客)'],
    gender: 'man',
    tags: 'brown_hair',
    evidence: [{ quote: '丙拔剑' }]
  }
};

test('resolveDnaKeys：undefined 走旧行为，空数组不下发，命中按传入顺序', () => {
  assert.deepEqual(resolveDnaKeys(dna, undefined), ['甲', '乙', '丙'], '兼容只传 dna 的老调用方');
  assert.deepEqual(resolveDnaKeys(dna, []), [], '风景格不该带任何 DNA');
  assert.deepEqual(resolveDnaKeys(dna, ['丙', '甲']), ['丙', '甲'], '顺序跟传入走');
  assert.deepEqual(resolveDnaKeys(dna, ['甲', '甲']), ['甲'], '去重');
  assert.deepEqual(resolveDnaKeys(dna, ['不存在']), []);
});

test('resolveDnaKeys 支持别名与括号后缀命中', () => {
  assert.deepEqual(resolveDnaKeys(dna, ['丙']), ['丙']);
  assert.deepEqual(resolveDnaKeys(dna, ['阿丙']), ['丙'], 'alias 能命中');
  assert.deepEqual(resolveDnaKeys(dna, ['阿丙 (剑客)']), ['丙'], '括号后缀被归一化');
});

test('buildComicDnaContext 只下发本格要画的人', () => {
  const ctx = buildComicDnaContext(dna, ['甲']);
  assert.deepEqual(Object.keys(ctx.dna), ['甲'], '整本小说的角色表不得全量下发');
  assert.equal(ctx.proxyAnchors.length, 1);

  const empty = buildComicDnaContext(dna, []);
  assert.deepEqual(Object.keys(empty.dna), []);
  assert.deepEqual(empty.proxyAnchors, []);
});

test('buildComicDnaContext 剥掉审计账本字段', () => {
  const ctx = buildComicDnaContext(dna, ['甲']);
  const entry = ctx.dna.甲;

  for (const field of ['evidence', 'appearance_versions', 'source_chapters', 'source_text_summary', 'confidence']) {
    assert.equal(field in entry, false, `${field} 对出图没有价值，不该下发`);
  }
  assert.equal(entry.tags, 'silver_hair, red_eyes, white_dress', 'tags 必须保留');
  assert.deepEqual(entry.features['发色标签'], ['silver_hair']);
  assert.equal(entry.height_class, 'short');
  assert.equal(entry.body_proportion, 'childlike');
});

test('buildComicDnaContext 剪掉脸模里的中文解释字段但保留锁脸 tag', () => {
  const ctx = buildComicDnaContext(dna, ['甲']);
  const proxy = ctx.dna.甲.proxy_character;

  assert.equal(proxy.danbooru_tag, 'kasugano_sora', '锁脸 tag 必须保留');
  assert.deepEqual(proxy.suppress_tags, ['black_dress']);
  assert.equal('reason' in proxy, false);
  assert.equal('series' in proxy, false);
  assert.equal('character_name_cn' in proxy, false);
});

test('compactDnaForLlm 可被 NAI_LLM_FULL_DNA=1 关掉，便于排查', () => {
  const before = process.env.NAI_LLM_FULL_DNA;
  try {
    process.env.NAI_LLM_FULL_DNA = '1';
    const full = compactDnaForLlm(dna.甲);
    assert.ok(Array.isArray(full.evidence), '排障开关下保留账本字段');
    assert.equal(full.proxy_character.reason, '银白长发、病弱纤细');

    process.env.NAI_LLM_FULL_DNA = '0';
    const slim = compactDnaForLlm(dna.甲);
    assert.equal('evidence' in slim, false);
    assert.equal('理由' in slim, false);
  } finally {
    if (before === undefined) delete process.env.NAI_LLM_FULL_DNA;
    else process.env.NAI_LLM_FULL_DNA = before;
  }
});

test('compactDnaForLlm 不改动入参 DNA', () => {
  compactDnaForLlm(dna.甲);
  assert.ok(Array.isArray(dna.甲.evidence), '原始 DNA 不得被剪裁');
  assert.equal(dna.甲.proxy_character.reason, '银白长发、病弱纤细');
});

test('pickPlanForImagePrompt 只留出图需要的字段', () => {
  const plan = {
    sourceExcerpt: '她站在门口',
    sourceLocator: 'p12',
    sceneId: 'SC001',
    shotId: 'SHOT003',
    storyBeat: '相遇',
    storyboardDescription: '少女立在门廊阴影里',
    shotSize: 'cowboy shot',
    cameraAngle: 'from side',
    canvasReason: '人物立姿适合竖幅',
    width: 832,
    height: 1216,
    characterNames: ['甲'],
    mustShow: ['wet hair'],
    mustNotShow: ['text'],
    styleMode: 'main',
    styleReason: '',
    stateDelta: { mood: 'cold' },
    gapBefore: 0,
    gapAfter: 64,
    dialogue: [{ dialogueId: 'D001', speakerId: '甲', text: '你来了' }],
    sfx: ['轰']
  };

  const picked = pickPlanForImagePrompt(plan);

  assert.deepEqual(Object.keys(picked).sort(), [
    'cameraAngle', 'characterNames', 'height', 'mustNotShow', 'mustShow',
    'shotSize', 'storyboardDescription', 'styleMode', 'width'
  ].sort());

  for (const dropped of ['sourceExcerpt', 'sourceLocator', 'sceneId', 'shotId', 'canvasReason', 'stateDelta', 'gapBefore', 'gapAfter', 'dialogue', 'sfx']) {
    assert.equal(dropped in picked, false, `${dropped} 不该进 LLM 上下文`);
  }
});

test('pickPlanForImagePrompt 对空值与非对象安全', () => {
  assert.equal(pickPlanForImagePrompt(null), null);
  assert.equal(pickPlanForImagePrompt(undefined), undefined);
  assert.deepEqual(pickPlanForImagePrompt({ characterNames: ['甲'], dialogue: [] }), { characterNames: ['甲'] });
});

test('prompt() 下发的是剪裁后的 plan 与命中角色的 DNA', async () => {
  const generator = new ComicTextGenerator();
  let captured = null;
  generator.request = async (pipeline, task, system, input) => {
    captured = { task, system, input };
    return {
      basePrompt: '1girl, doorway, night',
      negativePrompt: 'lowres',
      characterPrompts: ['girl, kasugano_sora, silver_hair'],
      negativeCharacterPrompts: ['black_dress']
    };
  };

  const plan = {
    storyboardDescription: '少女立在门廊阴影里',
    shotSize: 'cowboy shot',
    cameraAngle: 'from side',
    width: 832,
    height: 1216,
    characterNames: ['甲'],
    mustShow: [],
    mustNotShow: [],
    styleMode: 'main',
    sourceExcerpt: '她站在门口',
    dialogue: [{ dialogueId: 'D001', speakerId: '甲', text: '你来了' }],
    sfx: ['轰'],
    gapAfter: 64
  };

  await generator.prompt({
    pipeline: { config: {} },
    plan,
    dna,
    entryState: {},
    validate: () => {}
  });

  assert.equal(captured.task, 'naiTags');
  assert.deepEqual(Object.keys(captured.input.dna), ['甲'], '只带本格角色');
  assert.equal('dialogue' in captured.input.plan, false, '对白不该进上下文');
  assert.equal('sfx' in captured.input.plan, false);
  assert.equal('sourceExcerpt' in captured.input.plan, false);
  assert.equal('evidence' in captured.input.dna.甲, false, '账本字段不该进上下文');
  assert.ok(captured.system.includes('kasugano_sora'));
  assert.ok(!captured.system.includes('缘之空'), '作品名不再进 system');
});

test('脸模规则在没有锚点时不产生任何 system 增量', () => {
  assert.equal(buildComicFaceModelRule(buildComicDnaContext(dna, ['乙'])), '');
});
