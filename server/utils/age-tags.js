/**
 * 年龄描述过滤。
 *
 * 生图 Prompt 只描述可见体型，不写年龄；年龄词（adult / 18yo / young / teen 等）
 * 容易把角色锁死在某个年龄感上，统一在进入 Prompt 前剔除。
 */
const AGE_WORDS = [
  'adult',
  'teen',
  'teenager',
  'young',
  'mature',
  'elderly',
  'aged',
  'loli',
  'lolibaba',
  'shota',
  'child',
  'kid',
  'minor',
  'underage',
  'old'
].join('|');

const AGE_COMPONENT_PATTERN = new RegExp(
  `(^|[_,\\s-])(?:${AGE_WORDS})(?=[_,\\s-]|$)`,
  'gi'
);
const AGE_NUMBER_PATTERN = /\b\d{1,2}\s*(?:yo|y\.?o\.?|years?[-_ ]?old)\b|\d{1,2}\s*岁/gi;

/**
 * 就地剔除 age 词，保留可用的性别/体型部分：
 *   adult           -> ''
 *   18yo            -> ''
 *   young_woman     -> woman
 *   mature_female   -> female
 *   A young woman   -> A woman
 */
export function stripAgeWords(value) {
  let text = String(value || '');
  if (!text) return '';
  text = text.replace(AGE_NUMBER_PATTERN, ' ');
  text = text.replace(AGE_COMPONENT_PATTERN, '$1');
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/_\s*_/g, '_')
    .replace(/^[_,\s-]+|[_,\s-]+$/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*|\s*,\s*$/g, '')
    .trim();
}

/**
 * 清洗一组标签/短语，返回剔除年龄词后的非空结果。
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
 * 判断一个标签是否只由年龄描述构成（清洗后为空）。
 */
export function isAgeDescriptorTag(value) {
  const raw = String(value || '').trim();
  return Boolean(raw) && stripAgeWords(raw) === '';
}
