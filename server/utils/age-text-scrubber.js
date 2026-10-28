/**
 * 正文年龄脱敏（text-level minor age scrubber）
 *
 * 目的：生成 prompt 的 LLM 接收的是小说原文 / 场景描述 / 分镜卡这类自由文本，
 * 这些正文里常出现「十五岁的少女」「她今年才 15 岁」这种明确未成年年龄写法。
 * 本模块在出站前把这些年龄表达整段删掉（连同紧邻的「的」一起删，避免留下病句），
 * 只处理 < 18 岁的写法；18 岁及以上原样保留。
 *
 * 与 age-proxy.js 的分工：
 *   - age-proxy.js  处理结构化视图（DNA tags / features），未成年 → adult
 *   - 本模块         处理自由正文，未成年年龄表达 → 直接删除
 *
 * 覆盖写法：
 *   15岁 / 15 岁 / 15周岁 / 十五岁 / 十六七岁 / 年方十五 / 刚满十五 / 十五岁半 / 十五岁零三个月
 *   15 yo / 15 years old / age 15
 *   十八岁以下、二十岁 这类 >=18 的一律不动
 */

const CN_DIGIT = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};
const CN_NUM_CHARS = '零〇一二两三四五六七八九十';

export const MINOR_TEXT_AGE_FLOOR = 18;

/**
 * 解析中文数字年龄。
 * 「十五」→ 15、「二十五」→ 25、「十六七」→ 16、「十」→ 10、「七」→ 7。
 * 解析不出返回 null。
 */
export function parseChineseAge(text) {
  const raw = String(text || '').replace(new RegExp(`[^${CN_NUM_CHARS}]`, 'g'), '');
  if (!raw) return null;
  const tenIdx = raw.indexOf('十');
  if (tenIdx >= 0) {
    const head = raw.slice(0, tenIdx);
    const tail = raw.slice(tenIdx + 1);
    const tens = head ? CN_DIGIT[head[head.length - 1]] : 1;
    if (tens === undefined || tens === null) return null;
    const units = tail ? (CN_DIGIT[tail[0]] ?? 0) : 0;
    return tens * 10 + units;
  }
  const first = CN_DIGIT[raw[0]];
  return first === undefined ? null : first;
}

// 年龄前的程度/时态前缀，删年龄时一起删掉，免得留下「年方，」这种残句。
// 只收完整前缀，不收裸「才 / 今年」，否则「今年才15岁」会被吃成「今」。
const AGE_PREFIX = '(?:年方|年仅|年已|刚满|刚过|快要|还未满|未满|不满|大约|约摸|约|不到)?';
// 年龄后的余量说法，同样一起删。
const AGE_TAIL = '(?:\\s*(?:半|多|出头|有余|零[' + CN_NUM_CHARS + ']{1,3}(?:个)?月|零\\d{1,2}(?:个)?月))?';

const CN_AGE_PATTERN = new RegExp(
  `${AGE_PREFIX}\\s*([${CN_NUM_CHARS}]{1,4})\\s*岁${AGE_TAIL}\\s*的?`,
  'g'
);
const DIGIT_AGE_PATTERN = new RegExp(
  `${AGE_PREFIX}\\s*(\\d{1,3})\\s*(?:周)?岁${AGE_TAIL}\\s*的?`,
  'g'
);
// 文言写法：没有「岁」字，只有「年方十五」「年仅十六」。
const CN_CLASSICAL_AGE_PATTERN = new RegExp(
  `(?:年方|年仅|年已)\\s*([${CN_NUM_CHARS}]{1,4})\\s*[，,]?`,
  'g'
);
const EN_AGE_PATTERNS = [
  /\b(\d{1,2})\s*(?:yo|y\/o|y\.o\.?|years?[\s-]*old|year[\s-]*old)\b[,\s]*/gi,
  /\b(\d{1,2})\s*(?:years?|yrs?)[\s-]*old\b[,\s]*/gi,
  /\bage\s*(\d{1,2})\b[,\s]*/gi
];

/** 删除后留下的重复标点 / 悬空空白整理一下，不改变其余正文。 */
function tidy(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/([，,、；;])\s*(?=[，,、；;])/g, '')
    .replace(/(^|[。！？；\n])\s*[，,、]/g, '$1')
    .replace(/[ \t]+([，,。！？；：、）】」』])/g, '$1')
    .replace(/([（【「『])[ \t]+/g, '$1')
    // 删除年龄后可能留下悬空的程度词（「她才。」「今年才」），一并清掉。
    .replace(/才\s*(?=[，,。！？；：、）】」』]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([。！？])/g, '$1')
    .replace(/[ \t]+$/, '');
}

/**
 * 从一段正文里删掉所有 < 18 岁的年龄表达。18 岁及以上原样保留。
 * 非字符串输入按字符串处理后返回 ''，null/undefined 返回 ''。
 */
export function scrubMinorAgeText(value) {
  if (value === null || value === undefined) return '';
  const original = typeof value === 'string' ? value : String(value);
  if (!original) return original;

  let touched = false;
  let out = original.replace(DIGIT_AGE_PATTERN, (match, digits) => {
    const age = Number(digits);
    if (!Number.isFinite(age) || age >= MINOR_TEXT_AGE_FLOOR) return match;
    touched = true;
    return '';
  });
  out = out.replace(CN_AGE_PATTERN, (match, cn) => {
    const age = parseChineseAge(cn);
    if (age === null || age >= MINOR_TEXT_AGE_FLOOR) return match;
    touched = true;
    return '';
  });
  out = out.replace(CN_CLASSICAL_AGE_PATTERN, (match, cn) => {
    const age = parseChineseAge(cn);
    if (age === null || age >= MINOR_TEXT_AGE_FLOOR) return match;
    touched = true;
    return '';
  });
  for (const pattern of EN_AGE_PATTERNS) {
    out = out.replace(pattern, (match, digits) => {
      const age = Number(digits);
      if (!Number.isFinite(age) || age >= MINOR_TEXT_AGE_FLOOR) return match;
      touched = true;
      return '';
    });
  }
  if (!touched) return original;
  return tidy(out);
}

/**
 * 递归脱敏任意 JSON 结构里的所有字符串（含 messages content 的多模态数组）。
 * 非字符串原样返回；不改动输入对象。
 */
export function scrubMinorAgeDeep(value, depth = 0) {
  if (depth > 24) return value;
  if (typeof value === 'string') return scrubMinorAgeText(value);
  if (Array.isArray(value)) return value.map(item => scrubMinorAgeDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubMinorAgeDeep(item, depth + 1);
    return out;
  }
  return value;
}

/**
 * 对外发请求前统一脱敏 payload.messages。
 * 不改动调用方对象；没有 messages 时原样返回 payload。
 */
export function scrubChatPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (!Array.isArray(payload.messages)) return payload;
  return { ...payload, messages: scrubMinorAgeDeep(payload.messages) };
}
