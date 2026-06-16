/**
 * 健壮的 JSON 截断修复与解析工具箱
 */

/**
 * 智能检测 AI 返回的文本内容是否完整。
 * 返回: { isComplete: boolean, reason: string }
 */
export function checkTextCompleteness(text) {
  let trimmed = (text || "").trim();
  if (!trimmed) {
    return { isComplete: false, reason: "内容为空" };
  }

  // 过滤/剥离可能存在于前方的 <think>...</think> 或 <thinking>...</thinking> 标签内容，防止干扰闭合检测
  trimmed = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  trimmed = trimmed.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

  // 1. 检测高数题垫底标签是否完全闭合
  let hasMathPrefix = false;
  const mathTags = ["<further_mathematics>", "<further_math", "<math>", "further_mathematics"];
  for (const mathTag of mathTags) {
    if (trimmed.includes(mathTag)) {
      hasMathPrefix = true;
      break;
    }
  }

  if (hasMathPrefix) {
    if (!trimmed.includes("</further_mathematics>")) {
      return { isComplete: false, reason: "大模型尾部的高等数学题被斩断（说明已达到 Token 额度封顶触发截断）" };
    }
  }

  // 2. 检测核心 JSON 数据是否原生完全闭合
  let cleanedText = trimmed;
  for (const mathTag of mathTags) {
    const mathIdx = cleanedText.indexOf(mathTag);
    if (mathIdx !== -1) {
      cleanedText = cleanedText.substring(0, mathIdx).trim();
      if (cleanedText.endsWith("```")) {
        cleanedText = cleanedText.slice(0, -3).trim();
      }
      break;
    }
  }

  try {
    JSON.parse(cleanedText);
    return { isComplete: true, reason: "内容完全完整" };
  } catch (error) {
    // 检查是否是 Markdown 代码块包裹
    if (cleanedText.includes("```")) {
      try {
        const parts = cleanedText.split("```");
        for (const part of parts) {
          let partCleaned = part.trim();
          if (partCleaned.startsWith("json")) {
            partCleaned = partCleaned.substring(4).trim();
          }
          if ((partCleaned.startsWith("[") && partCleaned.endsWith("]")) || (partCleaned.startsWith("{") && partCleaned.endsWith("}"))) {
            JSON.parse(partCleaned);
            return { isComplete: true, reason: "内容完全完整" };
          }
        }
      } catch {}
    }
    return { isComplete: false, reason: "核心 JSON 数据本身未正常闭合，大模型在生成 JSON 内部时已发生截断" };
  }
}

/**
 * 自动修复被截断的 JSON 数组字符串，自动剥离尾部未完成的键值对，并补齐闭合的括号。
 */
export function fixTruncatedJson(text) {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("[")) {
    return trimmed;
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}

  // 方法1：尝试追加不同闭合后缀进行自愈
  const trySuffixes = [
    "\n]",
    "\n}]",
    "\"\n}]",
    " \n}]",
    "\"}",
    "\"}]",
    ", \"\"}]",
    "]"
  ];
  for (const suffix of trySuffixes) {
    try {
      const candidate = trimmed + suffix;
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  // 方法2：截取到最后一个完整的对象结束位置 "}" 并补齐数组闭合
  const lastBrace = trimmed.lastIndexOf("}");
  if (lastBrace !== -1) {
    let fixed = trimmed.substring(0, lastBrace + 1).trim();
    if (fixed.endsWith(",")) {
      fixed = fixed.slice(0, -1).trim();
    }
    fixed += "\n]";
    try {
      JSON.parse(fixed);
      return fixed;
    } catch {}
  }

  return trimmed;
}

/**
 * 自动修复被截断的 JSON 对象字符串，自动剥离尾部未完成的键值对，并补齐闭合的括号。
 */
export function fixTruncatedJsonObject(text) {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}

  // 尝试追加不同的闭合后缀
  const trySuffixes = [
    "\"}",
    "}",
    "\", \"prompt\": \"\"}",
    "\", \"negative_prompt\": \"\"}"
  ];
  for (const suffix of trySuffixes) {
    try {
      const candidate = trimmed + suffix;
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  // 计数双引号数量，如果是奇数，先补一个双引号
  const quoteCount = (trimmed.match(/"/g) || []).length;
  let fixed = trimmed;
  if (quoteCount % 2 !== 0) {
    fixed += "\"";
  }
  fixed += "}";

  try {
    JSON.parse(fixed);
    return fixed;
  } catch {}

  // 截取到最后一个完整的逗号位置
  const lastComma = trimmed.lastIndexOf(",");
  if (lastComma !== -1) {
    let candidate = trimmed.substring(0, lastComma).trim() + "}";
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  return trimmed;
}

/**
 * 极强健壮性的 JSON 解析器，能自动兼容 Markdown 代码块、首尾多余叙述文字，
 * 自愈被截断的 JSON，并精准提取 JSON 数组或对象。
 */
export function robustJsonLoads(text) {
  let cleaned = (text || "").trim();

  // 物理剥离抗截断高数题垫底标签及其后的所有内容，还原纯净的 JSON 待解析区
  const mathTags = ["<further_mathematics>", "<further_math", "<math>", "further_mathematics"];
  for (const mathTag of mathTags) {
    const mathIdx = cleaned.indexOf(mathTag);
    if (mathIdx !== -1) {
      cleaned = cleaned.substring(0, mathIdx).trim();
      // 针对剥离后可能残存 of ``` Markdown 闭合标记进行二次修剪
      if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3).trim();
      }
      break;
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  // 尝试进行数组截断的自愈修复
  if (cleaned.startsWith("[") && !cleaned.endsWith("]")) {
    cleaned = fixTruncatedJson(cleaned);
  }
  // 尝试进行对象截断的自愈修复
  if (cleaned.startsWith("{") && !cleaned.endsWith("}")) {
    cleaned = fixTruncatedJsonObject(cleaned);
  }

  // 再次尝试直接解析
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 处理带有 ```json 的 Markdown 代码块
  if (cleaned.includes("```")) {
    try {
      const parts = cleaned.split("```");
      for (const part of parts) {
        let block = part.trim();
        if (block.startsWith("json")) {
          block = block.substring(4).trim();
        }
        // 尝试对 Markdown 块内被截断的内容也进行自愈
        if (block.startsWith("[") && !block.endsWith("]")) {
          block = fixTruncatedJson(block);
        }
        if ((block.startsWith("[") && block.endsWith("]")) || (block.startsWith("{") && block.endsWith("}"))) {
          try {
            return JSON.parse(block);
          } catch {}
        }
      }
    } catch {}
  }

  // 利用正则提取最外层的 [...] 数组
  const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[1].trim());
    } catch {}
  }

  // 容错：如果正则由于缺少结尾括号没匹配到最外层数组，但以 [ 开头，进行截断后再次提取
  if (cleaned.startsWith("[")) {
    try {
      const fixed = fixTruncatedJson(cleaned);
      return JSON.parse(fixed);
    } catch {}
  }

  // 尝试提取最外层的 {...} 对象
  const objMatch = cleaned.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[1].trim());
    } catch {}
  }

  throw new Error(`无法从输入文本中解析出有效的 JSON 数据。`);
}
