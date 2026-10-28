import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADULT_AGE_FLOOR,
  parseAgeYears,
  isMinorAgeText,
  containsMinorAge,
  proxyAgeTagsForLlm,
  proxyFeaturesForLlm,
  proxyDnaEntryForLlm,
  resolveRealAgeTags,
  injectRealAgeIntoCharacterPrompts,
  normalizeCharacterKey
} from '../utils/age-proxy.js';
import { stripAgeWords } from '../utils/age-tags.js';
import { buildComicDnaContext } from '../services/comic-text-generator.js';

test('parseAgeYears 解析常见年龄写法', () => {
  assert.equal(parseAgeYears('15yo'), 15);
  assert.equal(parseAgeYears('15 yo'), 15);
  assert.equal(parseAgeYears('17 years old'), 17);
  assert.equal(parseAgeYears('17_year_old'), 17);
  assert.equal(parseAgeYears('15岁'), 15);
  assert.equal(parseAgeYears('age 12'), 12);
  assert.equal(parseAgeYears('年龄: 16'), 16);
  assert.equal(parseAgeYears('adult'), null);
  assert.equal(parseAgeYears(''), null);
  assert.equal(parseAgeYears('silver_hair'), null);
});

test('isMinorAgeText 识别未成年年龄与未成年词', () => {
  assert.equal(ADULT_AGE_FLOOR, 18);
  assert.equal(isMinorAgeText('17yo'), true);
  assert.equal(isMinorAgeText('15 years old'), true);
  assert.equal(isMinorAgeText('18yo'), false);
  assert.equal(isMinorAgeText('25yo'), false);
  assert.equal(isMinorAgeText('child'), true);
  assert.equal(isMinorAgeText('loli'), true);
  assert.equal(isMinorAgeText('shota'), true);
  assert.equal(isMinorAgeText('teenager'), true);
  assert.equal(isMinorAgeText('underage'), true);
  assert.equal(isMinorAgeText('little_girl'), true);
  assert.equal(isMinorAgeText('adult'), false);
  assert.equal(isMinorAgeText('young_woman'), false, 'young_woman 是成年写法，不得误判');
  assert.equal(isMinorAgeText('silver_hair'), false);
  assert.equal(isMinorAgeText(''), false);
});

test('containsMinorAge 整串判断', () => {
  assert.equal(containsMinorAge('15yo, silver_hair'), true);
  assert.equal(containsMinorAge('adult, silver_hair'), false);
  assert.equal(containsMinorAge(''), false);
});

test('proxyAgeTagsForLlm 对成年角色与旧逻辑逐字一致', () => {
  const adultCases = ['adult', '25yo', 'mature', 'mature_female', 'silver_hair, adult', 'slim, long_legs', ''];
  for (const value of adultCases) {
    assert.equal(proxyAgeTagsForLlm(value), stripAgeWords(value), `成年用例不一致: ${value}`);
  }
});

test('proxyAgeTagsForLlm 把未成年年龄换成 adult', () => {
  assert.equal(proxyAgeTagsForLlm('15yo'), 'adult');
  assert.equal(proxyAgeTagsForLlm('child'), 'adult');
  assert.equal(proxyAgeTagsForLlm('15yo, silver_hair'), 'silver_hair, adult');
  assert.equal(proxyAgeTagsForLlm('child, blue_eyes, short_hair'), 'blue_eyes, short_hair, adult');
  assert.equal(proxyAgeTagsForLlm('loli, 168cm'), '168cm, adult');
  assert.ok(!/15yo|child|loli|shota|teen/i.test(proxyAgeTagsForLlm('15yo, child, loli, teen')));
});

test('proxyAgeTagsForLlm 支持数组输入且不改动原值', () => {
  const input = ['15yo', 'silver_hair'];
  assert.equal(proxyAgeTagsForLlm(input), 'silver_hair, adult');
  assert.deepEqual(input, ['15yo', 'silver_hair']);
});

test('proxyFeaturesForLlm 只改写年龄槽，其余键原样且不污染原对象', () => {
  const features = {
    年龄标签: ['15yo'],
    年龄感标签: ['15yo'],
    发色标签: ['silver_hair'],
    身材标签: ['slim']
  };
  const proxied = proxyFeaturesForLlm(features);

  assert.deepEqual(proxied.年龄标签, ['adult']);
  assert.deepEqual(proxied.年龄感标签, ['adult']);
  assert.deepEqual(proxied.发色标签, ['silver_hair']);
  assert.deepEqual(proxied.身材标签, ['slim']);
  assert.deepEqual(features.年龄标签, ['15yo'], '不能改动 DNA 原始数据');
});

test('proxyFeaturesForLlm 对成年 DNA 保持内容不变', () => {
  const features = { 年龄标签: ['adult'], 发色标签: ['black_hair'] };
  const proxied = proxyFeaturesForLlm(features);
  assert.deepEqual(proxied, features);
  assert.notEqual(proxied, features, '应返回副本避免下游误改');
  assert.equal(proxyFeaturesForLlm('not-an-object'), 'not-an-object');
  assert.equal(proxyFeaturesForLlm(null), null);
});

test('proxyDnaEntryForLlm 同时代理 tags 与 features', () => {
  const entry = {
    tags: '15yo, silver_hair',
    features: { 年龄标签: ['15yo'], 发色标签: ['silver_hair'] },
    supersededNegative: 'old_clothes',
    proxy_character: { danbooru_tag: 'some_tag' }
  };
  const proxied = proxyDnaEntryForLlm(entry);

  assert.equal(proxied.tags, 'silver_hair, adult');
  assert.deepEqual(proxied.features.年龄标签, ['adult']);
  assert.equal(proxied.supersededNegative, 'old_clothes');
  assert.equal(proxied.proxy_character.danbooru_tag, 'some_tag');
  assert.equal(entry.tags, '15yo, silver_hair', '原始 DNA 不得被改写');
});

test('resolveRealAgeTags 提取真实年龄，成年返回空', () => {
  assert.deepEqual(resolveRealAgeTags({ 年龄标签: ['15yo'] }), ['15yo']);
  assert.deepEqual(resolveRealAgeTags({ 年龄标签: ['child'], 年龄感标签: ['child'] }), ['child']);
  assert.deepEqual(resolveRealAgeTags({ 年龄标签: ['adult'] }), []);
  assert.deepEqual(resolveRealAgeTags({}, '15yo, silver_hair'), ['15yo']);
  assert.deepEqual(resolveRealAgeTags(null), []);
  assert.deepEqual(resolveRealAgeTags({ 年龄标签: ['15yo'] }, '17yo'), ['15yo', '17yo']);
});

test('injectRealAgeIntoCharacterPrompts 按姓名把真实年龄换算成标签块写回人物段', () => {
  const list = [
    { name: '小明', prompt: 'boy, short_hair', negative_prompt: '' },
    { name: '小红', prompt: 'girl, long_hair', negative_prompt: '' }
  ];
  const map = new Map([['小明', ['15yo']]]);
  const out = injectRealAgeIntoCharacterPrompts(list, map);

  // 15yo 男性 → 13-15 岁档，身份锁 shota/teen + 比例锁，权重 1.2
  assert.equal(out[0].prompt, 'boy, short_hair, 1.2::shota,teen,slim,short stature,narrow shoulders::');
  assert.ok(!/15yo/.test(out[0].prompt), '数字年龄不得落进最终 prompt');
  assert.match(out[0].negative_prompt, /-1\.5::man, adult/, '负向锁必须随年龄一起下发');
  assert.equal(out[1].prompt, 'girl, long_hair', '没配置未成年年龄的角色不得改动');
  assert.equal(out[1].negative_prompt, '', '未命中角色不得被写负向锁');
});

test('injectRealAgeIntoCharacterPrompts 把已有的 adult 就地替换成真实年龄', () => {
  const list = [{ name: '小明', prompt: 'boy, adult, short_hair' }];
  const out = injectRealAgeIntoCharacterPrompts(list, new Map([['小明', ['15yo']]]));
  assert.equal(out[0].prompt, 'boy, short_hair, 1.2::shota,teen,slim,short stature,narrow shoulders::');
  assert.ok(!/\badult\b/.test(out[0].prompt));
});

test('injectRealAgeIntoCharacterPrompts 支持别名与括号后缀', () => {
  const list = [{ name: '夏洛特', prompt: 'girl, blonde_hair' }];
  const map = new Map([[normalizeCharacterKey('夏洛特 (猫娘)'), ['15yo']]]);
  const out = injectRealAgeIntoCharacterPrompts(list, map);
  assert.equal(out[0].prompt, 'girl, blonde_hair, 1.2::loli,teen,petite,small breasts,short stature::');
});

test('injectRealAgeIntoCharacterPrompts 空映射或空列表原样返回', () => {
  const list = [{ name: '甲', prompt: 'girl' }];
  assert.equal(injectRealAgeIntoCharacterPrompts(list, new Map()), list);
  assert.deepEqual(injectRealAgeIntoCharacterPrompts([], new Map([['甲', ['15yo']]])), []);
  assert.deepEqual(injectRealAgeIntoCharacterPrompts(null, new Map()), null);
});

test('injectRealAgeIntoCharacterPrompts 不给无 negative_prompt 键的条目凭空加键', () => {
  const list = [{ name: '甲', prompt: 'boy, hair' }];
  const out = injectRealAgeIntoCharacterPrompts(list, new Map([['甲', ['15yo']]]));
  assert.ok(out[0].prompt.includes('shota'));
  assert.equal('negative_prompt' in out[0], false);
  assert.equal('negative_prompt' in list[0], false, '入参不得被改动');
});

test('buildComicDnaContext 对 LLM 隐藏未成年年龄，同时回传真实年龄映射', () => {
  const dna = {
    小明: { tags: '15yo, silver_hair', features: { 年龄标签: ['15yo'], 发色标签: ['silver_hair'] } },
    小红: { tags: 'adult, long_hair', features: { 年龄标签: ['adult'] } }
  };
  const ctx = buildComicDnaContext(dna, ['小明', '小红']);

  assert.equal(ctx.dna.小明.tags, 'silver_hair, adult');
  assert.doesNotMatch(JSON.stringify(ctx.dna), /15yo/);
  assert.deepEqual(ctx.realAgeByName, { 小明: ['15yo'] });
  assert.equal(ctx.dna.小红.tags, 'adult, long_hair', '成年角色保持原有写法，不被代理层改动');
  assert.equal(dna.小明.tags, '15yo, silver_hair', '原始 DNA 不被改写');
});
