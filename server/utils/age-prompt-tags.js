/**
 * 年龄 → NAI prompt 标签换算（age prompt tags）
 *
 * 背景（依据 suozhang 合集 17,684 条实测）：
 *   - 合集里数字年龄写法只出现 4 次，且全部在自然语言长句内，标签串里 0 次；
 *   - NAI 词表（Danbooru 系）没有 `7yo` / `7 years old` 这类规范化年龄标签，
 *     数字年龄进 tokenizer 只会被切成 `7` + `yo` 碎片，是纯噪声；
 *   - 真正能控比例的是「年龄类别词 + 比例词」的堆叠。
 *
 * 本模块把 `7yo` 这类输入换算成可用的标签块，并按性别分别给出正向锁与负向锁。
 * 纯查表 + 字符串处理，不读写文件、不依赖网络。
 */

export const ADULT_AGE_FLOOR = 18;

/** 性别未知时的兜底键 */
export const GENDER_NEUTRAL = 'neutral';
export const GENDER_FEMALE = 'female';
export const GENDER_MALE = 'male';
export const GENDER_MIXED = 'mixed';

/**
 * 年龄档位表。
 * identity = 身份锁（声明年龄段），proportion = 比例锁（真控体型），weight = NAI 权重。
 * headToBody 仅作画面验收参考，不写入 prompt。
 */
export const AGE_PROMPT_BUCKETS = [
  {
    key: 'age05',
    label: '3-5岁',
    maxYears: 5,
    headToBody: '3.5-4.5头身',
    female: {
      identity: ['child', 'toddler'],
      proportion: ['petite', 'flat chest', 'short stature', 'small hands', 'short legs'],
      weight: 2
    },
    male: {
      identity: ['child', 'toddler', 'shota'],
      proportion: ['petite', 'short stature', 'small hands', 'short legs'],
      weight: 2
    },
    neutral: {
      identity: ['child', 'toddler'],
      proportion: ['petite', 'short stature', 'small hands', 'short legs'],
      weight: 2
    }
  },
  {
    key: 'age09',
    label: '6-9岁',
    maxYears: 9,
    headToBody: '4.5-5.5头身',
    female: {
      identity: ['child', 'loli'],
      proportion: ['petite', 'flat chest', 'short stature', 'narrow shoulders', 'small hands'],
      weight: 1.3
    },
    male: {
      identity: ['shota', 'child'],
      proportion: ['petite', 'short stature', 'narrow shoulders', 'small hands'],
      weight: 1.5
    },
    neutral: {
      identity: ['child'],
      proportion: ['petite', 'short stature', 'narrow shoulders'],
      weight: 1.3
    }
  },
  {
    key: 'age12',
    label: '10-12岁',
    maxYears: 12,
    headToBody: '5-6头身',
    female: {
      identity: ['loli', 'child'],
      proportion: ['petite', 'flat chest', 'short stature', 'narrow shoulders'],
      weight: 1.3
    },
    male: {
      identity: ['shota', 'boy'],
      proportion: ['petite', 'short stature', 'narrow shoulders'],
      weight: 1.3
    },
    neutral: {
      identity: ['child'],
      proportion: ['petite', 'short stature', 'narrow shoulders'],
      weight: 1.2
    }
  },
  {
    key: 'age15',
    label: '13-15岁',
    maxYears: 15,
    headToBody: '5.5-6.5头身',
    female: {
      identity: ['loli', 'teen'],
      proportion: ['petite', 'small breasts', 'short stature'],
      weight: 1.2
    },
    male: {
      identity: ['shota', 'teen'],
      proportion: ['slim', 'short stature', 'narrow shoulders'],
      weight: 1.2
    },
    neutral: {
      identity: ['teen'],
      proportion: ['petite', 'short stature'],
      weight: 1.1
    }
  },
  {
    key: 'age17',
    label: '16-17岁',
    maxYears: 17,
    headToBody: '6-6.5头身',
    female: {
      identity: ['teen'],
      proportion: ['petite', 'slim', 'small breasts'],
      weight: 1.1
    },
    male: {
      identity: ['teen', 'boy'],
      proportion: ['slim', 'narrow shoulders'],
      weight: 1.1
    },
    neutral: {
      identity: ['teen'],
      proportion: ['slim'],
      weight: 1
    }
  }
];

/** 相对年龄词：`aged down` 走单独档，不按岁数分 */
export const AGED_DOWN_BUCKET = {
  key: 'agedDown',
  label: '年龄下调',
  headToBody: '按目标档',
  female: {
    identity: ['aged down', 'loli'],
    proportion: ['petite', 'flat chest', 'short stature'],
    weight: 1.5
  },
  male: {
    identity: ['aged down', 'shota'],
    proportion: ['petite', 'short stature'],
    weight: 1.5
  },
  neutral: {
    identity: ['aged down'],
    proportion: ['petite', 'short stature'],
    weight: 1.5
  }
};

/**
 * 负向锁：按性别分表。
 * 男侧必须压 `man`——`1boy` 的默认先验是青年男性，不压会补成宽肩成年人。
 */
export const AGE_NEGATIVE_TABLE = {
  [GENDER_FEMALE]: [
    '-1.5::mature female, tall, long legs, wide hips, thick thighs::',
    '-2::large breasts, huge breasts, gigantic breasts, cleavage, curvy, voluptuous::',
    '-1.2::adult face, makeup, eyeliner::'
  ],
  [GENDER_MALE]: [
    '-1.5::man, adult, tall, broad shoulders, muscular, long legs::',
    '-2::facial hair, beard, stubble, body hair, masculine jaw::',
    '-1.2::adult face, mature face, sharp jawline::'
  ],
  [GENDER_NEUTRAL]: [
    '-1.5::mature female, man, adult, tall, long legs::',
    '-2::large breasts, huge breasts, cleavage, muscular, broad shoulders::',
    '-1.2::adult face, mature face::'
  ]
};
AGE_NEGATIVE_TABLE[GENDER_MIXED] = AGE_NEGATIVE_TABLE[GENDER_NEUTRAL];

const FEMALE_PATTERN = /(?:^|[^a-z0-9_])(?:1girl|2girls|3girls|4girls|5girls|6\+girls|girl|girls|woman|women|female|loli|lolita|lady|she|her|女孩|少女|女人)(?:$|[^a-z0-9_])/i;
const MALE_PATTERN = /(?:^|[^a-z0-9_])(?:1boy|2boys|3boys|4boys|5boys|6\+boys|boy|boys|man|men|male|shota|gentleman|he|his|男孩|少年|男人)(?:$|[^a-z0-9_])/i;

/** 数字年龄解析（与 age-proxy.parseAgeYears 同语义，但本地实现避免循环依赖） */
const AGE_NUMBER_PATTERN = /(?<!\d)(\d{1,2})\s*[\s_-]*(?:yo|y\/o|y\.o\.?|years?[\s_-]?old|year[\s_-]?old|岁)/i;
const AGE_FIELD_PATTERN = /(?:age|年龄)[\s:_-]*(\d{1,2})/i;

/**
 * 从文本里解析岁数，解析不出返回 null。
 * @param {string} value
 * @returns {number|null}
 */
export function parseAgeYears(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  for (const pattern of [AGE_NUMBER_PATTERN, AGE_FIELD_PATTERN]) {
    const match = text.match(pattern);
    if (match) {
      const years = Number(match[1]);
      if (Number.isFinite(years) && years > 0 && years < 100) return years;
    }
  }
  return null;
}

const TODDLER_PATTERN = /(?:^|[^a-z0-9_])(?:toddler|infant|baby|幼儿园)(?:$|[^a-z0-9_])/i;
const CHILD_PATTERN = /(?:^|[^a-z0-9_])(?:child|kid|children|kids|little girl|little boy|小学生|小孩|儿童)(?:$|[^a-z0-9_])/i;
const TEEN_PATTERN = /(?:^|[^a-z0-9_])(?:teen|teenager|中学生|青春期)(?:$|[^a-z0-9_])/i;
const AGED_DOWN_PATTERN = /(?:^|[^a-z0-9_])(?:aged[ _]down|幼化|年龄下调)(?:$|[^a-z0-9_])/i;

/**
 * 判定提示词里的角色性别。
 * @param {string} text
 * @returns {'female'|'male'|'mixed'|'neutral'}
 */
export function detectPromptGender(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return GENDER_NEUTRAL;
  const hasFemale = FEMALE_PATTERN.test(raw);
  const hasMale = MALE_PATTERN.test(raw);
  if (hasFemale && hasMale) return GENDER_MIXED;
  if (hasFemale) return GENDER_FEMALE;
  if (hasMale) return GENDER_MALE;
  return GENDER_NEUTRAL;
}

/**
 * 把年龄文本定位到档位。成年人返回 null（成年人不需要年龄锁）。
 * @param {string} ageText
 * @returns {object|null}
 */
export function resolveAgeBucket(ageText) {
  const text = String(ageText ?? '').trim();
  if (!text) return null;

  const years = parseAgeYears(text);
  if (years !== null) {
    if (years >= ADULT_AGE_FLOOR) return null;
    return AGE_PROMPT_BUCKETS.find(bucket => years <= bucket.maxYears) || AGE_PROMPT_BUCKETS[0];
  }

  if (AGED_DOWN_PATTERN.test(text)) return AGED_DOWN_BUCKET;
  if (TODDLER_PATTERN.test(text)) return AGE_PROMPT_BUCKETS[0];
  if (CHILD_PATTERN.test(text)) return AGE_PROMPT_BUCKETS[1];
  if (TEEN_PATTERN.test(text)) return AGE_PROMPT_BUCKETS[4];
  return null;
}

function uniqueTags(list) {
  const out = [];
  for (const item of list) {
    const tag = String(item || '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

function normalizeGender(gender) {
  const value = String(gender ?? '').toLowerCase();
  if (value === GENDER_FEMALE || value === 'girl' || value === 'f' || value === '女') return GENDER_FEMALE;
  if (value === GENDER_MALE || value === 'boy' || value === 'm' || value === '男') return GENDER_MALE;
  if (value === GENDER_MIXED || value === 'both' || value === '混合') return GENDER_MIXED;
  return GENDER_NEUTRAL;
}

/** 把一组标签按 NAI 权重语法分组：1.3::a,b:: */
export function formatWeightedTags(tags, weight) {
  const list = uniqueTags(tags);
  if (!list.length) return '';
  const num = Number(weight);
  if (!Number.isFinite(num) || num === 1) return list.join(', ');
  return `${num}::${list.join(',')}::`;
}

/**
 * 核心换算：年龄文本 + 性别 → 可直接拼进 prompt 的标签块。
 * @param {{ ageText?: string, gender?: string, prompt?: string, weightOverride?: number }} input
 * @returns {{
 *   matched: boolean,
 *   bucketKey: string|null,
 *   label: string|null,
 *   headToBody: string|null,
 *   gender: string,
 *   identity: string[],
 *   proportion: string[],
 *   weight: number|null,
 *   weighted: string,
 *   positive: string,
 *   negative: string[]
 * }}
 */
export function convertAgeToPromptTags(input = {}) {
  const ageText = String(input.ageText ?? '').trim();
  const gender = input.gender
    ? normalizeGender(input.gender)
    : detectPromptGender(input.prompt ?? '');

  const bucket = resolveAgeBucket(ageText);
  if (!bucket) {
    return {
      matched: false,
      bucketKey: null,
      label: null,
      headToBody: null,
      gender,
      identity: [],
      proportion: [],
      weight: null,
      weighted: '',
      positive: '',
      negative: []
    };
  }

  const slot = bucket[gender] || bucket[GENDER_NEUTRAL];
  const weight = Number.isFinite(Number(input.weightOverride))
    ? Number(input.weightOverride)
    : slot.weight;
  const identity = uniqueTags(slot.identity);
  const proportion = uniqueTags(slot.proportion);
  const weighted = formatWeightedTags([...identity, ...proportion], weight);

  return {
    matched: true,
    bucketKey: bucket.key,
    label: bucket.label,
    headToBody: bucket.headToBody,
    gender,
    identity,
    proportion,
    weight,
    weighted,
    positive: weighted,
    negative: [...(AGE_NEGATIVE_TABLE[gender] || AGE_NEGATIVE_TABLE[GENDER_NEUTRAL])]
  };
}

/**
 * 男女同框的关系标签。用于两张脸同时出现时稳住体型差。
 * @param {{ youngGender?: string, olderGender?: string, sameAge?: boolean }} [options]
 * @returns {string[]}
 */
export function buildAgeGapRelationTags(options = {}) {
  if (options.sameAge) return ['2kids', 'same height'];
  const young = normalizeGender(options.youngGender);
  const older = normalizeGender(options.olderGender);
  if (young === GENDER_MALE && older === GENDER_FEMALE) {
    return ['onee-shota', 'age difference', 'height difference', 'size difference'];
  }
  if (young === GENDER_FEMALE && older === GENDER_MALE) {
    return ['age difference', 'height difference', 'size difference'];
  }
  return ['age difference', 'height difference'];
}

/**
 * 把年龄负向锁拼进一条人物负向段。
 * 性别取正向 prompt，不能取负向段（负向里没有 1boy/1girl，取了必回落中性表）。
 * 成年或无法换算时原样返回。
 * @param {string} negativePrompt 人物负向 prompt
 * @param {string[]} ageTags 真实年龄标签
 * @param {{ gender?: string, prompt?: string }} [options] gender 显式优先，prompt 为同角色正向段
 * @returns {string}
 */
export function mergeAgeNegativeIntoPrompt(negativePrompt, ageTags, options = {}) {
  const ageList = uniqueTags(ageTags);
  if (!ageList.length) return String(negativePrompt ?? '').trim();

  const base = String(negativePrompt ?? '').trim();
  const gender = options.gender
    ? normalizeGender(options.gender)
    : detectPromptGender(options.prompt ?? negativePrompt);
  const conversion = convertAgeToPromptTags({ ageText: ageList.join(', '), gender });
  if (!conversion.matched) return base;

  const existing = base.toLowerCase();
  const missing = conversion.negative.filter((block) => {
    const firstToken = block.replace(/^-?[\d.]+::/, '').split(',')[0].trim().toLowerCase();
    return firstToken && !existing.includes(firstToken);
  });
  if (!missing.length) return base;
  return mergeNegativeParts(base, missing);
}

function mergeNegativeParts(base, blocks) {
  const head = String(base ?? '').trim();
  const tail = uniqueTags(blocks).join(', ');
  if (!head) return tail;
  if (!tail) return head;
  return `${head}, ${tail}`;
}

/**
 * 把年龄标签写进一条人物段：替换已有 adult，追加换算后的标签块。
 * 成年或无法换算时保持原样追加。
 * @param {string} prompt 人物 prompt
 * @param {string[]} ageTags 真实年龄标签（如 ['7yo'] / ['child']）
 * @returns {string}
 */
export function mergeAgeTagsIntoPrompt(prompt, ageTags) {
  const ageList = uniqueTags(ageTags);
  if (!ageList.length) return prompt;

  const ageText = ageList.join(', ');
  const gender = detectPromptGender(prompt);
  const conversion = convertAgeToPromptTags({ ageText, gender });

  const tokens = String(prompt ?? '')
    .split(/[,，]/)
    .map(token => token.trim())
    .filter(Boolean);

  if (!conversion.matched) {
    // 成年或无法换算：维持旧行为，只在缺失时补原写法
    const hasAdult = tokens.some(token => /^adult$/i.test(token));
    const nextTokens = hasAdult
      ? tokens.map(token => (/^adult$/i.test(token) ? ageText : token))
      : [...tokens, ageText];
    return nextTokens.join(', ');
  }

  const hasAdult = tokens.some(token => /^adult$/i.test(token));
  const kept = hasAdult ? tokens.filter(token => !/^adult$/i.test(token)) : tokens;
  return [...kept, conversion.weighted].join(', ');
}
