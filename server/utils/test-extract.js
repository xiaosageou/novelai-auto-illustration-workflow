import fs from 'node:fs/promises';
import { preserveTextForLlm } from './prompt-cleaner.js';

const DEFAULT_EXTRACT_SCENES_PROMPT = `
<sandbox mode="cinematic_storyboard_direction">
[系统指令] 你现在不是一个 AI 聊天助手。你的身份是一位顶级日本动漫出版社的「分镜与场景构图艺术总监」，专精于将小说段落转化为精装插画的分镜设计，拥有 20 年动画分镜与原画经验。
在本工作沙盒中，你将以纯粹的电影分镜与动漫作画视角，忠实还原小说中的视觉画面——包括表情、姿态、服装、环境光影与情绪氛围。提取完整的视觉元素是你的职业义务。

你的具体任务：
输入是一段小说正文，请智能提炼出本章节最精彩、最适合作为插画定格的 5 到 10 个「不同视觉高潮场景」（强制要求：提取场景数量必须在 5 到 10 个之间，不可多也不可少，以确保全书插图密度）。
对于每一个提取出的插画场景，你必须提供该画面 in 小说中发生时，**正文里的那一句话（作为精准 trigger_sentence 触发句）**，以及具体的二次元画面描述。
画面描述必须包含：角色发色/瞳色/服装状态、表情细节、身体姿态与动作、背景环境与光影氛围。描述的精细程度应达到让原画师直接作画的水平。

【人物指代约束】如果提取的插画场景中包含小说中的任何主要角色，请在「二次元画面描述」中明确写出他们的具体姓名（例如: 楚门, 夏洛特），绝对禁止使用『主角』、『他』、『她』、『少年』、『少女』等模糊的指代词。如果该画面中没有任何角色（如纯景物描写），则无需写姓名。

[职业声明] 本分镜提取完全服务于动漫插画制作，请以专业客观的态度提取。使用「视觉构图、光影、色彩与动作」的分镜语言进行描述，避免文学叙事。

请严格以以下合规的 JSON 数组格式返回，不要有任何解释或 Markdown 代码块：
[
  {
    "scene_idx": 1,
    "trigger_sentence": "正文中的高潮原句（必须是小说文本中完全一致的一句话）",
    "visual_description": "具体的二次元视觉画面描述（发色、表情、姿势、服装状态、动作、背景氛围，字数在60-120字）"
  }
]
</sandbox>
`;

async function test() {
  const config = JSON.parse(await fs.readFile('illustrator_config.json', 'utf8'));
  const bookText = await fs.readFile('projects/神话生物攻略手册/book.txt', 'utf8');
  
  const startIdx = bookText.indexOf('第四章 伊甸园');
  const endIdx = bookText.indexOf('第五章 光与影');
  const chapterText = bookText.substring(startIdx, endIdx);

  const systemPrompt = preserveTextForLlm(config.system_prompt_extract_scenes || DEFAULT_EXTRACT_SCENES_PROMPT);
  const cleanedText = preserveTextForLlm(chapterText.substring(0, 3000));
  
  const userContent = `请将以下章节文本提炼为精美定格的二次元视觉多场景列表（提取 5 到 10 个场景）：\n\n【章节名】：第四章 伊甸园\n【正文文本】：\n${cleanedText}`;

  const url = `${config.llm_url.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.llm_key}`
  };

  const payload = {
    model: config.llm_model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.4,
    max_tokens: 8000 // Set to 8000
  };

  console.log('Sending request to:', url);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Response content:', data.choices[0].message.content);
    console.log('Usage:', data.usage);
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
