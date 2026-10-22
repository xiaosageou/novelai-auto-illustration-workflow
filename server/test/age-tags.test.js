import test from 'node:test';
import assert from 'node:assert/strict';

import { isAgeDescriptorTag, stripAgeDescriptors, stripAgeWords } from '../utils/age-tags.js';

test('stripAgeWords 删除纯年龄标签', () => {
  assert.equal(stripAgeWords('adult'), '');
  assert.equal(stripAgeWords('18yo'), '');
  assert.equal(stripAgeWords('20 years old'), '');
  assert.equal(stripAgeWords('25岁'), '');
  assert.equal(stripAgeWords('teen'), '');
});

test('stripAgeWords 保留复合标签中的性别/体型部分', () => {
  assert.equal(stripAgeWords('young_woman'), 'woman');
  assert.equal(stripAgeWords('mature_female'), 'female');
  assert.equal(stripAgeWords('old_man'), 'man');
  assert.equal(stripAgeWords('A young woman with silver hair'), 'A woman with silver hair');
});

test('stripAgeWords 不影响正常体型与外貌标签', () => {
  assert.equal(stripAgeWords('slim'), 'slim');
  assert.equal(stripAgeWords('petite, long_legs, black_hair'), 'petite, long_legs, black_hair');
  assert.equal(stripAgeWords('broad_shoulders'), 'broad_shoulders');
});

test('stripAgeDescriptors 清洗标签数组', () => {
  assert.deepEqual(
    stripAgeDescriptors(['adult', '18yo', 'young_woman', 'slim']),
    ['woman', 'slim']
  );
});

test('isAgeDescriptorTag 只对纯年龄标签返回 true', () => {
  assert.equal(isAgeDescriptorTag('adult'), true);
  assert.equal(isAgeDescriptorTag('18yo'), true);
  assert.equal(isAgeDescriptorTag('slim'), false);
  assert.equal(isAgeDescriptorTag('young_woman'), false);
});
