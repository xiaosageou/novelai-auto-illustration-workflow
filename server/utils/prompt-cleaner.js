/**
 * NovelAI 提示词 (Prompt) 净化与权重防灾自愈模块
 * 融合了原 Python 版的防灾逻辑与 MoRanJiangHu 的提示词清洗/去重逻辑
 */

/**
 * 物理隔离大模型的思考块 (thinking/think 标签)
 */
export function removeThinkingBlocks(text) {
  if (!text) return "";
  let cleaned = text;
  cleaned = cleaned.replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, "");
  cleaned = cleaned.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "");
  return cleaned.trim();
}

/**
 * 清除冗余的代码块包裹和生图词组前缀
 */
export function cleanImagePromptOutput(text) {
  if (!text) return "";
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:text|markdown|json)?\s*/i, "");
  cleaned = cleaned.replace(/```$/i, "");
  cleaned = cleaned.replace(/^【?生图词组】?[:：]?/i, "");
  return cleaned.trim();
}

/**
 * 转换 Stable Diffusion 风格的括号权重语法为 NovelAI 特有语法。
 * 例如将 (masterpiece:1.2) 转换为 1.2::masterpiece::
 */
export function convertNaiBrackets(text) {
  if (!text) return "";
  let output = text;

  // 循环多次处理嵌套或并列的括号
  for (let i = 0; i < 8; i++) {
    const next = output.replace(/\(([^()]+?)\s*:\s*(-?\d+(?:\.\d+)?)\)/g, (_, content, weight) => {
      return `${weight.trim()}::${content.trim()}::`;
    });
    if (next === output) break;
    output = next;
  }

  // 兼容格式处理: ( 1.2 :: masterpiece :: ) -> 1.2::masterpiece::
  for (let i = 0; i < 8; i++) {
    const next = output.replace(/\(\s*(-?\d+(?:\.\d+)?)::([\s\S]*?)::\s*\)/g, (_, weight, content) => {
      return `${weight.trim()}::${content.trim()}::`;
    });
    if (next === output) break;
    output = next;
  }

  return output;
}

/**
 * 清洗脏逗号、双空格和多重冒号
 */
export function cleanNaiDirtyBrackets(text) {
  if (!text) return "";
  let output = text;

  output = output.replace(/,\s*,+/g, ", ");
  output = output.replace(/\s{2,}/g, " ");
  output = output.replace(/\s+,/g, ",");

  // 清洗类似 ", ::1.2::tag::" 的连接脏格式
  for (let i = 0; i < 8; i++) {
    const next = output.replace(/,\s*::\s*(-?\d+(?:\.\d+)?)::\s*([^:]+?)::/g, (_, weight, tag) => {
      return `, ${weight.trim()}::${tag.trim()}::`;
    });
    if (next === output) break;
    output = next;
  }

  // 清洗类似 "1.2::tag::, ::" 的连接脏格式
  for (let i = 0; i < 8; i++) {
    const next = output.replace(/(-?\d+(?:\.\d+)?)::\s*([^:]+?)\s*,\s*::/g, (_, weight, tag) => {
      return `${weight.trim()}::${tag.trim()}::, `;
    });
    if (next === output) break;
    output = next;
  }

  return output.trim();
}

/**
 * 规范化 Artist 标签的大小写 (Artist: -> artist:)
 */
export function normalizeArtistTag(text) {
  if (!text) return "";
  return text.replace(/\bArtist\s*:/gi, "artist:");
}

/**
 * 精准提取被 <提示词>、<词组> 或 <生图词组> 包裹的核心内容
 */
export function extractTagsBlock(text) {
  const withoutThinking = removeThinkingBlocks(text);
  if (!withoutThinking) return "";

  const labels = ["提示词", "词组", "生图词组"];
  for (const label of labels) {
    const regex = new RegExp(`<\\s*${label}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${label}\\s*>`, "i");
    const match = withoutThinking.match(regex);
    if (match) {
      return match[1].trim();
    }
  }

  // 兜底自愈：如果没有匹配到闭合标签，直接物理切除这些 xml 标签，剥离剩余文本
  let cleaned = withoutThinking;
  for (const label of labels) {
    const regex = new RegExp(`<\\s*\\/?\\s*${label}\\s*>`, "gi");
    cleaned = cleaned.replace(regex, "");
  }
  return cleaned.trim();
}

/**
 * 移除全部结构 XML 标签
 */
export function removeStructuralTags(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 移除大模型可能在角色输出里带上的角色编号前缀，例如 [1] Alice|
 */
export function removeIndexedRolePrefix(text) {
  if (!text) return "";
  return text.replace(/(^|\n)\s*\[\d+\]\s*[^|\n<>]{1,80}\|/g, "$1").trim();
}

/**
 * 提示词片段去重，同时保持原有的先后顺序
 */
export function deduplicatePromptTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  const seen = new Set();
  const result = [];

  for (const rawToken of tokens) {
    const token = (rawToken || "").trim();
    if (!token) continue;
    
    // 生成用于判重的 Key（忽略大小写和多余空格）
    const tokenKey = token.toLowerCase().replace(/\s+/g, "");
    if (!seen.has(tokenKey)) {
      seen.add(tokenKey);
      result.push(token);
    }
  }
  return result;
}

/**
 * 按逗号拆分提示词并进行清理去重
 */
export function splitAndDeduplicatePrompt(text) {
  if (!text) return "";
  
  // 支持按逗号（中英文）拆分，但要小心不能拆开了加权语法里的冒号
  // 在 NAI 语法中，逗号分隔不同 tag
  const rawTokens = text.split(/[,，]/);
  const cleanedTokens = rawTokens.map(t => t.trim()).filter(Boolean);
  const deduplicated = deduplicatePromptTokens(cleanedTokens);
  
  return deduplicated.join(", ");
}

/**
 * NAI tags must be English/ASCII. Drop any comma-delimited token containing
 * CJK text so untranslated DNA fragments cannot leak into the API payload.
 */
export function removeNonEnglishPromptTokens(text) {
  if (!text) return "";

  const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const tokens = String(text)
    .split(/[,，|]/)
    .map(token => token.trim())
    .filter(token => token && !cjkPattern.test(token));

  return deduplicatePromptTokens(tokens).join(", ");
}

/**
 * 合并多个正向提示词片段并去重
 */
export function mergePositivePromptParts(...parts) {
  const allTokens = [];
  for (const part of parts) {
    if (!part) continue;
    // 分割成单个 token，然后再合并
    const rawTokens = part.split(/[,，]/);
    allTokens.push(...rawTokens);
  }
  
  const deduplicated = deduplicatePromptTokens(allTokens);
  return normalizeArtistTag(deduplicated.join(", "));
}

/**
 * 提示词防灾净化终极入口（Python 版 conservative_completion_nai_weights 的升级版）
 */
export function conservativeCompletionNaiWeights(text) {
  if (!text) return "";

  // 1. 提取标签核心内容并过滤思考块
  const extracted = extractTagsBlock(text);

  // 2. 清理生图词组输出结构（移除 Markdown 语法包裹）
  const cleaned = cleanImagePromptOutput(extracted);

  // 3. 移除可能存在的角色索引前缀 [1] Alice|
  const noRolePrefix = removeIndexedRolePrefix(cleaned);

  // 4. 转换括号权重为 NAI 语法
  const converted = convertNaiBrackets(noRolePrefix);

  // 5. 清除可能残留的其他 XML 标签
  const noXml = removeStructuralTags(converted);

  // 6. 清除多余脏冒号及连接性字符
  const finalCleaned = cleanNaiDirtyBrackets(noXml);

  // 7. 去重与整理
  return splitAndDeduplicatePrompt(finalCleaned);
}

export function isTransientTag(tag) {
  if (!tag) return true;
  
  const cleanTag = tag.trim().toLowerCase();
  
  // 1. 禁用的精确匹配标签列表 (含表情、动作、临时/破损/情色身体状态、视角构图)
  const EXACT_BLACKLIST = new Set([
    // 情色与受强迫状态
    "ahegao", "nude", "naked", "undressing", "topless", "bottomless", "bare_breasts",
    "messy_clothes", "disheveled_clothes", "torn_clothes", "ripped_clothes",
    "wet_clothes", "wet_hair", "sweating", "sweat", "exhausted", "tired_eyes",
    "crying", "sobbing", "tears", "teary_eyes", "panicked", "frightened", "scared", "fear",
    "sexual_act", "penetration", "bound", "tied", "gagged", "slave_collar",
    "body_writing", "butt_writing", "thigh_writing", "blood_stains", "bleeding",
    "injured", "trembling", "shivering", "orgasm", "orgasm_expression", "panting", "gasping",
    "erection", "erect", "hard_on", "cum", "ejaculation",
    "blushing", "blushed", "flushed", "submissive", "dominant", "slave",
    
    // 表情与瞬时神态
    "smile", "smiling", "grin", "grinning", "smirk", "smirking", "laugh", "laughing", 
    "wink", "winking", "yawn", "yawning", "frown", "frowning", "scream", "screaming", 
    "pout", "pouting", "stare", "staring", "glare", "glaring", "open_mouth", "closed_mouth",
    "parted_lips", "closed_eyes", "shut_eyes", "eyes_closed", "winking_eye", "winking_eyes",
    "angry", "surprised", "shocked", "terrified", "worried", "excited", "sad", "happy",
    "looking_at_viewer", "looking_away", "looking_down", "looking_up", "looking_aside",
    
    // 动作与瞬时姿态
    "standing", "sitting", "kneeling", "lying", "crouching", "bending", "running", 
    "walking", "jumping", "flying", "dancing", "fighting", "leaning", "holding", 
    "reaching", "pointing", "grabbing", "carrying", "hugging", "kissing", "eating", 
    "drinking", "sleeping", "waving", "climbing", "riding", "stretching", "squatting", "posing",
    
    // 镜头与视角词
    "portrait", "headshot", "close-up", "closeup", "face_focus", "upper_body", 
    "half_body", "waist_up", "full_body", "backview", "side_view", "cow_shot", 
    "from_below", "from_above", "wide_shot", "side_profile"
  ]);

  if (EXACT_BLACKLIST.has(cleanTag)) {
    return true;
  }

  // 2. 禁用词根列表（如果标签分词中包含这些词根，则判定为临时/动作/表情/镜头状态）
  const BAD_ROOTS = new Set([
    // 临时与交欢/受强迫状态词根
    "sweat", "sweating", "nude", "naked", "ahegao", "orgasm", "bleeding", "injured",
    "erection", "erect", "cum", "ejaculation",
    "tremble", "trembling", "shiver", "shivering", "pant", "panting", "gasp", "gasping",
    "sobbing", "crying", "blush", "blushing", "flushed", "bound", "tied", "chained", 
    "restraint", "restrained", "handcuff", "handcuffed", "blindfold", "blindfolded", 
    "gag", "gagged", "submissive", "dominant", "slave", "dirty", "mud", "bruise", "bruised", 
    "wound", "wounding", "swoll", "swollen",
    
    // 动作姿态词根
    "stand", "standing", "sit", "sitting", "kneel", "kneeling", "lie", "lying", 
    "run", "running", "walk", "walking", "jump", "jumping", "fly", "flying", 
    "lean", "leaning", "hold", "holding", "reach", "reaching", "point", "pointing", 
    "grab", "grabbing", "carry", "carrying", "hug", "hugging", "kiss", "kissing", 
    "eat", "eating", "drink", "drinking", "sleep", "sleeping", "wave", "waving", 
    "climb", "climbing", "ride", "riding", "stretch", "stretching", "squat", "squating", 
    "squatting", "bend", "bending", "crouch", "crouching", "fight", "fighting", 
    "dance", "dancing", "pose", "posing",
    
    // 表情神态词根
    "smile", "smiling", "grin", "grinning", "smirk", "smirking", "laugh", "laughing",
    "wink", "winking", "yawn", "yawning", "frown", "frowning", "scream", "screaming",
    "pout", "pouting", "stare", "staring", "glare", "glaring", "angry", "surprised",
    "shocked", "scared", "panicked", "terrified", "worried", "excited", "sad", "happy",
    "expression", "expressions", "emotion", "emotions", "gaze",
    
    // 破损衣物词根
    "torn", "rip", "ripped", "shred", "shredded", "ruin", "ruined", "undress", "undressing",
    
    // 镜头构图与视角词根
    "portrait", "headshot", "closeup", "focus", "view", "perspective", "angle", "shot"
  ]);

  const words = cleanTag.split(/[_-]/);
  for (const word of words) {
    if (BAD_ROOTS.has(word)) {
      return true;
    }
  }

  // 3. 常见瞬时/动作/视角状态模式匹配
  if (
    cleanTag.startsWith("wet_") || 
    cleanTag.startsWith("messy_") || 
    cleanTag.startsWith("disheveled_") ||
    cleanTag.startsWith("torn_") ||
    cleanTag.startsWith("ripped_") ||
    cleanTag.startsWith("holding_") ||
    cleanTag.startsWith("looking_")
  ) {
    return true;
  }
  
  if (
    cleanTag.includes("sexual_") || 
    cleanTag.includes("_writing") || 
    cleanTag.includes("orgasm") ||
    cleanTag.includes("eyes_closed") ||
    cleanTag.includes("mouth_open") ||
    cleanTag.includes("open_mouth") ||
    cleanTag.includes("closed_eyes")
  ) {
    return true;
  }

  return false;
}

/**
 * 过滤掉角色 DNA 标签中的特定临时/场景状态标签，只保留固有的、物理的设定标签
 */
export function cleanCharacterDnaTags(tagsStringOrArray) {
  let tokens = [];
  if (Array.isArray(tagsStringOrArray)) {
    tokens = tagsStringOrArray;
  } else if (typeof tagsStringOrArray === 'string') {
    tokens = tagsStringOrArray.split(/[,，]/);
  } else {
    return "";
  }
  
  const cleaned = tokens
    .map(t => t.trim())
    .filter(t => t.length > 0 && !isTransientTag(t));
    
  return removeNonEnglishPromptTokens(deduplicatePromptTokens(cleaned).join(", "));
}

/**
 * 保持发送给 LLM 的文本原样，不做敏感词替换或语义改写。
 */
export function preserveTextForLlm(text) {
  if (text === null || text === undefined) return "";
  return String(text);
}

/**
 * 检测英文自然语言文本中的单词粘连（缺少空格）。
 * 仅适用于 V4.5 自然语言模式，不适用于 tag 模式。
 *
 * 策略：
 * 1. 匹配连续字母 ≥ 15 字符的长串（大概率是多个单词粘连），不区分大小写
 * 2. 在标点、下划线、数字处断开，避免误切正常分隔的词
 * 3. 排除 ::权重:: 包裹的内容
 *
 * @param {string} text - 待检测文本
 * @returns {Array<{original: string, start: number, end: number}>} 粘连片段列表
 */
export function detectConcatenatedWords(text) {
  if (typeof text !== 'string') return [];
  const results = [];
  // 先移除 ::weight:: 结构，避免误判
  const sanitized = text.replace(/::[\d.]+::/g, '').replace(/::[^:]+::/g, '');
  // 在非字母边界处断开，匹配 ≥15 字符的纯字母串（不区分大小写）
  const re = /(?<![a-zA-Z])[a-zA-Z]{15,}(?![a-zA-Z])/g;
  let m;
  while ((m = re.exec(sanitized)) !== null) {
    const original = m[0];
    const idx = text.indexOf(original);
    if (idx >= 0) {
      results.push({ original, start: idx, end: idx + original.length });
    }
  }
  return results;
}

/**
 * 在原始小说文本中查找 trigger_sentence，优先返回完全一致的原文。
 */
export function findOriginalTriggerSentence(originalText, trigger) {
  if (!trigger) return "";
  if (originalText.includes(trigger)) return trigger;

  const normalizedTrigger = String(trigger).trim();
  if (!normalizedTrigger) return trigger;

  const lines = originalText.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes(normalizedTrigger)) {
      return line.trim();
    }
  }
  return trigger;
}
