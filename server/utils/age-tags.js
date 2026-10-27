/**
 * 成年年龄标记过滤。
 *
 * 只剔除会把人锁成「成年/中老年」的标签（adult / mature / elderly / old / 18yo 等），
 * 其余年龄语汇（shota / loli / young / teen / child / kid）一律原样保留：
 * 脸模 danbooru_tag 常常就是 shota_ 这类词，削掉就彻底失效。
 *
 * 仍然保留白名单机制，避免削坏专有名词：
 *   old_face_model   -> old_face_model   （不是独立 age 标签，不动）
 *   old_man          -> man              （age 词 + 体型词，只削 age 词）
 *   adult            -> ''               （独立 age 标签，整串剔除）
 */
const ADULT_WORDS = [
  'adult',
  'mature',
  'elderly',
  'aged',
  'old',
  'milf',
  'gilf',
  'dilf',
  'granny',
  'grandma'
].join('|');

// 只有「独立成标签」或「修饰可见体型/人称词」时才剔除。
// 否则会削坏专有名词标签：old_face_model → face_model、old_justice → justice。
const ADULT_TARGET_WORDS = 'woman|women|man|men|girl|girls|boy|boys|female|male|lady|ladies|person|people|figure|body|physique|appearance';
const ADULT_STANDALONE_PATTERN = new RegExp(`^[_,\\s-]*(?:${ADULT_WORDS})[_,\\s-]*$`, 'i');
const ADULT_MODIFIER_PATTERN = new RegExp(
  `(^|[_,\\s-])(?:${ADULT_WORDS})(?=[_,\\s-]+(?:${ADULT_TARGET_WORDS})(?=[_,\\s-]|$))`,
  'gi'
);

// 数字年龄：只剔除 ≥18 的写法。「15yo」这类保留，因为用户要求不动非成年标记。
const AGE_NUMBER_PATTERN = /\b(\d{1,2})\s*(?:yo|y\.?o\.?|years?[-_ ]?old)\b|(\d{1,2})\s*岁/gi;
const ADULT_AGE_FLOOR = 18;

/**
 * 就地剔除成年年龄词，保留可用的性别/体型部分：
 *   adult           -> ''
 *   18yo            -> ''
 *   old_man         -> man
 *   mature_female   -> female
 *   shota_          -> shota_          （保留）
 *   loli            -> loli            （保留）
 *   young_woman     -> young_woman     （保留）
 */
export function stripAgeWords(value) {
  const original = String(value || '');
  if (!original) return '';
  const trimmed = original.trim();
  if (ADULT_STANDALONE_PATTERN.test(trimmed)) return '';
  const digitsHandled = trimmed.replace(AGE_NUMBER_PATTERN, (match, g1, g2) => {
    const age = Number(g1 || g2);
    return Number.isFinite(age) && age >= ADULT_AGE_FLOOR ? ' ' : match;
  });
  const adultHandled = digitsHandled.replace(ADULT_MODIFIER_PATTERN, '$1');
  // 没有真正命中成年词时原样返回：否则尾随下划线会被清洗削掉（shota_ -> shota）。
  if (adultHandled === trimmed) return trimmed;
  return adultHandled
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/_\s*_/g, '_')
    .replace(/^[_,\s-]+|[_,\s-]+$/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
}

/**
 * 清洗一组标签/短语，返回剔除成年年龄词后的非空结果。
 */
export function stripAgeDescriptors(values = []) {
  const list = Array.isArray(values)
    ? values
    : String(values || '').split(/[,，]/);
  return list
    .map(value => stripAgeWords(value))
    .filter(Boolean);
}

/**
 * 判断一个标签是否只由成年年龄描述构成（清洗后为空）。
 */
export function isAgeDescriptorTag(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && stripAgeWords(raw) === '';
}
