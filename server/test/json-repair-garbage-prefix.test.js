import test from 'node:test';
import assert from 'node:assert/strict';

import { robustJsonLoads } from '../utils/json-repair.js';

test('robustJsonLoads：剥离流式粘连的 {"{"{ 垃圾前缀后解析数组', () => {
  const garbage = '{"{"{"{"{"{"{"{"{"{"{d{[{[\n';
  const body = '[\n {"name":"甲"},\n {"name":"乙"}\n]';
  const parsed = robustJsonLoads(`${garbage}${body}`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, '甲');
});

test('robustJsonLoads：正常 JSON 数组不受影响', () => {
  const parsed = robustJsonLoads('[{"name":"丙"}]');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, '丙');
});
