import test from 'node:test';
import assert from 'node:assert/strict';

import { isAgeDescriptorTag, stripAgeDescriptors, stripAgeWords } from '../utils/age-tags.js';

test('stripAgeWords 删除纯成年年龄标签', () => {
  assert.equal(stripAgeWords('adult'), '');
  assert.equal(stripAgeWords('18yo'), '');
  assert.equal(stripAgeWords('20 years old'), '');
  assert.equal(stripAgeWords('25岁'), '');
  assert.equal(stripAgeWords('mature'), '');
  assert.equal(stripAgeWords('elderly'), '');
});

test('stripAgeWords 保留复合标签中的性别/体型部分', () => {
  assert.equal(stripAgeWords('mature_female'), 'female');
  assert.equal(stripAgeWords('old_man'), 'man');
  assert.equal(stripAgeWords('elderly_woman'), 'woman');
});

// 用户明确要求：只削成年标记，其余年龄语汇（shota/loli/young/teen/child/kid）原样保留。
// 脸模 danbooru_tag 常常就是 shota_ 这类词，削掉就彻底失效。
test('stripAgeWords 保留 shota/loli/young/teen 等非成年标记', () => {
  assert.equal(stripAgeWords('shota_'), 'shota_');
  assert.equal(stripAgeWords('shota'), 'shota');
  assert.equal(stripAgeWords('loli'), 'loli');
  assert.equal(stripAgeWords('young'), 'young');
  assert.equal(stripAgeWords('teen'), 'teen');
  assert.equal(stripAgeWords('teenager'), 'teenager');
  assert.equal(stripAgeWords('child'), 'child');
  assert.equal(stripAgeWords('kid'), 'kid');
  assert.equal(stripAgeWords('young_woman'), 'young_woman');
  assert.equal(stripAgeWords('A young woman with silver hair'), 'A young woman with silver hair');
});

test('stripAgeWords 只剔除 18 岁及以上的数字年龄', () => {
  assert.equal(stripAgeWords('15yo'), '15yo');
  assert.equal(stripAgeWords('17 years old'), '17 years old');
  assert.equal(stripAgeWords('18yo'), '');
  assert.equal(stripAgeWords('30yo'), '');
});

test('stripAgeWords 不影响正常体型与外貌标签', () => {
  assert.equal(stripAgeWords('slim'), 'slim');
  assert.equal(stripAgeWords('petite, long_legs, black_hair'), 'petite, long_legs, black_hair');
  assert.equal(stripAgeWords('broad_shoulders'), 'broad_shoulders');
});

// 专有名词回归：脸模 danbooru_tag 与作品名被削掉前缀就彻底失效，不能当年龄描述剔除。
test('stripAgeWords 保留专有名词标签中的 age 词根', () => {
  assert.equal(stripAgeWords('old_face_model'), 'old_face_model');
  assert.equal(stripAgeWords('teen_titans'), 'teen_titans');
  assert.equal(stripAgeWords('young justice'), 'young justice');
  assert.equal(stripAgeWords('hutao'), 'hutao');
  assert.equal(stripAgeWords('asuka_langley_soryu'), 'asuka_langley_soryu');
  assert.equal(stripAgeWords('old_face_model, long hair'), 'old_face_model, long hair');
});

test('stripAgeDescriptors 清洗标签数组', () => {
  assert.deepEqual(
    stripAgeDescriptors(['adult', '18yo', 'young_woman', 'shota_', 'slim']),
    ['young_woman', 'shota_', 'slim']
  );
});

test('isAgeDescriptorTag 只对纯成年年龄标签返回 true', () => {
  assert.equal(isAgeDescriptorTag('adult'), true);
  assert.equal(isAgeDescriptorTag('18yo'), true);
  assert.equal(isAgeDescriptorTag('slim'), false);
  assert.equal(isAgeDescriptorTag('young_woman'), false);
  assert.equal(isAgeDescriptorTag('shota_'), false);
  assert.equal(isAgeDescriptorTag('loli'), false);
});
