import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ComicTextGenerator,
  buildComicDnaContext,
  buildComicFaceModelRule,
  extractHeadAppearanceTags
} from '../services/comic-text-generator.js';
import { faceModelStale } from '../services/comic-production.js';

const dnaWithProxy = {
  谢云岚: {
    name: '谢云岚',
    gender: 'girl',
    tags: 'long hair, black eyes',
    proxy_character: {
      danbooru_tag: '  Asuka_Langley_Soryu ',
      character_name_cn: '惣流·明日香·兰格雷',
      series: '新世纪福音战士',
      reason: '傲娇好胜',
      suppress_tags: ['Plugsuit', ' hair_clips', '']
    }
  },
  路人甲: { name: '路人甲', gender: 'man', tags: 'short hair' }
};

test('buildComicDnaContext extracts and normalizes proxy face model anchors', () => {
  const ctx = buildComicDnaContext(dnaWithProxy, ['谢云岚', '路人甲']);

  assert.equal(ctx.proxyAnchors.length, 1, 'only the character with a face model becomes an anchor');
  const anchor = ctx.proxyAnchors[0];
  assert.equal(anchor.name, '谢云岚');
  assert.equal(anchor.danbooru_tag, 'asuka_langley_soryu', 'tag normalized to lowercase underscore');
  assert.equal('character_name_cn' in anchor, false, '中文名不再随锚点下发');
  assert.equal('series' in anchor, false, '作品名不再随锚点下发');
  assert.equal('reason' in anchor, false, '匹配理由不再随锚点下发');
  assert.deepEqual(anchor.suppress_tags, ['plugsuit', 'hair_clips'], 'suppress tags trimmed, lowercased and de-duplicated');
  assert.deepEqual(ctx.proxySuppressTags, ['plugsuit', 'hair_clips']);
  assert.ok(ctx.dna['谢云岚'], 'dna entries are preserved for the prompt payload');
});

test('buildComicDnaContext keeps every character even without a face model', () => {
  const ctx = buildComicDnaContext({ 甲: { tags: 'a' }, 乙: null }, ['甲', '乙', '丙']);
  assert.deepEqual(Object.keys(ctx.dna), ['甲', '乙'], 'null entries preserved, missing names skipped');
  assert.deepEqual(ctx.proxyAnchors, []);
});

test('buildComicFaceModelRule returns empty string when no character has a face model', () => {
  assert.equal(buildComicFaceModelRule({ proxyAnchors: [], proxySuppressTags: [] }), '');
  assert.equal(buildComicFaceModelRule(), '');
});

test('buildComicFaceModelRule pins the tag, forbids cross-character leakage and lists suppress tags', () => {
  const ctx = buildComicDnaContext(dnaWithProxy, ['谢云岚']);
  const rule = buildComicFaceModelRule(ctx);

  assert.ok(rule.includes('【同人动漫脸模代理铁律】'));
  assert.ok(rule.includes('谢云岚 → asuka_langley_soryu'));
  assert.ok(!rule.includes('新世纪福音战士'), '作品名/理由不再重复占用 system token');
  assert.ok(!rule.includes('傲娇好胜'), 'match reason dropped from the rule block');
  assert.ok(rule.includes('紧跟在性别词之后'), 'tag must sit right after the gender word');
  assert.ok(rule.includes('不得后移、改写或省略'));
  assert.ok(rule.includes('negativeCharacterPrompts'), 'suppress tags go to per-character negatives');
  assert.ok(rule.includes('plugsuit, hair_clips'));
  assert.ok(rule.includes('不得串到其他角色段'));
});

test('comic prompt() forwards the latest face model to the LLM system prompt and payload', async () => {
  const generator = new ComicTextGenerator();
  let captured = null;
  generator.request = async (pipeline, task, system, input) => {
    captured = { task, system, input };
    return {
      basePrompt: '1girl, snow, night, cinematic lighting',
      negativePrompt: 'lowres, worst quality',
      characterPrompts: ['girl, asuka_langley_soryu, long hair, black eyes, hanfu'],
      negativeCharacterPrompts: ['plugsuit, hair_clips']
    };
  };

  const output = await generator.prompt({
    pipeline: { config: {} },
    plan: { characterNames: ['谢云岚'] },
    dna: dnaWithProxy,
    entryState: {},
    validate: () => {}
  });

  assert.equal(captured.task, 'naiTags');
  assert.ok(captured.system.includes('asuka_langley_soryu'), 'face model tag reaches the system prompt');
  assert.ok(captured.system.includes('为单格漫画创作 NovelAI V4.5 的完整英文提示词'), 'original prompt body is preserved');
  assert.ok(captured.input.proxyAnchors.some(a => a.danbooru_tag === 'asuka_langley_soryu'), 'anchors reach the payload');
  assert.equal(output.characterPrompts.length, 1);
});

test('comic prompt() leaves the system prompt untouched when no face model exists', async () => {
  const generator = new ComicTextGenerator();
  let captured = null;
  generator.request = async (pipeline, task, system, input) => {
    captured = { system, input };
    return {
      basePrompt: '1girl, room',
      negativePrompt: 'lowres',
      characterPrompts: ['girl, short hair'],
      negativeCharacterPrompts: ['']
    };
  };

  await generator.prompt({
    pipeline: { config: {} },
    plan: { characterNames: ['路人甲'] },
    dna: { 路人甲: { name: '路人甲', tags: 'short hair' } },
    entryState: {},
    validate: () => {}
  });

  assert.ok(!captured.system.includes('【同人动漫脸模代理铁律】'), 'no face model → no extra rule block');
  assert.deepEqual(captured.input.proxyAnchors, []);
});

test('faceModelStale detects a prompt built with a previous face model', () => {
  const dna = dnaWithProxy;
  const stale = '1girl, snow | girl, old_face_model, long hair';
  const fresh = '1girl, snow | girl, asuka_langley_soryu, long hair';

  assert.equal(faceModelStale(stale, dna, ['谢云岚']), true, 'old prompt without the new tag must be recomputed');
  assert.equal(faceModelStale(fresh, dna, ['谢云岚']), false, 'prompt already carrying the new tag can be reused');
  assert.equal(faceModelStale('', dna, ['谢云岚']), false, 'empty prompt is handled by the caller');
  assert.equal(faceModelStale(stale, {}, ['谢云岚']), false, 'no bound face model means no stale detection');
  assert.equal(faceModelStale('1girl | girl, ASUKA_Langley_Soryu', dna, ['谢云岚']), false, 'match is case-insensitive');
});

// 脸模 tag 本身已锁定发色/发型/瞳色/脸型，DNA 里重复的外观标签属于纯冗余。
test('extractHeadAppearanceTags picks head appearance only', () => {
  const tags = extractHeadAppearanceTags({
    tags: 'short_hair, black_hair, blue_eyes, pale_skin, hanfu, smiling, petite, long_legs',
    features: { hair: '短发, 黑发', eyes: '蓝色', physique: 'petite' }
  });

  assert.ok(tags.includes('short_hair'), 'hair style kept');
  assert.ok(tags.includes('black_hair'), 'hair color kept');
  assert.ok(tags.includes('blue_eyes'), 'eye color kept');
  assert.ok(tags.includes('pale_skin'), 'skin tone kept');
  assert.ok(!tags.includes('hanfu'), 'clothing is not head appearance');
  assert.ok(!tags.includes('smiling'), 'expression is not head appearance');
  assert.ok(!tags.includes('petite'), 'body type is not head appearance');
  assert.ok(!tags.includes('long_legs'), 'body shape is not head appearance');
  assert.deepEqual(tags, [...new Set(tags)], 'no duplicate tags');
});

test('extractHeadAppearanceTags tolerates weights, arrays, Chinese keys and empty input', () => {
  assert.deepEqual(extractHeadAppearanceTags({ tags: ['(long_hair:1.2)', 'Long Hair', 'twintails'] }), ['long_hair', 'twintails'], 'weights stripped, case folded, duplicates collapsed');
  assert.deepEqual(extractHeadAppearanceTags({ '正面提示词': '银发, 红瞳' }), [], 'Chinese words do not masquerade as tags');
  assert.deepEqual(extractHeadAppearanceTags(null), []);
  assert.deepEqual(extractHeadAppearanceTags({ tags: 'silver_hair, red_eyes' }), ['silver_hair', 'red_eyes']);
});

test('face model rule tells the LLM to drop appearance tags already covered by the tag', () => {
  const ctx = buildComicDnaContext(dnaWithProxy, ['谢云岚']);
  const rule = buildComicFaceModelRule(ctx);

  assert.deepEqual(ctx.proxyAnchors[0].appearance_tags, ['long_hair', 'black_eyes'], 'DNA duplicates are surfaced per anchor');
  assert.ok(rule.includes('外貌去重'), 'dedupe clause present');
  assert.ok(rule.includes('谢云岚：long_hair, black_eyes'), 'concrete duplicates named');
  assert.ok(rule.includes('默认不要写进 characterPrompts'));
  assert.ok(rule.includes('染发'), 'override case: hair dye');
  assert.ok(rule.includes('剪短'), 'override case: haircut');
  assert.ok(rule.includes('湿发'), 'override case: wet hair');
  assert.ok(rule.includes('异色瞳'), 'override case: heterochromia');
  assert.ok(rule.includes('去重不等于删信息'), 'guard against over-trimming');
  assert.ok(rule.includes('服装、表情、体型、姿态、位置'), 'non-head attributes stay mandatory');
});

test('face model rule still explains dedupe when DNA has no head appearance tags', () => {
  const rule = buildComicFaceModelRule({
    proxyAnchors: [{ name: '甲', danbooru_tag: 'some_face', appearance_tags: [] }],
    proxySuppressTags: []
  });
  assert.ok(rule.includes('甲：（DNA 未登记可去重的头部外观标签'));
  assert.ok(rule.includes('外貌去重'));
});
