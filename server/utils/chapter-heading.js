// 章节标题识别模块
// 目标：
//  1. 覆盖真实小说中常见的标题形态（第X章/节/回/话、卷/部/篇、方括号包裹、书名前缀、序章/番外、英文 Chapter、中文/阿拉伯数字列表等）。
//  2. 过滤"长得像标题的正文"，例如 "第一节课"、"第一节下课后，……"、"1.李总最近越发贪吃嗜睡……" 这类行。

const CN_DIGITS = '〇零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟';
const NUM = `[${CN_DIGITS}\\d０-９]+`;

// 章节单位：章（强），回/节/话（弱）
const CHAPTER_UNITS = '章回节節话話';
const STRONG_UNITS = '章';

// 卷/部级单位
const VOLUME_UNITS = '卷部篇集册';

// 强单位后若"无分隔符"紧跟这些字，通常说明该行是正文而不是标题（如"第一章的内容……"）
const BODY_CONTINUATION = '的是中里内上下前后之讲说写提到有没有就都也还而但却与和及为之所因把被让使给对向往从在等将则即乃';

// 特殊标题词（序章/番外等）
const SPECIAL_WORDS = [
  '序章', '序言', '楔子', '引子', '序幕', '前言',
  '尾声', '后记', '终章', '结局', '大结局',
  '番外篇', '番外', '外传', '后传', '前传'
];

const BRACKET_PAIRS = [
  ['【', '】'],
  ['（', '）'],
  ['(', ')'],
  ['[', ']'],
  ['《', '》']
];

const MAX_HEADING_LENGTH = 100;
const MAX_TITLE_LENGTH = 60;
const MAX_LIST_TITLE_LENGTH = 24;

function isVolumeHeadingText(text) {
  return new RegExp(`^第\\s*${NUM}\\s*[${VOLUME_UNITS}]\\s*(.*)$`).test(text);
}

/** 是否为卷/部/篇/集/册级标题（由 parseNovel 单独处理） */
export function isVolumeHeading(line = '') {
  const text = String(line || '').trim();
  if (!text || text.length > MAX_HEADING_LENGTH) return false;
  return isVolumeHeadingText(text);
}

/** 形如 【第1章】/【第一章】入场券/向往的生活特别篇【第一章】入场券 */
function matchBracketedChapter(text) {
  for (const [open, close] of BRACKET_PAIRS) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) continue;
    const inner = text.slice(start + open.length, end).trim();
    if (!new RegExp(`^第\\s*${NUM}\\s*[${CHAPTER_UNITS}]`).test(inner)) continue;
    const prefix = text.slice(0, start).trim();
    if (prefix.length > 30) return null;
    if (/[。！？!?]/.test(prefix)) return null;
    return text;
  }
  return null;
}

/** 行首严格的 第X章/节/回/话（可带标题） */
function matchStrictChapter(text) {
  const m = new RegExp(`^第\\s*${NUM}\\s*([${CHAPTER_UNITS}])([\\s\\S]*)$`).exec(text);
  if (!m) return null;
  const unit = m[1];
  const rawTail = m[2];
  const hasSeparator = /^[\s:：、.．\-—]/.test(rawTail);
  const nextChar = rawTail.replace(/^\s+/, '').charAt(0);
  const tail = rawTail.replace(/^[\s:：、.．\-—]+/, '').trim();

  if (STRONG_UNITS.includes(unit)) {
    // "第一章的内容……"：无分隔符且紧跟正文续接字 -> 正文
    if (!hasSeparator && nextChar && BODY_CONTINUATION.includes(nextChar)) return null;
  } else {
    // 弱单位（节/回/话）必须"标题为空"或"有分隔符"，否则 "第一节课" / "第一节下课后" 视为正文
    if (!hasSeparator && tail) return null;
    // 弱单位标题不应包含句读/逗号，出现则多半是正文（如"第一节 课时，那个说要烧同学书。"）
    if (/[。！？，,；;]/.test(tail)) return null;
  }

  if (tail.length > MAX_TITLE_LENGTH) return null;
  return text;
}

/** 书名/系列名前缀 + 空格 + 第X章 */
function matchPrefixedChapter(text) {
  const m = new RegExp(`^(.{1,40}?)\\s+(第\\s*${NUM}\\s*[${CHAPTER_UNITS}])\\s*(.*)$`).exec(text);
  if (!m) return null;
  const prefix = m[1].trim();
  if (/[,，。！？!?；;：:“”"'、]/.test(prefix)) return null;
  const tail = m[3].trim();
  if (tail.length > MAX_TITLE_LENGTH) return null;
  return `${m[2].replace(/\s+/g, '')}${tail ? ` ${tail}` : ''}`;
}

/** 序章/楔子/尾声/番外 等特殊标题 */
function matchSpecialChapter(text) {
  const body = text.replace(/^正文\s+/, '').trim();
  for (const word of SPECIAL_WORDS) {
    if (body === word) return text;
    if (!body.startsWith(word)) continue;
    const rest = body.slice(word.length);
    // 必须紧跟分隔符或编号（番外一 / 番外 1 / 番外：xxx），否则视为正文（如"番外篇的故事背景……"）
    if (/^[\s:：、.．\-—0-9０-９一二三四五六七八九十]/.test(rest)) return text;
    return null;
  }
  return null;
}

/** 在线阅读器进度行："正在閱讀第1章，共131章" -> "第1章" */
function matchReaderProgressChapter(text) {
  const m = new RegExp(`^正在(?:閱讀|阅读)第\\s*(${NUM})\\s*[${CHAPTER_UNITS}]\\s*[，,、]?\\s*共\\s*${NUM}\\s*[${CHAPTER_UNITS}]`).exec(text);
  if (!m) return null;
  return `第${m[1]}章`;
}

/** 英文 Chapter 1 / Chap.1 / Part 1 */
function matchWesternChapter(text) {
  const m = /^(?:chapter|chap\.?|ch\.?|part)\s*([0-9]+|[ivxlcdm]+)\b[\s:：.、\-—]*(.*)$/i.exec(text);
  if (!m) return null;
  if (m[2].trim().length > MAX_TITLE_LENGTH) return null;
  return text;
}

/** 中文数字列表（一、二、）/ 阿拉伯数字列表（1. / 1、 / 1）） */
function matchListHeading(text) {
  const cn = new RegExp(`^([${CN_DIGITS}]{1,6})\\s*[、.．]\\s*(.+)$`).exec(text);
  const ar = /^(\d{1,4})\s*[、.．)）]\s*(.+)$/.exec(text);
  const m = cn || ar;
  if (!m) return null;
  const title = m[2].trim();
  if (!title || title.length > MAX_LIST_TITLE_LENGTH) return null;
  if (/^[\d０-９]/.test(title)) return null;
  // 逗号/句读/引号通常是正文；冒号、顿号、括号在标题（如"番外：xxx（一）"）中允许
  if (/[。！？，,；;“”‘’"']/.test(title)) return null;
  if (!/[\u4e00-\u9fff]/.test(title)) return null;
  return text;
}

/**
 * 裸数字标题候选（无分隔符）：如 "1朋友"、"2我养"。
 * 只做行内静态判断，真正是否采纳交给 selectBareNumberHeadings 的序列校验。
 */
export function matchBareNumberHeading(line = '') {
  const text = String(line || '').trim();
  if (!text || text.length > 20) return null;
  // 排除时间/日期/比例/版本：22：30、2024.1、3/4、1:2、1-2
  if (/^\d{1,4}\s*[：:／/.\-]\s*\d/.test(text)) return null;
  const m = /^(\d{1,3})([^\d\s].*)$/.exec(text);
  if (!m) return null;
  const number = Number(m[1]);
  const title = m[2].trim();
  if (!title || title.length > 14) return null;
  if (/[。]/.test(title)) return null;
  // 排除已带列表分隔符的形式（"3、初见" 由常规规则处理）
  if (/^[、.．)）]/.test(title)) return null;
  if (!/[\u4e00-\u9fff]/.test(title)) return null;
  return { number, title };
}

/** 返回严格递增子序列在 nums 中的下标 */
function longestIncreasingSubsequence(nums) {
  const tails = [];
  const prev = new Array(nums.length).fill(-1);
  for (let i = 0; i < nums.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nums[tails[mid]] < nums[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const result = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    result.push(k);
    k = prev[k];
  }
  return result.reverse();
}

/**
 * 在整篇文本范围内挑选可信的裸数字标题行。
 * 判定：孤立行 + 短标题 + 编号近似严格递增（LIS 覆盖率高）。
 * @returns {Set<number>} 被采纳的裸数字标题所在行下标
 */
export function selectBareNumberHeadings(lines = []) {
  const arr = Array.isArray(lines) ? lines : [];
  const candidates = [];
  for (let i = 0; i < arr.length; i++) {
    const text = String(arr[i] || '').trim();
    const cand = matchBareNumberHeading(text);
    if (!cand) continue;
    // 已能被常规规则识别的不参与裸数字判定
    if (parseChapterHeading(text)) continue;
    // 孤立行：前后至少一侧是空行
    const prevBlank = i === 0 || !String(arr[i - 1] || '').trim();
    const nextBlank = i === arr.length - 1 || !String(arr[i + 1] || '').trim();
    if (!prevBlank && !nextBlank) continue;
    candidates.push({ index: i, number: cand.number });
  }

  if (candidates.length < 5) return new Set();

  const lis = longestIncreasingSubsequence(candidates.map(c => c.number));
  if (lis.length < 5 || lis.length < candidates.length * 0.7) return new Set();
  return new Set(lis.map(k => candidates[k].index));
}

/**
 * 解析一行文本是否为章节标题。
 * @returns {string|null} 识别为标题时返回标题文本，否则 null
 */
export function parseChapterHeading(line = '') {
  const text = String(line || '').trim();
  if (!text || text.length > MAX_HEADING_LENGTH) return null;
  // 卷/部级标题交给 isVolumeHeading 处理，避免被当成章
  if (isVolumeHeadingText(text)) return null;

  return (
    matchReaderProgressChapter(text)
    || matchBracketedChapter(text)
    || matchStrictChapter(text)
    || matchPrefixedChapter(text)
    || matchSpecialChapter(text)
    || matchWesternChapter(text)
    || matchListHeading(text)
    || null
  );
}
