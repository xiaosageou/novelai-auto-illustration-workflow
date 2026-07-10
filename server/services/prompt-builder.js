import { 
  mergePositivePromptParts, 
  conservativeCompletionNaiWeights, 
  normalizeArtistTag,
  deduplicatePromptTokens,
  removeNonEnglishPromptTokens,
  normalizeDanbooruPromptSegment
} from '../utils/prompt-cleaner.js';

/**
 * V4.5 自然语言模式权重守卫
 * - 将所有 X.XX:: 权重中超过 maxWeight 的部分除降到 maxWeight
 * - 限制最多保留 maxCount 个权重注郊（保留权重值最高的）
 * @param {string} prompt - 原始提示词字符串
 * @param {number} maxWeight - 权重上限（默认 1.3）
 * @param {number} maxCount - 最大权重注郊数量（默认 2）
 */
export function clampNaturalLanguageWeights(prompt, maxWeight = 1.3, maxCount = 2) {
  if (!prompt) return prompt;
  // 匹配类似 1.45::text:: 或 -3::text:: 的权重语法
  const weightPattern = /(-?\d+(?:\.\d+)?)::(.*?)::/g;
  const allWeights = [];
  let match;
  while ((match = weightPattern.exec(prompt)) !== null) {
    const value = parseFloat(match[1]);
    allWeights.push({ value, full: match[0], index: match.index });
  }

  if (allWeights.length === 0) return prompt;

  // 正权重（>0）按权重值排序，只保留 maxCount 个
  const positiveWeights = allWeights.filter(w => w.value > 0).sort((a, b) => b.value - a.value);
  const keepSet = new Set(positiveWeights.slice(0, maxCount).map(w => w.full));

  // 对整个字符串进行替换
  let result = prompt.replace(/(-?\d+(?:\.\d+)?)::(.*?)::/g, (m, weight, text) => {
    const value = parseFloat(weight);
    if (value <= 0) return m; // 负权重保留不动
    if (!keepSet.has(m)) return text; // 超出数量限制的，去掉权重只保留文本
    if (value > maxWeight) return `${maxWeight}::${text}::`; // 将权重限制到上限
    return m; // 保留不变
  });

  return result;
}

// 常量定义
const 自动去水印负面提示词 = 'text, watermark, signature, logo, subtitles, qr code';
const 全局无文字正向提示词 = 'single coherent image, natural subject focus, clear silhouette';
const 默认中国人物正向提示词 = 'Chinese person, East Asian facial features, Chinese facial structure, black or dark brown hair, dark brown eyes';
const 默认中国人物负向提示词 = 'western face, blonde hair, blue eyes';
const 部位特写单图正向提示词 = 'single image, one frame, one subject only, extreme close-up macro crop, target fills the frame, plain blurred background, cohesive macro composition';
const NSFW部位特写画质增强提示词 = 'adult character only, target anatomy only, macro anatomical close-up, ultra tight crop, wet skin texture, glistening moisture, natural skin folds, soft rim light, specular highlights, subsurface scattering, single private anatomy focus, no minors';
const 部位特写反拼贴负面提示词 = 'multiple views, split screen, panel layout, comic panel, comic page, manga panel, collage, contact sheet, character sheet, duplicate anatomy, mirrored anatomy, multiple organs, extra organs, extra nipples';
const 默认NovelAI负面提示词 = 'artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, logo, too many watermarks, negative space, blank page, gigantic breasts';
const 默认表情稳定负面提示词 = 'bared teeth, clenched teeth, crazy grin, distorted mouth, grimace';
const 插入局部放大正向提示词 = 'single inset image, magnified inset, penetration focus, x-ray inset, cutaway inset, external view main frame, main scene plus one inset, genital penetration visible in inset only';
const 插入局部放大豁免负面词 = new Set([
  'comic panel',
  'comic page',
  'manga panel',
  'story panels',
  'panel layout',
  'inset image',
  'callout',
  'framed text'
]);

const 构图附加负面提示词映射 = {
  头像: 'multiple people, extra person, extra face, split screen, collage, contact sheet, comic panel, manga panel, text box',
  半身: 'multiple people, extra person, extra face, split screen, collage, contact sheet, comic panel, manga panel, text box',
  立绘: 'multiple people, extra person, extra face, split screen, collage, contact sheet, comic panel, manga panel, text box',
  部位特写: 部位特写反拼贴负面提示词,
  场景: 'split screen, collage, contact sheet, comic panel, manga panel, panel layout, text box, multiple views'
};

function 是否角色构图(composition) {
  return composition === '头像' || composition === '半身' || composition === '立绘';
}

function 提示词明确外国人(text) {
  if (!text) return false;
  return /\b(foreigner|foreign|Caucasian|European|Western|white person|blonde|blond|blue eyes|Nordic|Slavic|Russian|British|French|German|American|Japanese|Korean|Indian|Arab|African|Latina|Hispanic)\b/i.test(text)
    || /外国|欧美|白人|金发|碧眼|蓝眼|俄罗斯|英伦|法国|德国|美国|日本人|韩国人|印度人|阿拉伯|非洲|拉丁/.test(text);
}

function 去重提示词片段(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr.filter(item => {
    const trimmed = (item || "").trim();
    if (!trimmed) return false;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function 按逗号拆分提示词(text) {
  if (!text) return [];
  return text.split(/[,，]/).map(t => t.trim()).filter(Boolean);
}

function 清理体液与汗水冲突(prompt = '') {
  const tokens = 按逗号拆分提示词(prompt);
  const hasExplicitBodyFluid = tokens.some(token => /^(?:vaginal_fluids|pussy_juice|cumdrip|semen_dripping|wet_thighs)$/i.test(token));
  if (!hasExplicitBodyFluid) return prompt;
  return tokens
    .filter(token => !/^(?:sweat|sweating)$/i.test(token))
    .join(', ');
}

function 移除纯色背景负面限制(prompt = '') {
  const allowedBackgroundTags = /^(?:white|black|solid color|simple|plain|empty|gradient) background$|^(?:studio backdrop|isolated subject|backgroundless|white_background|black_background|solid_color_background|simple_background|plain_background|empty_background|gradient_background)$/i;
  return 按逗号拆分提示词(prompt)
    .filter(token => !allowedBackgroundTags.test(token))
    .join(', ');
}

function 移除角色局部数量标签(prompt = '') {
  return 按逗号拆分提示词(prompt)
    .filter(token => !/^(?:1girl|1woman|1female|1boy|1man|1male)$/i.test(token))
    .join(', ');
}

function 角色性别标签(gender = '') {
  const value = String(gender || '').toLowerCase();
  if (/woman|female|girl|少女|女孩|女性/.test(value)) return 'girl';
  if (/man|male|boy|少年|男孩|男性/.test(value)) return 'boy';
  if (/creature|monster|animal|beast|生物|怪物|动物/.test(value)) return 'creature';
  return '';
}

function 构建人物数量标签(sceneCharacters = []) {
  let girls = 0;
  let boys = 0;
  let creatures = 0;
  for (const char of sceneCharacters || []) {
    const genderTag = 角色性别标签(char?.gender);
    if (genderTag === 'girl') girls += 1;
    else if (genderTag === 'boy') boys += 1;
    else if (genderTag === 'creature') creatures += 1;
  }
  return [
    girls > 0 ? `${girls}girl${girls > 1 ? 's' : ''}` : '',
    boys > 0 ? `${boys}boy${boys > 1 ? 's' : ''}` : '',
    creatures > 0 ? `${creatures}creature${creatures > 1 ? 's' : ''}` : ''
  ].filter(Boolean).join(', ');
}

function 构建精确人物数量约束(sceneCharacters = []) {
  return '';
}

function 构建额外人物负面提示词(sceneCharacters = []) {
  const count = Array.isArray(sceneCharacters) ? sceneCharacters.length : 0;
  if (count === 2) {
    const countPrompt = 构建人物数量标签(sceneCharacters);
    const incompatibleTwoPersonCounts = [
      countPrompt !== '2girls' ? '2girls' : '',
      countPrompt !== '2boys' ? '2boys' : '',
      countPrompt !== '1girl, 1boy' ? '1girl 1boy' : ''
    ].filter(Boolean);
    return [
      'third person',
      'extra person',
      'extra character',
      'background person',
      'background people',
      'crowd',
      '3people',
      '3girls',
      '3boys',
      '2girls 1boy',
      '1girl 2boys',
      ...incompatibleTwoPersonCounts,
      'duplicate person',
      'duplicate character',
      'extra face',
      'extra head',
      'duplicate body'
    ].join(', ');
  }
  if (count === 3) {
    return 'fourth person, extra person, extra character, background person, background people, crowd, 4people, duplicate person, duplicate character, extra face, extra head, duplicate body';
  }
  return '';
}

function 构建动作关系强调提示词(prompt = '') {
  const actionPattern = /(sword_to_throat|sword_tip|blade_tip|touching_throat|pressed_against_(?:the_)?(?:throat|neck)|pointing_sword|holding_sword|swinging_weapon|looking_at_|eye_contact|face-to-face|confrontation|threat|attacking|fighting|peeking|through_door_crack|silhouette_on_screen|shadow_play|holding_snow|open_palm|clenched_hand|from_behind|sex|penetration|pull_out|semen_leaking|cumdrip|buttoning|undressing|embracing|kissing|kneeling|running|walking|dancing|casting|reaching|grabbing|holding_|hand_on_)/i;
  const tokens = 去重提示词片段(按逗号拆分提示词(prompt))
    .filter(token => actionPattern.test(token))
    .filter(token => !/::/.test(token))
    .slice(0, 12);
  return tokens.map(token => {
    const weight = /(sword_tip|blade_tip|touching_throat|pressed_against_(?:the_)?(?:throat|neck)|visible_throat_contact)/i.test(token)
      ? '1.55'
      : '1.35';
    return `${weight}::${token}::`;
  }).join(', ');
}

function 构建动作关系负面提示词(prompt = '') {
  if (/(sword_tip_touching_throat|blade_pressed_against_neck|touching_throat|sword_to_throat)/i.test(prompt)) {
    return 'swinging sword, swinging weapon, sword pointing away, lowered sword, sheathed sword, sword on back, sword behind body, hidden blade, cropped weapon, missing sword, self-directed sword, sword near own neck, gap between sword and throat';
  }
  return '';
}

function 构建私密场景负面词({ prompt = '', sceneEnvironment = '', sceneDescription = '' } = {}) {
  const text = `${prompt} ${sceneEnvironment} ${sceneDescription}`;
  const isPublic = /街|路|广场|教室|课堂|走廊|地铁|公交|车厢|酒吧|餐厅|商场|公共|人群|观众|围观|street|road|square|classroom|corridor|subway|train|bus|bar|restaurant|mall|public|crowd|onlookers/i.test(text);
  const isPrivate = /卧室|房间|寝室|浴室|浴池|书房|私人|密室|无人|独处|bedroom|private room|bathroom|bath|study room|secluded|alone|no onlookers/i.test(text);
  return isPrivate && !isPublic
    ? 'silhouette, shadow, shadowy figure, outline of person, foreground silhouette, foreground shadow'
    : '';
}

function 是插入局部放大场景({
  sceneNsfwRating = 'sfw',
  sourcePrompt = '',
  sceneDescription = '',
  sceneInteractions = '',
  sceneInteractionActions = [],
  sceneMustShow = []
} = {}) {
  if (String(sceneNsfwRating || 'sfw') !== 'nsfw_explicit') return false;
  const actionHit = (Array.isArray(sceneInteractionActions) ? sceneInteractionActions : [])
    .some(action => /^(?:sex|penetration|vaginal|anal|paizuri|fellatio|irrumatio)$/i.test(String(action?.action || '').trim()));
  const text = [
    sourcePrompt,
    sceneDescription,
    sceneInteractions,
    ...(Array.isArray(sceneMustShow) ? sceneMustShow : [])
  ].join(' ');
  const negatedInsertion = /没有插入|未插入|无插入|非插入|not penetration|without penetration|no penetration/i.test(text);
  const insertionHit = !negatedInsertion && /插入|交合|性交|肉棒插入|阴茎插入|penetration|inserted|vaginal_penetration|anal_penetration/i.test(text);
  const nonPenetrativeOnly = /手交|handjob|footjob|乳交|paizuri|口交|fellatio|blowjob/i.test(text) && !insertionHit;
  const insetRequested = /局部放大|放大图|剖面|截面|透视图|inset|magnified|x-?ray|cutaway|cross[-_ ]?section|callout/i.test(text);
  return !nonPenetrativeOnly && insetRequested && (actionHit || insertionHit);
}

function 场景存在直接互动({
  prompt = '',
  sceneInteractions = '',
  sceneInteractionActions = []
} = {}) {
  if (Array.isArray(sceneInteractionActions) && sceneInteractionActions.length > 0) return true;
  return /牵|抱|拥|吻|抓|握|扶|搂|触|压|推|拉|递|喂|看向|对视|攻击|刺|砍|射|插入|性交|touch|hold|hug|kiss|grab|push|pull|hand|feed|look|face|attack|strike|shoot|sex|penetration|handjob|fellatio/i
    .test(`${prompt} ${sceneInteractions}`);
}

function 已有统一构图提示(prompt = '') {
  return /single unified composition|shared central action|connected pose|interacting bodies|both subjects in one continuous scene/i
    .test(String(prompt || ''));
}

function 允许插入放大图负面词(prompt = '') {
  return 按逗号拆分提示词(prompt)
    .filter(token => !插入局部放大豁免负面词.has(token.toLowerCase()))
    .join(', ');
}

function 构建场景环境增强提示词(environment = '', description = '', composition = '场景') {
  return '';
}

function 原文明确要求露齿表情(expression = '') {
  return /龇牙|露齿|咬牙|咬紧牙|尖牙|獠牙|狂笑|大笑|狞笑|怪笑|邪笑|扭曲.{0,4}笑|兴奋.{0,4}笑|咆哮|嘶吼|张嘴|open mouth|bared teeth|clenched teeth|sharp teeth|fang|crazy grin|crazed expression|laughing|screaming/i.test(expression);
}

function 构建稳定表情提示词(expression = '', nsfwRating = 'sfw') {
  const text = String(expression || '');
  if (原文明确要求露齿表情(text)) return '';

  const isNsfw = /^nsfw_/i.test(String(nsfwRating || ''));
  if (isNsfw) {
    const nsfwEmotionRules = [
      [/高潮|快感|愉悦|享受|沉溺|销魂|pleasure|orgasm|ecstasy/i, 'pleasured expression, half-closed eyes, flushed face, slightly parted lips'],
      [/情欲|欲望|发情|迷离|媚眼|诱惑|aroused|lust|desire|bedroom eyes/i, 'aroused expression, bedroom eyes, blush, slightly parted lips'],
      [/羞耻|羞涩|难堪|屈辱|尴尬|embarrass|ashamed|humiliat/i, 'embarrassed, deep blush, averted gaze, tense eyebrows'],
      [/疼痛|痛苦|难受|挣扎|pained|painful|suffering/i, 'pained expression, furrowed brows, moist eyes, slightly parted lips'],
      [/虚脱|疲惫|无力|高潮后|事后|exhausted|spent|post-coital|after sex/i, 'dazed expression, unfocused eyes, lowered eyelids, flushed face'],
      [/挑逗|戏谑|主动|得意|诱惑|teasing|seductive|playful/i, 'teasing expression, narrowed eyes, faint smile, blush'],
      [/满足|餍足|满意|得逞|satisfied|contented/i, 'satisfied expression, softened eyes, faint smile'],
      [/紧张|不安|害怕|恐惧|抗拒|nervous|anxious|fearful|afraid/i, 'tense expression, worried eyes, slightly furrowed brows']
    ];
    const nsfwEmotion = nsfwEmotionRules.find(([pattern]) => pattern.test(text))?.[1] || '';
    if (nsfwEmotion) return mergePositivePromptParts(nsfwEmotion);
  }

  const emotionRules = [
    [/害羞|羞涩|羞耻|尴尬|窘迫|脸红|blush|embarrass|shy/i, 'embarrassed, blush, averted gaze'],
    [/担忧|担心|忧虑|不安|紧张|忐忑|焦虑|worried|anxious|nervous/i, 'worried, slightly furrowed brows, tense eyes'],
    [/害怕|恐惧|惊恐|畏惧|胆怯|scared|afraid|fearful/i, 'fearful, wide eyes, tense expression'],
    [/惊讶|吃惊|错愕|震惊|诧异|surprised|shocked/i, 'surprised, raised eyebrows, slightly parted lips'],
    [/愤怒|生气|恼怒|不满|烦躁|怒视|angry|annoyed|irritated/i, 'annoyed, furrowed brows, narrowed eyes'],
    [/悲伤|难过|哀伤|心碎|忧郁|失落|sad|sorrow|melanchol/i, 'sad, downcast eyes, slight frown'],
    [/痛苦|疼痛|难受|挣扎|pained|painful|suffering/i, 'pained expression, furrowed brows, tense eyes'],
    [/疲惫|虚弱|无力|困倦|憔悴|exhausted|tired|weak/i, 'tired eyes, weary expression, lowered eyelids'],
    [/困惑|疑惑|不解|迷茫|confused|puzzled/i, 'confused, slightly furrowed brows, questioning gaze'],
    [/坚定|坚决|认真|专注|警惕|戒备|determined|focused|alert/i, 'determined, focused eyes, firm expression'],
    [/冷淡|清冷|冷漠|平静|镇定|淡然|calm|composed|indifferent/i, 'composed, restrained expression, steady gaze'],
    [/欣慰|温柔|宠溺|喜悦|开心|高兴|微笑|浅笑|轻笑|smile|smiling|happy|gentle/i, 'slight smile, softened eyes']
  ];
  const emotion = emotionRules.find(([pattern]) => pattern.test(text))?.[1] || '';
  return mergePositivePromptParts(emotion);
}

function 净化角色表情提示词(prompt = '', expression = '', nsfwRating = 'sfw') {
  if (!prompt) return '';
  const allowExposedTeeth = 原文明确要求露齿表情(expression);
  const highRiskExpression = /(bared[_ ]teeth|clenched[_ ]teeth|sharp[_ ]teeth|fangs?|crazy[_ ]grin|exaggerated[_ ]grin|distorted[_ ]mouth|crooked[_ ]mouth|grimace|evil[_ ]smile|naughty[_ ]face|rape[_ ]face)/i;
  const broadSmile = /^(smile|smiling|grin|grinning)$/i;
  const hasSpecificEmotion = String(expression || '').trim().length > 0
    && !/^(无|无表情|普通|自然|平静|neutral|none)$/i.test(String(expression || '').trim());
  const neutralizingExpression = /^(?:expressionless|blank[_ ]stare|neutral[_ ]expression|natural[_ ]expression|calm[_ ]expression)$/i;
  const tokens = 按逗号拆分提示词(prompt).filter(token => {
    if (!allowExposedTeeth && highRiskExpression.test(token)) return false;
    if (!allowExposedTeeth && broadSmile.test(token)) return false;
    if (hasSpecificEmotion && neutralizingExpression.test(token)) return false;
    return true;
  });
  return mergePositivePromptParts(tokens.join(', '), 构建稳定表情提示词(expression, nsfwRating));
}

function 移除无依据的高风险表情(prompt = '', sceneCharacters = []) {
  const allowExposedTeeth = (sceneCharacters || []).some(char => 原文明确要求露齿表情(char?.expression || ''));
  if (allowExposedTeeth) return prompt;
  const highRiskExpression = /(bared[_ ]teeth|clenched[_ ]teeth|sharp[_ ]teeth|fangs?|crazy[_ ]grin|exaggerated[_ ]grin|distorted[_ ]mouth|crooked[_ ]mouth|grimace|evil[_ ]smile|naughty[_ ]face|rape[_ ]face)/i;
  return 按逗号拆分提示词(prompt)
    .filter(token => !highRiskExpression.test(token))
    .join(', ');
}

function 推导身高等级(anchor) {
  const explicit = String(anchor?.身高等级 || anchor?.height_class || '').toLowerCase();
  const bodyTags = [
    ...(Array.isArray(anchor?.结构化特征?.身材标签) ? anchor.结构化特征.身材标签 : []),
    anchor?.正面提示词 || ''
  ].join(', ').toLowerCase();
  const text = `${explicit}, ${bodyTags}`;
  if (/(very_tall|very tall|高挑|高大)/i.test(text)) return 2;
  if (/(tall|高个|修长)/i.test(text)) return 1;
  if (/(very_short|very short|矮小)/i.test(text)) return -2;
  if (/(short_stature|short|petite|娇小|矮个)/i.test(text)) return -1;
  return 0;
}

function 净化多人身高标签(prompt = '') {
  return 按逗号拆分提示词(prompt)
    .filter(token => !/^(very[_ ]tall|tall|very[_ ]short|short|short[_ ]stature)$/i.test(token))
    .join(', ');
}

function 是明确背景角色(char = {}) {
  const position = String(char?.position || '').toLowerCase();
  const appearance = String(char?.appearance || '').toLowerCase();
  return /background|background_shadow|shadow|silhouette|远景|背景|剪影|人影/.test(`${position} ${appearance}`);
}

function 解析角色位置(position = '', index = 0, count = 1) {
  const text = String(position || '').toLowerCase();
  let x = count <= 1 ? 0.5 : 0.2 + (0.6 * index) / Math.max(1, count - 1);
  let y = 0.5;

  if (/far[_ ]?left|最左|左侧边缘/.test(text)) x = 0.1;
  else if (/left|左/.test(text)) x = 0.3;
  else if (/far[_ ]?right|最右|右侧边缘/.test(text)) x = 0.9;
  else if (/right|右/.test(text)) x = 0.7;
  else if (/center|middle|中央|中间|正中/.test(text)) x = 0.5;

  if (/top|upper|上方|上部/.test(text)) y = 0.1;
  else if (/background|rear|back|远景|背景|后方/.test(text)) y = 0.3;
  else if (/foreground|front|前景|前方/.test(text)) y = 0.7;
  else if (/bottom|lower|下方|下部/.test(text)) y = 0.9;

  return {
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3))
  };
}

function 查找互动角色索引(interactions = '', characters = []) {
  const text = String(interactions || '');
  const hits = characters
    .map((char, index) => ({
      index,
      offset: text.indexOf(String(char?.name || '').trim())
    }))
    .filter(item => item.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  return hits.length >= 2 ? [hits[0].index, hits[1].index] : null;
}

export function buildCharacterSpatialGuidance(sceneCharacters = [], interactions = '', interactionActions = []) {
  const characters = Array.isArray(sceneCharacters) ? sceneCharacters : [];
  const centers = characters.map((char, index) => 解析角色位置(char?.position, index, characters.length));
  const characterDirections = characters.map(() => '');
  const directionCandidates = characters.map(() => new Set());
  const baseDirections = [];
  const byName = new Map(characters.map((char, index) => [String(char?.name || '').trim().toLowerCase(), index]));

  if (characters.length >= 2) {
    const interactionText = String(interactions || '');
    const hasDirectInteraction = /牵|抱|拥|吻|抓|握|扶|搂|触|压|推|拉|递|喂|看向|对视|攻击|刺|砍|射|touch|hold|hug|kiss|grab|push|pull|hand|feed|look|face|attack|strike|shoot/i.test(interactionText);
    const structuredPairs = (Array.isArray(interactionActions) ? interactionActions : [])
      .map(item => [
        byName.get(String(item?.source || '').trim().toLowerCase()),
        byName.get(String(item?.target || '').trim().toLowerCase())
      ])
      .filter(([sourceIndex, targetIndex]) => (
        sourceIndex !== undefined
        && targetIndex !== undefined
        && sourceIndex !== targetIndex
      ));
    const fallbackPair = hasDirectInteraction ? (查找互动角色索引(interactions, characters) || [0, 1]) : null;
    const pairs = structuredPairs.length ? structuredPairs : (fallbackPair ? [fallbackPair] : []);

    for (const [actorIndex, targetIndex] of pairs) {
      const actorCenter = centers[actorIndex];
      const targetCenter = centers[targetIndex];
      const horizontalDistance = targetCenter.x - actorCenter.x;
      if (Math.abs(horizontalDistance) < 0.15) continue;
      const actorDirection = horizontalDistance > 0 ? 'right' : 'left';
      const targetDirection = horizontalDistance > 0 ? 'left' : 'right';
      directionCandidates[actorIndex].add(actorDirection);
      if (hasDirectInteraction || structuredPairs.length) {
        directionCandidates[targetIndex].add(targetDirection);
        baseDirections.push('characters facing their interaction partners');
      }
      baseDirections.push(`interaction directed from ${actorDirection === 'right' ? 'left to right' : 'right to left'}`);
    }
  }

  directionCandidates.forEach((directions, index) => {
    if (directions.size === 1) {
      characterDirections[index] = `facing ${[...directions][0]}`;
    }
  });
  if (characters.length >= 3) {
    baseDirections.push('single unified three-character composition', 'distinct left center right staging', 'readable interaction graph');
  }

  return {
    centers,
    characterDirections,
    basePrompt: [...new Set(baseDirections)].join(', ')
  };
}

function 标准化互动动作(action = '') {
  const raw = String(action || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (/^[a-z0-9_]+$/.test(raw)) return raw;
  const mappings = [
    [/拥抱|抱住|搂抱|相拥|hug/, 'hug'],
    [/亲吻|接吻|吻|kiss/, 'kiss'],
    [/牵手|握手|holding hands/, 'holding_hands'],
    [/指向|指着|point/, 'pointing'],
    [/推|push/, 'pushing'],
    [/拉|pull/, 'pulling'],
    [/抓|grab/, 'grabbing'],
    [/看向|凝视|对视|look|gaze/, 'looking_at_another'],
    [/攻击|刺|砍|attack|strike/, 'attacking']
  ];
  return mappings.find(([pattern]) => pattern.test(String(action || '')))?.[1] || '';
}

function 是强方向性交互动作(action = '') {
  const normalized = 标准化互动动作(action);
  return /^(?:sex|penetration|vaginal(?:_penetration)?|anal(?:_penetration)?|handjob|footjob|blowjob|fellatio|irrumatio|paizuri|cunnilingus)$/i.test(normalized);
}

function 构建互动动作标签(sceneCharacters = [], interactionActions = []) {
  const characters = Array.isArray(sceneCharacters) ? sceneCharacters : [];
  const tagsByCharacter = characters.map(() => []);
  const byName = new Map(characters.map((char, index) => [String(char?.name || '').trim().toLowerCase(), index]));

  for (const interaction of Array.isArray(interactionActions) ? interactionActions : []) {
    const action = 标准化互动动作(interaction?.action);
    if (!action) continue;
    const sourceIndex = byName.get(String(interaction?.source || '').trim().toLowerCase());
    const targetIndex = byName.get(String(interaction?.target || '').trim().toLowerCase());
    const isMutual = interaction?.mutual === true && !是强方向性交互动作(action);
    if (isMutual) {
      if (sourceIndex !== undefined && targetIndex !== undefined) {
        tagsByCharacter[sourceIndex].push(`mutual#${action}`);
        tagsByCharacter[targetIndex].push(`mutual#${action}`);
      }
    } else {
      if (sourceIndex !== undefined) {
        tagsByCharacter[sourceIndex].push(`source#${action}`);
      }
      if (targetIndex !== undefined) {
        tagsByCharacter[targetIndex].push(`target#${action}`);
      }
    }
  }
  return tagsByCharacter.map(items => [...new Set(items)]);
}

export function estimateV45Tokens(text = '') {
  return 按逗号拆分提示词(text).reduce((sum, token) => {
    const normalized = String(token || '').trim();
    if (!normalized) return sum;

    const wordCount = (normalized.match(/[A-Za-z0-9]+/g) || []).length;
    const separatorCount = (normalized.match(/[_:#-]/g) || []).length;
    const charCost = Math.ceil(normalized.length / 5);
    const wordCost = Math.floor(Math.max(0, wordCount - 1) * 2 / 3);
    const separatorCost = Math.ceil(separatorCount / 2);

    return sum + Math.max(1, charCost + wordCost + separatorCost);
  }, 0);
}

function promptTokenPriority(token = '') {
  if (/^(?:girl|boy|other|1girl|1boy|1other|[1-6](?:girls|boys|others))$/i.test(token)) return 95;
  if (/(?:^|::)\s*artist:|^artist:|official art|year20\d\d/i.test(token)) return 92;
  if (/^(?:no text|textless|no watermark|watermark)$/i.test(token)) return 91;
  if (/exactly_|only_|facing |interaction directed|characters facing/i.test(token)) return 90;
  if (/hair|eyes|dress|robe|shirt|skirt|armor|uniform|skin|breasts|muscular|petite/i.test(token)) return 75;
  if (/^(?:source|target|mutual)#/i.test(token)) return 72;
  if (/hug|kiss|hold|grab|push|pull|point|attack|look|pose|standing|sitting|kneeling/i.test(token)) return 70;
  if (/masterpiece|aesthetic|quality|absurdres|detailed|lighting|atmosphere/i.test(token)) return 20;
  return 50;
}

function trimPromptTokens(prompt = '', tokenBudget = 0) {
  const tokens = 按逗号拆分提示词(prompt);
  if (estimateV45Tokens(prompt) <= tokenBudget) return prompt;
  const selected = [];
  let used = 0;
  tokens
    .map((token, index) => ({ token, index, priority: promptTokenPriority(token) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .forEach(item => {
      const cost = estimateV45Tokens(item.token);
      if (used + cost > tokenBudget) return;
      selected.push(item);
      used += cost;
    });
  return selected.sort((a, b) => a.index - b.index).map(item => item.token).join(', ');
}

export function enforceV45PromptBudget(basePrompt = '', characterPrompts = [], maxTokens = 400) {
  const prompts = Array.isArray(characterPrompts) ? characterPrompts : [];
  const minimumCharacterBudget = prompts.length > 0 ? 50 : 0;
  const baseBudget = Math.max(100, Math.min(220, maxTokens - prompts.length * minimumCharacterBudget));
  const trimmedBase = trimPromptTokens(basePrompt, baseBudget);
  let remaining = Math.max(0, maxTokens - estimateV45Tokens(trimmedBase));
  const trimmedCharacters = prompts.map((prompt, index) => {
    const remainingCharacters = prompts.length - index;
    const budget = Math.max(30, Math.floor(remaining / remainingCharacters));
    const trimmed = trimPromptTokens(prompt, budget);
    remaining -= estimateV45Tokens(trimmed);
    return trimmed;
  });
  return {
    basePrompt: trimmedBase,
    characterPrompts: trimmedCharacters,
    estimatedTokens: estimateV45Tokens([trimmedBase, ...trimmedCharacters].join(', '))
  };
}

function 构建均衡多人构图(prompt = '', sceneCharacters = []) {
  const visiblePrimaryCharacters = (sceneCharacters || []).filter(char => !是明确背景角色(char));
  if (visiblePrimaryCharacters.length < 2) {
    return { prompt, positive: '', negative: '' };
  }

  const singleSubjectFocus = /^(?:close[-_ ]?up|extreme close[-_ ]?up|macro|focus on .+|focus_on_.+|solo focus|solo_focus)$/i;
  const separatedPosition = /^(?:on[_ ]?(?:the[_ ]?)?(?:left|right)|left[_ ]?(?:side|foreground|background)?|right[_ ]?(?:side|foreground|background)?|far[_ ]?(?:left|right)|separate(?:d)?|apart)$/i;
  const cleanedPrompt = 按逗号拆分提示词(prompt)
    .filter(token => !singleSubjectFocus.test(token) && !separatedPosition.test(token))
    .join(', ');

  return {
    prompt: cleanedPrompt,
    positive: 'same focal plane',
    negative: 'vertical divider, central dividing line, hard split, two-tone split background, separate backgrounds, side-by-side character cards, paired portraits, versus screen, before and after, comparison layout, isolated characters, characters standing apart, tiny secondary character, distant secondary character, simplified background character, low-detail secondary character, chibi secondary character, super deformed secondary character, blurred secondary character'
  };
}

function 构建多人身高约束(sceneCharacters = [], characterAnchors = []) {
  if (!Array.isArray(sceneCharacters) || sceneCharacters.length < 2) {
    return { basePrompt: '', byName: new Map() };
  }

  const ranked = sceneCharacters.map((char, index) => {
    const anchor = 按姓名查找(characterAnchors, char?.name)
      || (!String(char?.name || '').trim() ? characterAnchors[index] || null : null);
    return {
      name: String(char?.name || '').trim(),
      level: 推导身高等级(anchor),
      index
    };
  });
  const levels = ranked.map(item => item.level);
  const min = Math.min(...levels);
  const max = Math.max(...levels);
  const byName = new Map();

  if (max > min) {
    for (const item of ranked) {
      const key = item.name.toLowerCase() || `#${item.index}`;
      if (item.level === max) byName.set(key, 'slightly taller');
      else if (item.level === min) byName.set(key, 'slightly shorter');
      else byName.set(key, 'average height');
    }
  }

  return {
    basePrompt: 'natural proportions, slight height difference, eye-level camera',
    byName
  };
}

function 按姓名查找(mapItems, name) {
  const cleanName = String(name || '').split('(')[0].trim().toLowerCase();
  if (!cleanName) return null;
  return mapItems.find(item => {
    const names = [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
      .map(value => String(value || '').split('(')[0].trim().toLowerCase())
      .filter(Boolean);
    return names.includes(cleanName);
  }) || null;
}

function 角色场景状态(char = {}) {
  const clothing = String(char?.clothing || '');
  const appearance = String(char?.appearance || '');
  const pose = String(char?.pose || '');
  return {
    hasExplicitClothing: clothing.trim().length > 0 && !/未指明|unspecified|unknown/i.test(clothing),
    nude: /全裸|赤裸|裸体|一丝不挂|completely[_ ]nude|\bnude\b|\bnaked\b/i.test(clothing),
    whiteClothing: /白衣|白色|素色|white/i.test(clothing),
    blackClothing: /黑衣|黑色|black/i.test(clothing),
    looseHair: /披发|披肩|散发|散乱|发丝凌乱|long hair down|hair down|messy hair/i.test(`${appearance} ${clothing}`),
    prone: /趴|俯卧|伏在|on stomach|prone|all fours/i.test(pose),
    sideLying: /侧卧|侧躺|lying on side/i.test(pose),
    standing: /站立|站在|standing/i.test(pose),
    kneeling: /跪|kneeling/i.test(pose)
  };
}

function 应删除的Dna标签(token, state) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) return true;
  const clothingTag = /(robe|dress|skirt|shirt|sweater|jacket|coat|cloak|cape|uniform|outfit|clothes|clothing|hanfu|ruqun|dougi|armor|pants|jeans|shorts|underwear|bra|panties|stockings|boots|shoe|sandal|sleeve|collar)/i;
  const hairStyleTag = /(hair_bun|updo|ponytail|twin_tails|braid|braided_hair|hair_up|hair_ornament|kanzashi)/i;
  if (state.nude && clothingTag.test(value)) return true;
  if (state.hasExplicitClothing && clothingTag.test(value)) return true;
  if (state.looseHair && hairStyleTag.test(value)) return true;
  return false;
}

function 应删除的场景冲突标签(token, state) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) return true;
  if (state.nude && /(clothed|clothes|clothing|robe|dress|shirt|skirt|pants|jeans|underwear|bra|panties|partially_undressed)/i.test(value)) return true;
  if (state.whiteClothing && /black_(robe|dress|shirt|clothes|outfit)/i.test(value)) return true;
  if (state.blackClothing && /white_(robe|dress|shirt|clothes|outfit)/i.test(value)) return true;
  if (state.looseHair && /(hair_bun|updo|ponytail|hair_up|hair_ornament|kanzashi)/i.test(value)) return true;
  if (state.prone && /^(on_back|lying_on_back|standing|sitting)$/i.test(value)) return true;
  if (state.sideLying && /^(standing|kneeling|on_stomach|prone)$/i.test(value)) return true;
  if (state.standing && /^(sitting|kneeling|lying|on_back|on_stomach|prone)$/i.test(value)) return true;
  if (state.kneeling && /^(standing|sitting|lying|on_back)$/i.test(value)) return true;
  return false;
}

function 应用角色场景状态覆盖(prompt = '', char = {}) {
  const state = 角色场景状态(char);
  let tokens = 按逗号拆分提示词(prompt)
    .filter(token => !应删除的场景冲突标签(token, state))
  if (state.nude) {
    tokens = tokens.map(token => {
      if (/^completely[_ ]nude$/i.test(String(token || '').trim())) {
        return '1.35::completely_nude::';
      }
      return token;
    });
    if (!tokens.some(token => /completely[_ ]nude/i.test(String(token || '')))) {
      tokens.push('1.35::completely_nude::');
    }
  }
  return tokens.join(', ');
}

/**
 * 核心：构建角色锚点注入提示词 (DNA Prompts Bundle)
 * 提取角色 DNA 库中适用于当前构图类型的标签子集，防止“镜头失控”或“服装标签污染”
 */
export function 构建角色锚点注入提示词(anchor, options) {
  if (!anchor) return "";
  const positive = (anchor.正面提示词 || '').trim();
  const features = anchor.结构化特征;
  const composition = options.构图;
  const state = 角色场景状态(options.当前角色 || {});

  const 去除镜头构图词 = (tokens) => {
    const cameraWords = /(headshot|portrait|upper body|waist-?up|full body|cowboy shot|close-?up|extreme close-?up|wide shot|mid shot|low angle|high angle|standing|sitting|kneeling|running|framing|character sheet|composition|depth of field|rule of thirds|feet included|floor contact|avatar)/i;
    return tokens.filter((token) => !cameraWords.test(token));
  };

  const 从结构化特征挑选 = (keys, limit = 24) => {
    if (!features) return [];
    const fragments = keys
      .flatMap((key) => (Array.isArray(features[key]) ? features[key] : []))
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    return 去除镜头构图词(去重提示词片段(fragments)).slice(0, Math.max(0, limit));
  };

  const 从原始提示词挑选 = (params) => {
    if (!positive) return [];
    if (/::/.test(positive)) return []; // 含权重语法时不做逗号拆分，以免破坏结构
    const tokens = 去除镜头构图词(去重提示词片段(按逗号拆分提示词(positive)));
    const filtered = tokens.filter((token) => params.allow.test(token) && !params.deny.test(token));
    return filtered.slice(0, Math.max(0, params.limit ?? 24));
  };

  // 头像构图：仅抽取面部、发型、发色、眼睛、肤色和年龄等面部特征标签，剔除衣服和道具
  if (composition === '头像') {
    const tokensFromFeatures = 从结构化特征挑选([
      '外貌标签',
      '发型标签',
      '发色标签',
      '眼睛标签',
      '肤色标签',
      '年龄感标签',
      '特殊特征标签'
    ], 20);
    if (tokensFromFeatures.length > 0) return tokensFromFeatures.join(', ');

    const allow = /(1girl|1boy|girl|boy|woman|man|female|male|young|adult|teen|hair|eyes?|iris|pupil|eyebrow|eyelash|face|lips?|mouth|nose|skin|complexion|freckle|mole|beauty mark|scar|tattoo|makeup|ear|neck)/i;
    const deny = /(breast|bust|cleavage|waist|hip|thigh|leg|feet|nude|dress|robe|hanfu|armor|outfit|clothing|sleeve|glove|stocking|boots|pants|skirt|kimono|cape|cloak|weapon|sword|background|scenery|environment|landscape)/i;
    return 从原始提示词挑选({ allow, deny, limit: 16 }).join(', ');
  }

  // 部位特写构图：仅挑选与对应特写部位最相关的特征（如胸部特写只保留胸围和肤色，防镜头拉远）
  if (composition === '部位特写') {
    const part = options.部位;
    if (part === '胸部') {
      const allow = /(breast|breasts|bust|cup|cleavage|nipple|nipples|areola|chest|skin|complexion|pale|fair|tan|young|adult|teen)/i;
      const deny = /(face|eyes?|hair|lips?|mouth|nose|dress|robe|hanfu|armor|outfit|clothing|upper body|waist|portrait|full body)/i;

      const tokens = 从结构化特征挑选(['胸部标签', 'NSFW标签', '肤色标签', '年龄感标签'], 14)
        .filter((token) => allow.test(token) && !deny.test(token));
      if (tokens.length > 0) return tokens.join(', ');

      return 从原始提示词挑选({ allow, deny, limit: 10 }).join(', ');
    }

    const allow = /(skin|complexion|pale|fair|tan|young|adult|teen)/i;
    const deny = /(face|eyes?|hair|dress|robe|hanfu|armor|outfit|clothing|upper body|waist|portrait|full body|standing|sitting|kneeling|feet)/i;

    const safe = 从结构化特征挑选(['肤色标签', '年龄感标签'], 8)
      .filter((token) => allow.test(token) && !deny.test(token));
    if (safe.length > 0) return safe.join(', ');

    return 从原始提示词挑选({ allow, deny, limit: 6 }).join(', ');
  }

  // 半身/立绘/场景：保留稳定外貌，但当前服装、裸体和披发状态优先于 DNA 常驻设定。
  if (features) {
    const keys = [
      '外貌标签',
      '身材标签',
      '胸部标签',
      '发型标签',
      '发色标签',
      '眼睛标签',
      '肤色标签',
      '年龄感标签',
      '服装基底标签',
      '特殊特征标签'
    ];
    if (state.nude) {
      keys.splice(3, 0, 'NSFW标签');
    }
    const tokens = keys
      .flatMap(key => Array.isArray(features[key]) ? features[key] : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .filter(token => !应删除的Dna标签(token, state));
    if (tokens.length > 0) return 去重提示词片段(tokens).join(', ');
  }
  return 按逗号拆分提示词(positive)
    .filter(token => !应删除的Dna标签(token, state))
    .join(', ');
}

/**
 * 构建后置正向提示词（构图画质与修饰增强）
 */
function 构建后置正向提示词(options) {
  const characterCount = Array.isArray(options?.角色列表) ? options.角色列表.length : 0;
  const promptText = String(options?.主体提示词 || '');
  const isMultiCharacter = characterCount >= 2 || /\b(2girls|3girls|4girls|5girls|6girls|2boys|3boys|4boys|5boys|6boys|1girl\s*,\s*1boy|1boy\s*,\s*1girl|multiple characters|group)\b/i.test(promptText);
  const useNL = options?.useNaturalLanguage;

  let 单人角色构图增强 = '';
  if (useNL) {
    单人角色构图增强 = isMultiCharacter ? '' : options?.构图 === '头像'
      ? 'solo portrait.'
      : options?.构图 === '半身'
        ? 'solo upper body portrait.'
        : options?.构图 === '立绘'
          ? 'solo full body character.'
          : options?.构图 === '场景'
            ? 'wide establishing shot, cinematic composition.'
            : 'single character only.';
  } else {
    单人角色构图增强 = isMultiCharacter ? '' : options?.构图 === '头像'
      ? 'single character only, solo portrait, one face, one head, centered headshot, no other people'
      : options?.构图 === '半身'
        ? 'single character only, solo upper body portrait, one person, no other people'
        : options?.构图 === '立绘'
          ? 'single character only, solo full body character, one person, no other people, detailed background'
          : options?.构图 === '场景'
            ? 'wide establishing shot, detailed environment, immersive atmosphere, cinematic composition, scenic view'
            : '';
  }

  const 无文字提示词 = useNL ? 'single coherent image.' : 全局无文字正向提示词;

  let 部位特写画质 = '';
  let 部写单图 = '';
  if (options?.构图 === '部位特写') {
    if (useNL) {
      部位特写画质 = 'macro close-up focus, wet skin texture, rim light.';
      部写单图 = 'single image macro crop.';
    } else {
      部位特写画质 = NSFW部位特写画质增强提示词;
      部写单图 = 部位特写单图正向提示词;
    }
  }
  
  return mergePositivePromptParts(
    单人角色构图增强,
    无文字提示词,
    部位特写画质,
    部写单图
  );
}

/**
 * 合并负面提示词片段
 */
export function mergeNegativePromptParts(...parts) {
  const seen = new Set();
  const items = [];
  parts.forEach((part) => {
    (part || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        items.push(item);
      });
  });
  return items.join(', ');
}

/**
 * 核心：装配最终 NovelAI 生图提示词
 * 整合：前置风格 + 场景生图词组 + 角色 DNA 标签（Prompts Bundle） + 后置构图画质增强
 */
export function buildFinalImagePrompt(prompt, {
  composition = '场景',
  sceneType = '剧照场景',
  extraPositive = '',
  extraNegative = '',
  size = '',
  characterAnchors = [], // 匹配到的角色 DNA 数组
  sceneCharacters = [], // 结构化场景角色数组
  sceneNsfwRating = 'sfw',
  sceneEnvironment = '',
  sceneDescription = '',
  sceneInteractions = '',
  sceneInteractionActions = [],
  structuredCharacterPrompts = [], // LLM 输出的角色级 prompts
  sceneMustShow = [],
  sceneMustNotShow = [],
  artistStylePrompt = '', // 全局画师/风格串，追加在 NAI 正向提示词末尾
  useCharacterSegments = true, // 是否启用 NAI V4/V4.5 的角色分段语法 (|)
  useNaturalLanguage = false  // V4.5 自然语言模式：跳过标签清洗逻辑，启用权重守卫
} = {}) {
  // 1. 尺寸自适应装配
  let finalSize = (size || '').trim();
  const requestedSize = finalSize;
  const sizeMatch = requestedSize.match(/^(\d+)\s*[xX]\s*(\d+)$/);
  finalSize = sizeMatch ? `${sizeMatch[1]}x${sizeMatch[2]}` : '';

  if (!finalSize) {
    // 尺寸映射：与 LLM 的 orientation 输出对齐
    if (composition === '场景') {
      finalSize = '1216x832'; // landscape - 横图适合风景
    } else if (composition === '立绘') {
      finalSize = '832x1216'; // portrait - 竖图适合全身立绘
    } else if (composition === '半身') {
      finalSize = '768x1024'; // 半身接近竖图，稍矮
    } else if (composition === '头像') {
      finalSize = '1024x1024'; // 头像正方形
    } else {
      finalSize = '1024x1024'; // 默认正方形
    }
  }

  let [parsedWidth, parsedHeight] = finalSize.split('x').map(Number);
  if (composition === '头像' && parsedWidth !== parsedHeight) {
    finalSize = '1024x1024';
    parsedWidth = 1024;
    parsedHeight = 1024;
  }

  const width = Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : 1024;
  const height = Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 1024;

  // 2. 主体提示词净化
  const rawSceneCharacterList = Array.isArray(sceneCharacters) ? sceneCharacters : [];
  const sceneCharacterList = rawSceneCharacterList
    .map((char, index) => ({
      char,
      index,
      center: 解析角色位置(char?.position, index, rawSceneCharacterList.length)
    }))
    .sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y || a.index - b.index)
    .map(item => item.char);
  let cleanPrompt = conservativeCompletionNaiWeights(prompt);
  const rawMustShow = (Array.isArray(sceneMustShow) ? sceneMustShow : [])
    .map(item => String(item || '').trim())
    .filter(item => item && /^[\x20-\x7E]+$/.test(item));

  let hardPositive;
  if (useNaturalLanguage) {
    // V4.5 自然语言模式：将 must_show 元素用较低权重（1.2::）标注，最多取前 2 个
    // 超过 2 个的元素直接以自然语言写入 cleanPrompt，不加权重
    hardPositive = rawMustShow.slice(0, 2).map(item => `1.2::${item}::`).join(', ');
    const extraMustShow = rawMustShow.slice(2).join(', ');
    if (extraMustShow) cleanPrompt = mergePositivePromptParts(cleanPrompt, extraMustShow);
  } else {
    // 旧版标签模式：保留原有的 1.45:: 高权重逻辑
    hardPositive = rawMustShow.map(item => `1.45::${item}::`).join(', ');
  }
  cleanPrompt = mergePositivePromptParts(cleanPrompt, hardPositive);
  cleanPrompt = 移除无依据的高风险表情(cleanPrompt, sceneCharacterList);
  if (sceneCharacterList.length >= 2) {
    cleanPrompt = 净化多人身高标签(cleanPrompt);
  }
  const balancedMultiCharacter = 构建均衡多人构图(cleanPrompt, sceneCharacterList);
  cleanPrompt = balancedMultiCharacter.prompt;

  // 3. 中国人面部特征注入（针对角色构图，且提示词中没有指明外国人）
  const needsChinesePerson = 是否角色构图(composition)
    && !提示词明确外国人(`${extraPositive}, ${cleanPrompt}`);

  const finalChinesePersonPrompt = needsChinesePerson
    ? (useNaturalLanguage ? 'East Asian features' : 默认中国人物正向提示词)
    : '';

  const prePositive = mergePositivePromptParts(
    extraPositive,
    finalChinesePersonPrompt
  );

  const postPositive = 构建后置正向提示词({
    构图: composition,
    场景类型: sceneType,
    尺寸: finalSize,
    角色列表: sceneCharacterList,
    主体提示词: cleanPrompt,
    useNaturalLanguage: useNaturalLanguage
  });

  // 4. 角色 DNA 标签 (Prompts Bundle) 计算与注入
  // 将匹配到的角色 DNA 结构化数据转换成适合当前构图的 tags
  const charDnaTagsArray = characterAnchors.map(anchor => {
    return 构建角色锚点注入提示词(anchor, { 构图: composition, 部位: sceneType });
  }).filter(Boolean);

  const structuredPromptList = Array.isArray(structuredCharacterPrompts) ? structuredCharacterPrompts : [];
  const heightConstraints = 构建多人身高约束(sceneCharacterList, characterAnchors);
  const spatialGuidance = buildCharacterSpatialGuidance(sceneCharacterList, sceneInteractions, sceneInteractionActions);
  const needsPenetrationInset = 是插入局部放大场景({
    sceneNsfwRating,
    sourcePrompt: cleanPrompt,
    sceneDescription,
    sceneInteractions,
    sceneInteractionActions,
    sceneMustShow
  });
  const hasDirectInteraction = 场景存在直接互动({
    prompt: cleanPrompt,
    sceneInteractions,
    sceneInteractionActions
  });
  const needsMultiCompositionGuard = sceneCharacterList.length >= 2
    && hasDirectInteraction
    && !已有统一构图提示(cleanPrompt);
  const needsScaleGuard = sceneCharacterList.length >= 2
    && !/consistent character scale|same ground plane|same focal plane|natural proportions/i.test(cleanPrompt);
  const interactionTags = 构建互动动作标签(sceneCharacterList, sceneInteractionActions);
  const negativeCharacterPrompts = [];
  const characterPrompts = sceneCharacterList.map((char, index) => {
    const hasCharacterName = Boolean(String(char?.name || '').trim());
    const matchedAnchor = 按姓名查找(characterAnchors, char?.name)
      || (!hasCharacterName ? characterAnchors[index] || null : null);
    const dnaTags = matchedAnchor
      ? 构建角色锚点注入提示词(matchedAnchor, { 构图: composition, 部位: sceneType, 当前角色: char })
      : (!hasCharacterName ? charDnaTagsArray[index] || '' : '');
    const structured = 按姓名查找(structuredPromptList, char?.name)
      || (!hasCharacterName ? structuredPromptList[index] || null : null);
    const structuredPrompt = typeof structured === 'string' ? structured : structured?.prompt;
    negativeCharacterPrompts.push(
      removeNonEnglishPromptTokens(mergeNegativePromptParts(
        typeof structured === 'string' ? '' : structured?.negative_prompt || '',
        matchedAnchor?.负面提示词 || ''
      ))
    );

    let finalCharPrompt;
    if (useNaturalLanguage) {
      if (structuredPrompt) {
        // 自然语言模式：直接使用 LLM 输出的英文描述，不拼接原始逗号分隔的 DNA 标签
        finalCharPrompt = structuredPrompt;
      } else {
        const genderTag = 角色性别标签(char?.gender);
        finalCharPrompt = mergePositivePromptParts(genderTag, dnaTags);
      }
    } else {
      if (structuredPrompt) {
        // 旧版标签模式：直接使用，再叠加 DNA 锚点
        finalCharPrompt = mergePositivePromptParts(structuredPrompt, dnaTags);
      } else {
        // 无 structured prompt：仅使用 DNA 锚点，添加性别标签
        const genderTag = 角色性别标签(char?.gender);
        finalCharPrompt = mergePositivePromptParts(genderTag, dnaTags);
      }
    }

    finalCharPrompt = 应用角色场景状态覆盖(finalCharPrompt, char);
    finalCharPrompt = 清理体液与汗水冲突(finalCharPrompt);
    const genderTag = 角色性别标签(char?.gender);
    if (genderTag === 'girl' || genderTag === 'boy') {
      const segmentGenderTag = useCharacterSegments && !useNaturalLanguage ? genderTag : `1${genderTag}`;
      finalCharPrompt = mergePositivePromptParts(segmentGenderTag, 移除角色局部数量标签(finalCharPrompt));
    }
    finalCharPrompt = 净化角色表情提示词(
      finalCharPrompt,
      char?.expression || '',
      sceneNsfwRating
    );
    if (sceneCharacterList.length >= 2) {
      const heightKey = String(char?.name || '').trim().toLowerCase() || `#${index}`;
      const charInteractionTags = (interactionTags[index] || []).filter(tag => {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return !new RegExp(`\\b${escaped}\\b`, 'i').test(finalCharPrompt);
      });
      finalCharPrompt = mergePositivePromptParts(
        净化多人身高标签(finalCharPrompt),
        heightConstraints.byName.get(heightKey) || '',
        spatialGuidance.characterDirections[index] || '',
        charInteractionTags.join(', ')
      );
      finalCharPrompt = 按逗号拆分提示词(finalCharPrompt)
        .filter(token => !/^(?:on[_ ]?(?:the[_ ]?)?(?:left|right)|left[_ ]?(?:side|foreground|background)?|right[_ ]?(?:side|foreground|background)?|far[_ ]?(?:left|right))$/i.test(token))
        .join(', ');
    }

    return finalCharPrompt;
  }).filter(Boolean);

  let fallbackCharacterPrompts;
  if (useNaturalLanguage) {
    // V4.5 自然语言模式：不过滤中文（已经是英语句子），不过滤 non-English
    // 但进行权重守卫
    fallbackCharacterPrompts = (characterPrompts.length > 0 ? characterPrompts : charDnaTagsArray)
      .map(p => clampNaturalLanguageWeights(p))
      .filter(Boolean);
  } else {
    fallbackCharacterPrompts = (characterPrompts.length > 0 ? characterPrompts : charDnaTagsArray)
      .map(prompt => useCharacterSegments
        ? normalizeDanbooruPromptSegment(prompt, { character: true })
        : removeNonEnglishPromptTokens(prompt)
      )
      .filter(Boolean);
  }
  const characterCountPrompt = 构建人物数量标签(sceneCharacterList);
  const exactCharacterCountPrompt = 构建精确人物数量约束(sceneCharacterList);
  const actionEmphasisPrompt = 构建动作关系强调提示词(cleanPrompt);
  const environmentEnhancementPrompt = 构建场景环境增强提示词(
    sceneEnvironment,
    sceneDescription,
    composition
  );
  const normalizedArtistStylePrompt = normalizeArtistTag(artistStylePrompt || '');

  // 5. 组合正向提示词
  let basePrompt = mergePositivePromptParts(
    prePositive,
    characterCountPrompt,
    exactCharacterCountPrompt,
    cleanPrompt,
    actionEmphasisPrompt,
    environmentEnhancementPrompt,
    needsScaleGuard ? (useNaturalLanguage ? 'natural proportions, slight height difference, eye-level camera.' : heightConstraints.basePrompt) : '',
    spatialGuidance.basePrompt,
    needsMultiCompositionGuard ? (useNaturalLanguage ? 'same focal plane.' : balancedMultiCharacter.positive) : '',
    needsPenetrationInset ? (useNaturalLanguage ? 'single magnified inset showing cross-section penetration focus.' : 插入局部放大正向提示词) : '',
    postPositive,
    normalizedArtistStylePrompt
  );
  // 对 basePrompt 应用全局正则规则
  if (useNaturalLanguage) {
    // V4.5 自然语言模式：不过滤 non-English，只进行权重守卫
    basePrompt = clampNaturalLanguageWeights(normalizeArtistTag(basePrompt));
  } else {
    basePrompt = normalizeDanbooruPromptSegment(normalizeArtistTag(basePrompt));
  }
  let budgetedPrompts;
  if (useNaturalLanguage) {
    // V4.5 自然语言模式：就算紧凑预算，也不对自然语言句子进行逆向拆分
    // 只对画师风格串和验证不会化层的部分执行 budget
    budgetedPrompts = enforceV45PromptBudget(basePrompt, fallbackCharacterPrompts);
    basePrompt = budgetedPrompts.basePrompt;
    fallbackCharacterPrompts = budgetedPrompts.characterPrompts;
  } else {
    budgetedPrompts = enforceV45PromptBudget(basePrompt, fallbackCharacterPrompts);
    basePrompt = budgetedPrompts.basePrompt;
    fallbackCharacterPrompts = budgetedPrompts.characterPrompts;
  }
  let finalPositive = "";

  if (useCharacterSegments && fallbackCharacterPrompts.length > 0) {
    finalPositive = [basePrompt, ...fallbackCharacterPrompts].join(' | ');
  } else {
    // 扁平降级只保留全局人物计数，避免角色段里的 1girl/1boy 被模型理解为新增人物。
    const joinedCharDna = fallbackCharacterPrompts.map(移除角色局部数量标签).join(', ');
    finalPositive = mergePositivePromptParts(basePrompt, joinedCharDna);
  }

  if (useNaturalLanguage) {
    // V4.5 自然语言模式：不过滤 non-English，对整个最终字符串执行权重守卫
    finalPositive = clampNaturalLanguageWeights(normalizeArtistTag(finalPositive));
  } else {
    finalPositive = useCharacterSegments
      ? finalPositive
          .split('|')
          .map((segment, index) => normalizeDanbooruPromptSegment(normalizeArtistTag(segment), { character: index > 0 }))
          .filter(Boolean)
          .join(' | ')
      : removeNonEnglishPromptTokens(normalizeArtistTag(finalPositive));
  }

  // 6. 组合负面提示词：基础画质/文字压制 + 构图约束 + 全局/场景额外负面词
  let compositionNegative = 构图附加负面提示词映射[composition] || '';
  
  const characterCount = sceneCharacterList.length;
  const promptText = String(cleanPrompt || '');
  const isMultiCharacter = characterCount >= 2 || /\b(2girls|3girls|4girls|5girls|6girls|2boys|3boys|4boys|5boys|6boys|1girl\s*,\s*1boy|1boy\s*,\s*1girl|multiple characters|group)\b/i.test(promptText);
  
  if (isMultiCharacter) {
    const multiPersonDenyTags = new Set([
      'multiple people', 'two people', 'three people', 'group'
    ]);
    compositionNegative = compositionNegative
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => !multiPersonDenyTags.has(tag.toLowerCase()))
      .join(', ');
  }

  const finalNegative = 移除纯色背景负面限制(removeNonEnglishPromptTokens(mergeNegativePromptParts(
    默认NovelAI负面提示词,
    sceneCharacterList.some(char => 原文明确要求露齿表情(char?.expression || ''))
      ? ''
      : 默认表情稳定负面提示词,
    compositionNegative,
    构建额外人物负面提示词(sceneCharacterList),
    构建动作关系负面提示词(cleanPrompt),
    balancedMultiCharacter.negative,
    构建私密场景负面词({ prompt: cleanPrompt, sceneEnvironment, sceneDescription }),
    (Array.isArray(sceneMustNotShow) ? sceneMustNotShow : [])
      .map(item => String(item || '').trim())
      .filter(item => item && /^[\x20-\x7E]+$/.test(item))
      .join(', '),
    extraNegative
  )));

  const resolvedFinalNegative = needsPenetrationInset
    ? 允许插入放大图负面词(finalNegative)
    : finalNegative;

  return {
    prePositive,
    mainPositive: cleanPrompt,
    postPositive,
    basePrompt,
    characterPrompts: fallbackCharacterPrompts,
    negativeCharacterPrompts,
    characterCenters: spatialGuidance.centers,
    estimatedPromptTokens: budgetedPrompts.estimatedTokens,
    finalPositive,
    finalNegative: resolvedFinalNegative,
    size: finalSize,
    width,
    height
  };
}
