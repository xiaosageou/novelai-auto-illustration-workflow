import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADULT_AGE_FLOOR,
  AGE_NEGATIVE_TABLE,
  AGE_PROMPT_BUCKETS,
  GENDER_FEMALE,
  GENDER_MALE,
  GENDER_MIXED,
  GENDER_NEUTRAL,
  buildAgeGapRelationTags,
  convertAgeToPromptTags,
  detectPromptGender,
  formatWeightedTags,
  mergeAgeNegativeIntoPrompt,
  mergeAgeTagsIntoPrompt,
  parseAgeYears,
  resolveAgeBucket
} from '../utils/age-prompt-tags.js';

test('parseAgeYears 与 age-proxy 同语义', () => {
  assert.equal(parseAgeYears('7yo'), 7);
  assert.equal(parseAgeYears('7 yo'), 7);
  assert.equal(parseAgeYears('7y/o'), 7);
  assert.equal(parseAgeYears('7-year-old'), 7);
  assert.equal(parseAgeYears('7 years old'), 7);
  assert.equal(parseAgeYears('7岁'), 7);
  assert.equal(parseAgeYears('age 7'), 7);
  assert.equal(parseAgeYears('年龄: 7'), 7);
  assert.equal(parseAgeYears('adult'), null);
  assert.equal(parseAgeYears(''), null);
});

test('detectPromptGender 认得出男女与混合', () => {
  assert.equal(detectPromptGender('1girl, silver hair'), GENDER_FEMALE);
  assert.equal(detectPromptGender('1boy, short hair'), GENDER_MALE);
  assert.equal(detectPromptGender('小男娘, 少年'), GENDER_MALE);
  assert.equal(detectPromptGender('1girl, 1boy, age difference'), GENDER_MIXED);
  assert.equal(detectPromptGender('silver hair, blue eyes'), GENDER_NEUTRAL);
  assert.equal(detectPromptGender(''), GENDER_NEUTRAL);
  assert.equal(detectPromptGender('shota'), GENDER_MALE, 'shota 是男侧身份词');
  assert.equal(detectPromptGender('loli'), GENDER_FEMALE, 'loli 是女侧身份词');
});

test('resolveAgeBucket 数字与类别词都能定位档位', () => {
  assert.equal(resolveAgeBucket('4yo').key, 'age05');
  assert.equal(resolveAgeBucket('7yo').key, 'age09');
  assert.equal(resolveAgeBucket('11yo').key, 'age12');
  assert.equal(resolveAgeBucket('14yo').key, 'age15');
  assert.equal(resolveAgeBucket('17yo').key, 'age17');
  assert.equal(resolveAgeBucket('18yo'), null, '成年不得命中年龄锁');
  assert.equal(resolveAgeBucket('25yo'), null);
  assert.equal(resolveAgeBucket('adult'), null);
  assert.equal(resolveAgeBucket('toddler').key, 'age05');
  assert.equal(resolveAgeBucket('child').key, 'age09');
  assert.equal(resolveAgeBucket('teen').key, 'age17');
  assert.equal(resolveAgeBucket('aged down').key, 'agedDown');
  assert.equal(resolveAgeBucket('silver hair'), null);
  assert.equal(resolveAgeBucket(''), null);
});

test('7yo 换算：男女两侧给出不同身份锁与比例锁', () => {
  const female = convertAgeToPromptTags({ ageText: '7yo', gender: GENDER_FEMALE });
  assert.equal(female.matched, true);
  assert.equal(female.bucketKey, 'age09');
  assert.deepEqual(female.identity, ['child', 'loli']);
  assert.ok(female.proportion.includes('flat chest'));
  assert.ok(female.proportion.includes('short stature'));
  assert.equal(female.weight, 1.3);
  assert.match(female.weighted, /^1\.3::child,loli,/);

  const male = convertAgeToPromptTags({ ageText: '7yo', gender: GENDER_MALE });
  assert.equal(male.matched, true);
  assert.deepEqual(male.identity, ['shota', 'child']);
  assert.ok(!male.identity.includes('loli'), '男侧不得出现 loli');
  assert.ok(male.proportion.includes('narrow shoulders'));
  assert.equal(male.weight, 1.5);
  assert.match(male.weighted, /^1\.5::shota,child,/);
});

test('性别未知时回落到中性档，不猜男女', () => {
  const neutral = convertAgeToPromptTags({ ageText: '7yo' });
  assert.equal(neutral.gender, GENDER_NEUTRAL);
  assert.deepEqual(neutral.identity, ['child']);
  assert.ok(!neutral.identity.includes('loli'));
  assert.ok(!neutral.identity.includes('shota'));
});

test('性别可以从 prompt 文本自动推断', () => {
  const fromPrompt = convertAgeToPromptTags({ ageText: '7yo', prompt: '1boy, messy hair' });
  assert.equal(fromPrompt.gender, GENDER_MALE);
  assert.ok(fromPrompt.weighted.includes('shota'));

  const explicitWins = convertAgeToPromptTags({ ageText: '7yo', gender: GENDER_FEMALE, prompt: '1boy' });
  assert.equal(explicitWins.gender, GENDER_FEMALE, '显式 gender 优先于 prompt 推断');
});

test('成年与无法换算的输入不产生任何标签', () => {
  for (const ageText of ['18yo', '25yo', 'adult', 'silver hair', '']) {
    const out = convertAgeToPromptTags({ ageText, gender: GENDER_MALE });
    assert.equal(out.matched, false, `${ageText} 不应命中`);
    assert.equal(out.weighted, '');
    assert.deepEqual(out.negative, []);
  }
  assert.equal(ADULT_AGE_FLOOR, 18);
});

test('负向表按性别分表，男侧必须压 man', () => {
  const female = convertAgeToPromptTags({ ageText: '7yo', gender: GENDER_FEMALE }).negative;
  const male = convertAgeToPromptTags({ ageText: '7yo', gender: GENDER_MALE }).negative;

  assert.ok(female.join(' ').includes('mature female'));
  assert.ok(female.join(' ').includes('large breasts'));
  assert.ok(male.join(' ').includes('man, adult'), '1boy 的默认先验是青年男性');
  assert.ok(male.join(' ').includes('facial hair'));
  assert.equal(AGE_NEGATIVE_TABLE[GENDER_MIXED], AGE_NEGATIVE_TABLE[GENDER_NEUTRAL]);
});

test('weightOverride 可覆盖表内权重', () => {
  const out = convertAgeToPromptTags({ ageText: '7yo', gender: GENDER_FEMALE, weightOverride: 1 });
  assert.equal(out.weight, 1);
  assert.ok(!out.weighted.includes('::'), '权重 1 不写权重语法');
});

test('formatWeightedTags 去重并跳过空值', () => {
  assert.equal(formatWeightedTags(['a', 'b', 'a', ''], 1.5), '1.5::a,b::');
  assert.equal(formatWeightedTags(['a'], 1), 'a');
  assert.equal(formatWeightedTags([], 2), '');
});

test('mergeAgeTagsIntoPrompt 替换 adult 并追加换算块', () => {
  assert.equal(
    mergeAgeTagsIntoPrompt('1boy, short hair, adult, blue eyes', ['7yo']),
    '1boy, short hair, blue eyes, 1.5::shota,child,petite,short stature,narrow shoulders,small hands::'
  );
  assert.equal(
    mergeAgeTagsIntoPrompt('1girl, silver hair', ['7yo']),
    '1girl, silver hair, 1.3::child,loli,petite,flat chest,short stature,narrow shoulders,small hands::'
  );
});

test('mergeAgeTagsIntoPrompt 对空 prompt 与成年年龄保持旧行为', () => {
  assert.equal(
    mergeAgeTagsIntoPrompt('', ['7yo']),
    '1.3::child,petite,short stature,narrow shoulders::',
    '空 prompt 无法判性别，走中性档'
  );
  assert.equal(mergeAgeTagsIntoPrompt('1girl, hair', ['25yo']), '1girl, hair, 25yo');
  assert.equal(mergeAgeTagsIntoPrompt('1girl, adult', ['25yo']), '1girl, 25yo');
  assert.equal(mergeAgeTagsIntoPrompt('1girl, hair', []), '1girl, hair');
});

test('mergeAgeTagsIntoPrompt 不修改入参', () => {
  const ages = ['7yo'];
  const prompt = '1boy, hair';
  mergeAgeTagsIntoPrompt(prompt, ages);
  assert.equal(prompt, '1boy, hair');
  assert.deepEqual(ages, ['7yo']);
});

test('buildAgeGapRelationTags 给出同框关系标签', () => {
  assert.deepEqual(
    buildAgeGapRelationTags({ youngGender: GENDER_MALE, olderGender: GENDER_FEMALE }),
    ['onee-shota', 'age difference', 'height difference', 'size difference']
  );
  assert.deepEqual(
    buildAgeGapRelationTags({ youngGender: GENDER_FEMALE, olderGender: GENDER_MALE }),
    ['age difference', 'height difference', 'size difference']
  );
  assert.deepEqual(buildAgeGapRelationTags({ sameAge: true }), ['2kids', 'same height']);
  assert.deepEqual(buildAgeGapRelationTags(), ['age difference', 'height difference']);
});

test('表结构完整：每档都男女中三套且有验收头身比', () => {
  assert.equal(AGE_PROMPT_BUCKETS.length, 5);
  const years = AGE_PROMPT_BUCKETS.map(bucket => bucket.maxYears);
  assert.deepEqual(years, [5, 9, 12, 15, 17], '档位必须连续覆盖 18 岁以下');
  for (const bucket of AGE_PROMPT_BUCKETS) {
    for (const gender of [GENDER_FEMALE, GENDER_MALE, GENDER_NEUTRAL]) {
      const slot = bucket[gender];
      assert.ok(slot, `${bucket.key} 缺 ${gender} 槽位`);
      assert.ok(slot.identity.length > 0, `${bucket.key}/${gender} 缺身份锁`);
      assert.ok(slot.proportion.length > 0, `${bucket.key}/${gender} 缺比例锁`);
      assert.ok(slot.weight > 0 && slot.weight <= 2, `${bucket.key}/${gender} 权重越界`);
    }
    assert.ok(bucket.headToBody, `${bucket.key} 缺 headToBody`);
  }
});

test('mergeAgeNegativeIntoPrompt 追加负向锁', () => {
  // 性别必须来自正向段或显式传入，负向段里没有 1boy/1girl
  const maleNegative = mergeAgeNegativeIntoPrompt('', ['7yo'], { prompt: '1boy, short hair' });
  assert.match(maleNegative, /^-1\.5::man, adult/);
  assert.match(maleNegative, /-2::facial hair/);

  const femaleNegative = mergeAgeNegativeIntoPrompt('', ['7yo'], { gender: GENDER_FEMALE });
  assert.match(femaleNegative, /^-1\.5::mature female/);
  assert.ok(!/^-1\.5::man,/.test(femaleNegative));

  const neutralNegative = mergeAgeNegativeIntoPrompt('', ['7yo']);
  assert.match(neutralNegative, /^-1\.5::mature female, man, adult/);

  const withExisting = mergeAgeNegativeIntoPrompt('lowres, bad hands', ['7yo'], { prompt: '1boy' });
  assert.match(withExisting, /^lowres, bad hands, -1\.5::/);

  assert.equal(mergeAgeNegativeIntoPrompt('lowres', ['25yo']), 'lowres', '成年不得写负向锁');
  assert.equal(mergeAgeNegativeIntoPrompt('', []), '');
});

test('mergeAgeNegativeIntoPrompt 幂等：重复调用不重复追加', () => {
  const once = mergeAgeNegativeIntoPrompt('lowres', ['7yo'], { prompt: '1boy' });
  const twice = mergeAgeNegativeIntoPrompt(once, ['7yo'], { prompt: '1boy' });
  assert.equal(twice, once);
});
