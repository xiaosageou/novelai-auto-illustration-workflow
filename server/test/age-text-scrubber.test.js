import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChineseAge,
  scrubMinorAgeText,
  scrubMinorAgeDeep,
  scrubChatPayload
} from '../utils/age-text-scrubber.js';

test('parseChineseAge 解析常用中文年龄写法', () => {
  assert.equal(parseChineseAge('十五'), 15);
  assert.equal(parseChineseAge('十七'), 17);
  assert.equal(parseChineseAge('十八'), 18);
  assert.equal(parseChineseAge('十'), 10);
  assert.equal(parseChineseAge('二十五'), 25);
  assert.equal(parseChineseAge('二十'), 20);
  assert.equal(parseChineseAge('十六七'), 16);
  assert.equal(parseChineseAge('七'), 7);
  assert.equal(parseChineseAge(''), null);
});

test('scrubMinorAgeText 删除阿拉伯数字未成年年龄', () => {
  assert.equal(scrubMinorAgeText('15岁的少女站在门口。'), '少女站在门口。');
  assert.equal(scrubMinorAgeText('她才15岁。'), '她。');
  assert.equal(scrubMinorAgeText('她今年 17 岁'), '她今年');
  assert.equal(scrubMinorAgeText('少女 15 周岁，穿着一身白衣'), '少女，穿着一身白衣');
  assert.equal(scrubMinorAgeText('十五岁半的林月'), '林月');
});

test('scrubMinorAgeText 删除中文数字未成年年龄', () => {
  assert.equal(scrubMinorAgeText('十五岁的少女站在门口。'), '少女站在门口。');
  assert.equal(scrubMinorAgeText('她年方十五，容貌清丽。'), '她容貌清丽。');
  assert.equal(scrubMinorAgeText('刚满十六岁的少年'), '少年');
  assert.equal(scrubMinorAgeText('十六七岁的年纪'), '年纪');
});

test('scrubMinorAgeText 保留 18 岁及以上写法', () => {
  assert.equal(scrubMinorAgeText('18岁的少女'), '18岁的少女');
  assert.equal(scrubMinorAgeText('二十岁的女子'), '二十岁的女子');
  assert.equal(scrubMinorAgeText('25 岁'), '25 岁');
  assert.equal(scrubMinorAgeText('三十岁'), '三十岁');
});

test('scrubMinorAgeText 处理英文年龄', () => {
  assert.equal(scrubMinorAgeText('She is 15 years old'), 'She is');
  assert.equal(scrubMinorAgeText('a 12 yo girl'), 'a girl');
  assert.equal(scrubMinorAgeText('She is 24 years old'), 'She is 24 years old');
});

test('scrubMinorAgeText 不动无关文本与「岁月/岁数」类词', () => {
  const text = '岁月流逝，岁数见长，她的身形纤细。';
  assert.equal(scrubMinorAgeText(text), text);
  assert.equal(scrubMinorAgeText(''), '');
  assert.equal(scrubMinorAgeText(null), '');
  assert.equal(scrubMinorAgeText(undefined), '');
});

test('scrubMinorAgeText 幂等', () => {
  const once = scrubMinorAgeText('十五岁的少女，今年才15岁。');
  assert.equal(scrubMinorAgeText(once), once);
});

test('scrubMinorAgeDeep 处理嵌套对象与多模态数组且不改动原对象', () => {
  const input = {
    visual_description: '十五岁的少女站在庭院里',
    characters: [{ name: '林月', clothing: '白衣', note: '今年才 15 岁' }],
    messages: [{ type: 'text', text: '她16岁' }],
    count: 3,
    flag: true
  };
  const out = scrubMinorAgeDeep(input);
  assert.equal(out.visual_description, '少女站在庭院里');
  assert.equal(out.characters[0].note, '今年');
  assert.equal(out.characters[0].clothing, '白衣');
  assert.equal(out.messages[0].text, '她');
  assert.equal(out.count, 3);
  assert.equal(out.flag, true);
  // 原对象不被污染
  assert.equal(input.visual_description, '十五岁的少女站在庭院里');
  assert.equal(input.characters[0].note, '今年才 15 岁');
});

test('scrubChatPayload 只改 messages 且不动调用方 payload', () => {
  const payload = {
    model: 'x',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '十五岁的少女在溪边' }
    ]
  };
  const out = scrubChatPayload(payload);
  assert.equal(out.messages[1].content, '少女在溪边');
  assert.equal(out.messages[0].content, '你是助手');
  assert.equal(out.model, 'x');
  assert.equal(payload.messages[1].content, '十五岁的少女在溪边');
  // 无 messages 时原样返回
  assert.deepEqual(scrubChatPayload({ model: 'y' }), { model: 'y' });
  assert.equal(scrubChatPayload(null), null);
});
