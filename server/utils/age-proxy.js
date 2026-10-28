/**
 * 年龄代理（age proxy）
 *
 * 目的：DNA 里如实保存角色真实年龄，但送给「生成画面 prompt 的 LLM」时，
 * 凡是 18 岁以下或 child / kid / loli / shota 一类未成年描述，一律代理成 adult。
 * 真正出图前（Prompt 已定稿、只等 NAI 渲染）再把真实年龄补回人物段。
 *
 * 这样：LLM 永远看不到未成年年龄 → 不会产出 child / loli / shota / teen 标签；
 * 但用户配置的真实年龄不会丢，仍然会写进最终生图 prompt。
 */

import { stripAgeWords } from './age-tags.js';

export const ADULT_AGE_FLOOR = 18;

/** DNA 里存放年龄的槽位（llm-extractor 归一化后固定这两个键） */
export const AGE_FEATURE_KEYS = ['年龄标签', '年龄感标签'];

/** 明确的未成年词（独立标签级别命中，含下划线/空格变体） */
const MINOR_AGE_WORDS = [
  'child', 'children', 'kid', 'kids', 'toddler', 'infant', 'baby',
  'loli', 'lolita', 'shota', 'shotacon', 'lolicon',
  'underage', 'minor', 'preteen',
  'little girl', 'little boy', 'young girl', 'young boy',
  'schoolgirl', 'schoolboy',
  'elementary schooler', 'middle schooler', 'middle school student',
  'teen', 'teenager'
];

const MINOR_WORD_PATTERN = new RegExp(
  `(?:^|[^a-z0-9_])(?:${MINOR_AGE_WORDS.map(word => word.replace(/\s+/g, '[ _]')).join('|')})(?:$|[^a-z0-9_])`,
  'i'
);

const AGE_NUMBER_PATTERNS = [
  /(?<!\d)(\d{1,2})\s*[\s_-]*(?:yo|y\/o|y\.o\.?|years?[\s_-]?old|year[\s_-]?old|岁)/i,
  /(?:age|年龄)[\s:_-]*(\d{1,2})/i
];

/** 解析文本中的数字年龄，解析不出返回 null */
export function parseAgeYears(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  for (const pattern of AGE_NUMBER_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const years = Number(match[1]);
      if (Number.isFinite(years) && years > 0 && years < 100) return years;
    }
  }
  return null;
}

/** 是否为未成年年龄描述：数字 < 18，或命中 child / loli / shota 等词 */
export function isMinorAgeText(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const years = parseAgeYears(text);
  if (years !== null) return years < ADULT_AGE_FLOOR;
  return MINOR_WORD_PATTERN.test(text);
}

/** 是否含未成年年龄描述（整串判断，用于快速短路） */
export function containsMinorAge(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  return raw.split(/[,，]/).map(part => part.trim()).filter(Boolean).some(isMinorAgeText);
}

function normalizeKey(name) {
  return String(name || '').split('(')[0].trim().toLowerCase();
}

/**
 * 送给 LLM 的 tags 视图：
 * - 没有未成年年龄 → 与旧逻辑 `stripAgeWords(tags)` 完全一致（逐字不变）
 * - 有未成年年龄 → 剔除未成年词，补 `adult`
 */
export function proxyAgeTagsForLlm(tags) {
  const raw = Array.isArray(tags) ? tags.join(', ') : String(tags ?? '');
  if (!raw.trim()) return raw;

  const parts = raw.split(/[,，]/).map(part => part.trim()).filter(Boolean);
  const hasMinor = parts.some(isMinorAgeText);
  if (!hasMinor) return stripAgeWords(raw);

  const kept = [];
  for (const part of parts) {
    if (isMinorAgeText(part)) continue;
    const stripped = stripAgeWords(part);
    if (stripped) kept.push(stripped);
  }
  return [...new Set([...kept, 'adult'])].join(', ');
}

/**
 * 送给 LLM 的 features 视图：深拷贝，未成年的年龄槽位改写成 adult。
 * 其余键原样保留，保证与旧行为逐字一致。
 */
export function proxyFeaturesForLlm(features) {
  if (!features || typeof features !== 'object') return features;
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(features));
  } catch {
    return features;
  }
  const hasMinor = AGE_FEATURE_KEYS.some(key => {
    const slot = clone[key];
    const list = Array.isArray(slot) ? slot : (slot ? [slot] : []);
    return list.some(isMinorAgeText);
  });
  if (!hasMinor) return clone;

  for (const key of AGE_FEATURE_KEYS) {
    if (key in clone) {
      clone[key] = Array.isArray(clone[key]) ? ['adult'] : 'adult';
    }
  }
  return clone;
}

/**
 * 提取真实未成年年龄标签（出图前补回用）。
 * features 与 tags 都看，返回去重后的原始写法（如 ['15yo'] / ['child']）。
 */
export function resolveRealAgeTags(features, tags = '') {
  const out = [];
  if (features && typeof features === 'object') {
    for (const key of AGE_FEATURE_KEYS) {
      const slot = features[key];
      const list = Array.isArray(slot) ? slot : (slot ? [slot] : []);
      for (const item of list) {
        const text = String(item || '').trim();
        if (text && isMinorAgeText(text)) out.push(text);
      }
    }
  }
  const rawTags = Array.isArray(tags) ? tags.join(', ') : String(tags ?? '');
  if (rawTags.trim()) {
    for (const part of rawTags.split(/[,，]/).map(item => item.trim()).filter(Boolean)) {
      if (isMinorAgeText(part)) out.push(part);
    }
  }
  return [...new Set(out)];
}

/**
 * 把真实年龄补回人物段。
 * @param {Array} characterPrompts LLM 输出的 character_prompts
 * @param {Map<string,string[]>} realAgeByName 归一化姓名 → 真实年龄标签
 */
export function injectRealAgeIntoCharacterPrompts(characterPrompts, realAgeByName) {
  if (!Array.isArray(characterPrompts) || !(realAgeByName instanceof Map) || realAgeByName.size === 0) {
    return characterPrompts;
  }
  return characterPrompts.map(item => {
    const ages = realAgeByName.get(normalizeKey(item?.name));
    if (!Array.isArray(ages) || ages.length === 0) return item;

    const ageTag = ages.join(', ');
    const prompt = String(item?.prompt || '').trim();
    if (!prompt) return { ...item, prompt: ageTag };

    // 按 tag 逐个处理：已有 adult（旧 prompt 缓存）就地换成真实年龄，否则追加到末尾
    const tokens = prompt.split(/[,，]/).map(token => token.trim()).filter(Boolean);
    const hasAdult = tokens.some(token => /^adult$/i.test(token));
    const nextTokens = hasAdult
      ? tokens.map(token => (/^adult$/i.test(token) ? ageTag : token))
      : [...tokens, ageTag];
    return { ...item, prompt: nextTokens.join(', ') };
  });
}

/**
 * 把一条 DNA 记录整体代理成「LLM 可见视图」：tags 与 features 里的未成年年龄都换成 adult。
 * 其余字段（脸模绑定、负面、身高、体型等）原样保留。
 */
export function proxyDnaEntryForLlm(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const clone = { ...entry };
  if ('tags' in clone) clone.tags = proxyAgeTagsForLlm(clone.tags);
  if ('features' in clone) clone.features = proxyFeaturesForLlm(clone.features);
  return clone;
}

export { normalizeKey as normalizeCharacterKey };
