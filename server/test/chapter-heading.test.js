import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChapterHeading, isVolumeHeading, selectBareNumberHeadings, matchBareNumberHeading } from '../utils/chapter-heading.js';

test('recognizes common chapter heading forms', () => {
  const positives = [
    '第一章',
    '第一章  入场券',
    '第001章 重生',
    '第0010章 幻梦',
    '第1章 发现A级炉鼎',
    '第01章',
    '第十一章 番外篇',
    '第1章：开始',
    '第2章 学姐的第一次？',
    '第1章 龙傲天骚穴求干。',
    '第2话 相遇',
    '第三回 大闹天宫',
    '【第1章】',
    '【第一章】入场券',
    '向往的生活特别篇【第一章】入场券',
    '（第一章）开端',
    'Chapter 1',
    'Chap. 2 The Road',
    'Part 3',
    '序章',
    '正文 楔子',
    '尾声',
    '番外篇',
    '番外一',
    '番外 1 婚后日常',
    '一、大学刑法课 原版+番外',
    '1. 白眼狼们的小羊',
    '3、初见',
    '5）离场',
    '225. 番外：爱你（一）哥哥的小公主',
    '正在閱讀第1章，共131章',
    '正在阅读第5章，共34章'
  ];
  for (const line of positives) {
    assert.ok(parseChapterHeading(line), `expected heading: ${line}`);
  }
});

test('filters body text that merely looks like a heading', () => {
  const negatives = [
    '第一节课',
    '第一节下课后，我起身过去打算跟程晓说两句话。',
    '第一节 课时，那个说要烧同学书。',
    '第一章的内容讲的是罪刑法定主义。',
    '于是就在第一节下课后，我起身过去。',
    '1.李总最近越发贪吃嗜睡，原本棱角分明的脸都圆润了一圈。',
    '4.半夜我再起来，他已经睡熟了，手指捏成个拳头。',
    '番外篇的故事背景是在第五堂课刚上完时。',
    '尾声，泵射精液的频率开始减慢。',
    '这一顿夜宵逐渐接近尾声。',
    '2024.1.1 新年快乐',
    '1.5 版本说明',
    '【作品编号：197606】  完结',
    '【许千：让收银员热了，不凉。】',
    '第２０章后的辣文直接收费的唷，谢谢旧雨新知的支持与爱护'
  ];
  for (const line of negatives) {
    assert.equal(parseChapterHeading(line), null, `expected body text, got heading: ${line}`);
  }
});

test('detects volume headings separately from chapters', () => {
  assert.equal(isVolumeHeading('第一部 大学刑法课 原版+番外'), true);
  assert.equal(isVolumeHeading('第一卷'), true);
  assert.equal(isVolumeHeading('第三篇 远行'), true);
  assert.equal(isVolumeHeading('第一章'), false);
  assert.equal(parseChapterHeading('第一部 大学刑法课 原版+番外'), null);
});

test('bare number + title is not recognized at line level', () => {
  assert.equal(parseChapterHeading('1朋友'), null);
  assert.equal(parseChapterHeading('2我养'), null);
});

test('bare-number headings are accepted only when isolated, short and sequence-valid', () => {
  const lines = [
    '1朋友', '', '正文一', '',
    '2我养', '', '正文二', '',
    '3咱们走楼梯吧', '', '正文三', '',
    '4不是疼哭的', '', '正文四', '',
    '5林言，你要留女人过夜?', '', '正文五'
  ];
  const set = selectBareNumberHeadings(lines);
  assert.deepEqual([...set].sort((a, b) => a - b), [0, 4, 8, 12, 16]);
});

test('bare-number headings are rejected when too few or not increasing', () => {
  const few = ['1朋友', '', '正文', '', '2我养', '', '正文', '', '3咱们走楼梯吧'];
  assert.equal(selectBareNumberHeadings(few).size, 0);

  const messy = [
    '5朋友', '', '正文', '', '2我养', '', '正文', '',
    '9咱们走楼梯吧', '', '正文', '', '1不是疼哭的', '', '正文', '',
    '7回去就表白吧'
  ];
  assert.equal(selectBareNumberHeadings(messy).size, 0);
});

test('matchBareNumberHeading rejects time/date/version-like lines', () => {
  assert.equal(matchBareNumberHeading('22：30。'), null);
  assert.equal(matchBareNumberHeading('2024.1.1 新年快乐'), null);
  assert.equal(matchBareNumberHeading('1.5 版本说明'), null);
  assert.ok(matchBareNumberHeading('1朋友'));
});
