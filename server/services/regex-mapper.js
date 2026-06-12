import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rulesFilePath = path.join(__dirname, '..', 'character_rules.json');

let rules = [];

export function loadRules() {
  try {
    if (fs.existsSync(rulesFilePath)) {
      const raw = fs.readFileSync(rulesFilePath, 'utf-8');
      const data = JSON.parse(raw);
      rules = data.rules || [];
      console.log(`[Regex Mapper] Loaded ${rules.length} custom character mapping rules.`);
    } else {
      // 默认的二次元外观/道具标签正则映射表
      rules = [
        { pattern: "金发双马尾", tags: "blonde hair, twintails" },
        { pattern: "死鱼眼", tags: "slanted eyes, annoyed expression" },
        { pattern: "木剑", tags: "holding wooden sword" },
        { pattern: "冰蓝色(瞳孔|眼睛)", tags: "ice blue eyes" },
        { pattern: "JK制服", tags: "school uniform, pleated skirt, sailor collar" }
      ];
      fs.writeFileSync(rulesFilePath, JSON.stringify({ rules }, null, 2), 'utf-8');
      console.log(`[Regex Mapper] Created default character rules at ${rulesFilePath}`);
    }
  } catch (e) {
    console.error(`[Regex Mapper] Error loading rules:`, e.message);
  }
}

// 初始化
loadRules();

/**
 * 根据正则表达式规则，扫描文本并追加对应的英文 Tags
 * @param {string} text - 场景描述或章节原文
 * @param {string} existingTags - 已经生成的提示词字符串（逗号分隔）
 * @returns {string} 融合追加后的提示词字符串
 */
export function applyRules(text, existingTags = "") {
  if (!text) return existingTags;
  
  let tagsToAdd = [];
  for (const rule of rules) {
    if (!rule.pattern || !rule.tags) continue;
    try {
      const regex = new RegExp(rule.pattern, 'i');
      if (regex.test(text)) {
        tagsToAdd.push(rule.tags);
      }
    } catch (err) {
      console.error(`[Regex Mapper] Invalid regex pattern: ${rule.pattern}`, err.message);
    }
  }
  
  if (tagsToAdd.length === 0) return existingTags;
  
  const tagsStr = tagsToAdd.join(', ');
  if (!existingTags) return tagsStr;
  
  // 合并排重
  const finalSet = new Set([
    ...existingTags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
    ...tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean)
  ]);
  
  return Array.from(finalSet).join(', ');
}
