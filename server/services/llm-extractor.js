import { robustJsonLoads, checkTextCompleteness } from '../utils/json-repair.js';
import { conservativeCompletionNaiWeights, cleanCharacterDnaTags, isTransientTag, preserveTextForLlm } from '../utils/prompt-cleaner.js';
import { normalizeSceneCard, buildSceneDescription, getSceneCharacters } from '../utils/scene-structure.js';
import { XIAO_AI_SYSTEM_PREFIX, DEFAULT_EXTRACT_SCENES_PROMPT, DEFAULT_CHARACTER_DNA_PROMPT, DEFAULT_ADVANCED_PROMPT, DEFAULT_REGENERATE_SCENE_PROMPT } from '../utils/default-prompts.js';
import { searchTagsLocal, getRelatedTagsLocal } from './local-tag-searcher.js';
import { searchTagsMcp, getRelatedTagsMcp } from './danbooru-mcp-searcher.js';

export const SCENES_JSON_START = '<SCENES_JSON_START>';
export const SCENES_JSON_END = '<SCENES_JSON_END>';

export function withSystemPrefix(taskPrompt) {
  const prompt = preserveTextForLlm(taskPrompt)
    .replace(/\n*重要：[\s\S]*?<further_mathematics>[\s\S]*?<\/further_mathematics>/gi, '')
    .trim();
  if (prompt.startsWith(XIAO_AI_SYSTEM_PREFIX)) return prompt;
  return `${XIAO_AI_SYSTEM_PREFIX}

---

【当前流水线任务】
以下任务约束与机器可读输出格式优先于上方的日常对话、颜文字、称呼和结尾互动格式。只输出当前任务明确要求的 JSON 或标签，不要添加寒暄、称呼、颜文字、解释、求夸奖或反问。

${prompt}`;
}

export function ensureAdvancedPromptContract(taskPrompt) {
  const prompt = preserveTextForLlm(taskPrompt || DEFAULT_ADVANCED_PROMPT).trim();
  const hasCurrentSchema = /["']?base_prompt["']?/i.test(prompt)
    && /["']?character_prompts["']?/i.test(prompt)
    && /["']?negative_prompt["']?/i.test(prompt)
    && /["']?interaction_actions["']?/i.test(prompt);
  if (hasCurrentSchema) return withSystemPrefix(prompt);

  return withSystemPrefix(`${prompt}

---

## CURRENT OUTPUT CONTRACT (HIGHEST PRIORITY)
The output schema described below supersedes every earlier output example or instruction in this system message.
The legacy schema containing only "prompt" is obsolete and MUST NOT be used.

Return exactly one valid JSON object:
{
  "orientation": "portrait" | "landscape" | "square" | "default",
  "base_prompt": "global character count, environment, lighting, camera, atmosphere, interactions and global NSFW tags only",
  "interaction_requirements": [
    {
      "action": "one Danbooru action tag copied from the scene card",
      "source": "copy the source character name exactly",
      "target": "copy the target character name exactly",
      "requires_pairing": true
    }
  ],
  "character_prompts": [
    {
      "name": "copy the character name exactly from the scene card",
      "prompt": "tags for this character's appearance, hair, body, clothing, pose, expression and position only",
      "negative_prompt": "undesired tags for this character only, especially traits belonging to other characters",
      "interaction_actions": [
        {
          "role": "source | target | mutual",
          "action": "one Danbooru action tag without source#/target#/mutual# prefix"
        }
      ]
    }
  ],
  "negative_prompt": "scene-specific negative tags or an empty string"
}

Hard requirements:
- base_prompt must be a non-empty string.
- interaction_requirements must evaluate whether each scene-card interaction truly requires source/target pairing validation. Use false for self-directed, emotional, gaze-only, or otherwise non-paired actions.
- character_prompts must contain exactly one entry for every visible scene character, in the same order.
- Copy each character name exactly. Do not translate or shorten it.
- Put the total character count only in base_prompt.
- Do not put character-specific appearance, clothing, expression or individual pose in base_prompt.
- For every direct interaction, add an interaction_actions item: active character source, passive character target, or both mutual, using the same action tag.
- Use each character's negative_prompt to prevent appearance, clothing, gender or accessories from leaking from other characters.
- Do not write source#/target#/mutual# inside prompt; the application adds the official NovelAI prefix.
- Do not output a top-level "prompt" field.
- Output JSON only, without Markdown or commentary.`);
}

function flattenLlmText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenLlmText).join('');
  if (!value || typeof value !== 'object') return '';

  for (const key of ['text', 'output_text', 'content', 'value']) {
    const text = flattenLlmText(value[key]);
    if (text.trim()) return text;
  }
  return '';
}

export function extractLlmResponseText(responseData) {
  if (typeof responseData === 'string') {
    const raw = responseData.trim();
    if (!raw) return '';

    if (/^data:/m.test(raw)) {
      return raw
        .split(/\r?\n/)
        .filter(line => line.trim().startsWith('data:'))
        .map(line => line.replace(/^\s*data:\s*/, '').trim())
        .filter(payload => payload && payload !== '[DONE]')
        .map(payload => {
          try {
            return extractLlmResponseText(JSON.parse(payload));
          } catch {
            return payload;
          }
        })
        .join('')
        .trim();
    }

    try {
      return extractLlmResponseText(JSON.parse(raw));
    } catch {
      return raw;
    }
  }

  if (!responseData || typeof responseData !== 'object') return '';
  const choice = responseData.choices?.[0];
  const candidates = [
    choice?.message?.content,
    choice?.delta?.content,
    choice?.text,
    responseData.output_text,
    responseData.text,
    responseData.response,
    responseData.content,
    responseData.output
  ];

  for (const candidate of candidates) {
    const text = flattenLlmText(candidate);
    if (text.trim()) return text.trim();
  }

  // Some OpenAI-compatible gateways place the final answer here when emulating streaming.
  const reasoningContent = flattenLlmText(
    choice?.message?.reasoning_content ?? choice?.delta?.reasoning_content
  ).trim();
  return reasoningContent.includes('{') ? reasoningContent : '';
}

async function readLlmResponse(res) {
  if (typeof res.text === 'function') {
    const rawBody = await res.text();
    let responseData = rawBody;
    try {
      responseData = JSON.parse(rawBody);
    } catch {
      // SSE and plain-text compatibility responses are handled by extractLlmResponseText.
    }
    return {
      responseData,
      content: extractLlmResponseText(responseData)
    };
  }

  const responseData = await res.json();
  return {
    responseData,
    content: extractLlmResponseText(responseData)
  };
}

function summarizeLlmResponseShape(responseData) {
  if (!responseData || typeof responseData !== 'object') {
    return `bodyType=${typeof responseData}`;
  }
  const choice = responseData.choices?.[0];
  return JSON.stringify({
    keys: Object.keys(responseData),
    choiceKeys: choice && typeof choice === 'object' ? Object.keys(choice) : [],
    messageKeys: choice?.message && typeof choice.message === 'object'
      ? Object.keys(choice.message)
      : [],
    finishReason: choice?.finish_reason ?? null
  });
}

function ensureStructuredScenePrompt(prompt) {
  const text = preserveTextForLlm(prompt || DEFAULT_EXTRACT_SCENES_PROMPT);
  const coverageInstruction = `【全章覆盖与碎段上下文合并约束】
- 输入是完整章节正文，不是单个段落。必须通读整章后再选择场景，禁止只从开头或局部连续段落中提取。
- 对分段很碎的小说，要把相邻短段落合并理解为同一个连续事件；角色服装、地点、姿态、情绪、光源可能分散在前后段落中，必须综合上下文补全到 environment / cinematography / characters / interactions。
- 先在心中划分本章的事件阶段（开端、推进、转折、高潮、收束），最终场景应尽量覆盖不同事件阶段、不同地点或不同互动关系。
- 如果章节包含多个明显地点、时间变化、战斗/对话/仪式/亲密互动等视觉阶段，优先让每个重要视觉阶段至少有一个代表性场景。
- 不要提取重复镜头：同一地点、同一角色姿态、同一互动关系只保留视觉冲击最强的一帧。
- trigger_sentence 必须仍然来自原文连续短片段；若视觉信息来自相邻段落，trigger_sentence 选该事件中最能定位画面的原文句。`;

  const withCoverage = text.includes("【全章覆盖与碎段上下文合并约束】")
    ? text
    : text.replace("【trigger_sentence 约束", `${coverageInstruction}\n\n---\n\n【trigger_sentence 约束`);
  const diversityInstruction = `【场景多样性硬约束】
- 同一地点、同一连续事件阶段最多选择 2 个场景。即使该段描写很长，也不得连续提取 3 个以上相似镜头。
- 若同一寝宫、战斗、对话或亲密事件已有 2 个镜头，剩余名额必须从本章其他地点、其他事件阶段或其他角色关系中选择。
- 输出前按“地点 + 时间 + 主要互动”分组检查；任一组超过 2 个时，替换重复场景，而不是简单删除。`;
  const withDiversity = withCoverage.includes("【场景多样性硬约束】")
    ? withCoverage
    : `${withCoverage}\n\n${diversityInstruction}`;

  const requiredFields = [
    '"environment"',
    '"cinematography"',
    '"characters"',
    '"interactions"',
    '"visual_entities"',
    '"must_show"',
    '"must_not_show"'
  ];
  const withBoundaryContract = (content) => withSystemPrefix(`${content}

【分镜输出起止符协议（最高优先级）】
- 完整输出必须以 ${SCENES_JSON_START} 独占一行开始。
- 紧接着输出 JSON 数组本体。
- 完整输出必须以 ${SCENES_JSON_END} 独占一行结束。
- 起止符外禁止输出任何文字、解释、Markdown 或代码围栏。
- 即使 JSON 本体语法完整，缺少结束符 ${SCENES_JSON_END} 也会被系统判定为输出截断并重试。

严格格式：
${SCENES_JSON_START}
[
  { "scene_idx": 1 }
]
${SCENES_JSON_END}`);

  if (requiredFields.every(field => withDiversity.includes(field))) {
    return withBoundaryContract(withDiversity);
  }

  return withBoundaryContract(`${withDiversity}

【重要补充：必须输出新版结构化分镜字段】
即使上文示例较旧，你最终返回的每个场景对象也必须补全以下字段，禁止省略：
{
  "scene_idx": 1,
  "trigger_sentence": "逐字复制正文中的连续原文短片段，8-30字，能Ctrl+F精准命中",
  "nsfw_rating": "sfw | nsfw_mild | nsfw_moderate | nsfw_explicit 四选一",
  "visual_description": "兼容旧流水线的一句话总览，综合下列结构化字段，字数在60-120字",
  "character_names": ["本场景实际可见或直接参与互动的角色中文名；纯景物则为空数组"],
  "environment": "时间、天气、室内外、空间、背景物件、光源分布；没有则为空字符串",
  "cinematography": "镜头距离、机位、构图、景深、粒子效果、画面氛围；没有则为空字符串",
  "characters": [
    {
      "name": "角色中文名；没有角色则省略此数组项",
      "gender": "girl|boy|woman|man|creature|unknown",
      "appearance": "发色、瞳色、发型、体貌等固有外貌",
      "clothing": "当前服装与配饰，含破损/凌乱等剧情状态",
      "expression": "当前表情与情绪细节",
      "pose": "一帧画面能呈现的整体姿态或动作",
      "position": "left|right|center|foreground|background 或中文方位"
    }
  ],
  "interactions": "谁对谁做什么，视线/接触/动作关系；没有则为空字符串",
  "interaction_actions": [
    {
      "action": "英文 Danbooru 动作标签，如 hug / kiss / pointing / holding_hands",
      "source": "动作供体角色名",
      "target": "动作受体角色名",
      "mutual": false
    }
  ],
  "plot_traces": "需要体现的剧情痕迹英文 Danbooru tags；没有则为空字符串",
  "text_elements": "画面中需要出现的文字；没有则为空字符串",
  "visual_entities": [],
  "must_show": [],
  "must_not_show": []
}
只输出 JSON 数组本体，不要 Markdown。`);
}

export function extractBoundedScenesJson(rawContent = '') {
  const text = String(rawContent || '').trim();
  if (!text.startsWith(SCENES_JSON_START)) {
    throw new Error(`缺少场景输出起始符 ${SCENES_JSON_START}`);
  }
  if (!text.endsWith(SCENES_JSON_END)) {
    throw new Error(`缺少场景输出终止符 ${SCENES_JSON_END}，判定输出截断`);
  }

  const jsonText = text
    .slice(SCENES_JSON_START.length, text.length - SCENES_JSON_END.length)
    .trim();
  if (!jsonText) {
    throw new Error('场景输出起止符之间没有 JSON 内容');
  }
  return jsonText;
}

function uniqueTags(tags = []) {
  const seen = new Set();
  return tags.map(tag => String(tag || '').trim()).filter(tag => {
    if (!tag) return false;
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SELF_DIRECTED_INTERACTION_ACTIONS = new Set([
  'undressing',
  'buttoning',
  'buttoning_clothes'
]);

export function mapVisualTextToTags(text = '') {
  const source = String(text || '');
  const rules = [
    [/室内|寝宫|宫殿内|indoors/i, 'indoors'],
    [/室外|林间|山间|雪地|outdoors/i, 'outdoors'],
    [/树林|森林|林间|forest/i, 'forest'],
    [/宫殿|大殿|寒玉殿|palace/i, 'palace'],
    [/石室|暗室|墓室|stone chamber/i, 'stone_chamber'],
    [/屏风|folding screen/i, 'folding_screen'],
    [/门缝|door crack/i, 'view_through_door_crack'],
    [/烛火|灯火|铜灯|candle|lamp/i, 'warm_lighting'],
    [/昏暗|幽暗|微弱|dim/i, 'dim_lighting'],
    [/雪|snow/i, 'snow'],
    [/初雪|落雪|飘雪|falling snow/i, 'falling_snow'],
    [/夜|night/i, 'night'],
    [/阳光|sunlight/i, 'sunlight'],
    [/壁画|mural/i, 'mural'],
    [/锈剑|生锈的剑|rusty sword/i, 'rusty_sword'],
    [/中景|medium shot/i, 'medium_shot'],
    [/近景|特写|close-up/i, 'close_up'],
    [/全景|远景|wide shot/i, 'wide_shot'],
    [/侧拍|侧面|side view/i, 'side_view'],
    [/俯拍|俯视|from above/i, 'from_above'],
    [/仰拍|低角度|from below|low angle/i, 'from_below'],
    [/景深|背景虚化|depth of field/i, 'depth_of_field'],
    [/逆光|backlight/i, 'backlighting'],
    [/剑气|sword aura/i, 'sword_aura'],
    [/门槛|threshold/i, 'threshold'],
    [/对峙|confrontation/i, 'confrontation'],
    [/窥视|偷窥|voyeur/i, 'voyeurism'],
    [/屏风.*人影|人影.*屏风|shadow play/i, 'shadow_play'],
    [/剑尖.*喉|喉.*剑尖|sword.*throat/i, 'sword_tip_touching_throat'],
    [/抵住.*喉|顶在.*喉|pressed.*neck/i, 'blade_pressed_against_neck'],
    [/扣.*扣子|扣上衣扣|buttoning/i, 'buttoning_clothes'],
    [/牵.*袖|拉.*袖|holding.*sleeve/i, 'holding_another_sleeve'],
    [/接住.*雪|手掌.*雪|catching.*snow/i, 'catching_snowflake'],
    [/从背后|身后|from behind/i, 'from_behind'],
    [/抓.*臀|扶.*臀|grabbing.*hips/i, 'grabbing_hips'],
    [/拔出|pulling out/i, 'pulling_out'],
    [/精液.*流|精液.*溢|semen.*drip/i, 'semen_dripping'],
    [/大腿.*湿|腿间.*湿|股间.*湿|大腿间.*淫水|大腿间.*爱液|股间.*淫水|股间.*爱液|顺着.*腿.*流下|沿着.*腿.*流下/i, 'wet_thighs'],
    [/掌印|手印|handprints/i, 'hand_prints'],
    [/交合|性交|插入|penetration/i, 'penetration']
  ];
  return uniqueTags(rules.filter(([pattern]) => pattern.test(source)).map(([, tag]) => tag));
}

function mapCharacterTextToTags(char = {}) {
  const source = [
    char.appearance,
    char.clothing,
    char.expression,
    char.pose,
    char.position
  ].join(' ');
  const tags = [];
  const gender = String(char.gender || '').toLowerCase();
  if (/girl|woman|female|少女|女人|女性/.test(gender)) tags.push('1girl');
  else if (/boy|man|male|少年|男人|男性/.test(gender)) tags.push('1boy');
  tags.push(...mapVisualTextToTags(source));

  const rules = [
    [/黑发|black hair/i, 'black_hair'],
    [/白发|银发|silver hair|white hair/i, 'silver_hair'],
    [/长发|long hair/i, 'long_hair'],
    [/短发|short hair/i, 'short_hair'],
    [/披肩|披发|散发|散乱/i, 'hair_down'],
    [/盘发|发髻|hair bun/i, 'hair_bun'],
    [/白衣|白色.*衣|white robe/i, 'white_robe'],
    [/黑衣|黑色.*衣|black robe/i, 'black_robe'],
    [/全裸|赤裸|裸体|completely nude/i, 'completely_nude'],
    [/半敞|衣襟大开|敞开/i, 'open_clothes'],
    [/小腹|腹部|stomach/i, 'exposed_stomach'],
    [/胸部|乳房|breast/i, 'breasts'],
    [/坐|sitting/i, 'sitting'],
    [/站|standing/i, 'standing'],
    [/跪|kneeling/i, 'kneeling'],
    [/趴|俯卧|prone/i, 'on_stomach'],
    [/侧卧|侧躺|lying on side/i, 'lying_on_side'],
    [/后仰|leaning back/i, 'leaning_back'],
    [/抬起下巴|仰起下巴|chin raised/i, 'chin_raised'],
    [/持剑|握剑|holding sword/i, 'holding_sword'],
    [/平刺|剑指|pointing sword/i, 'pointing_sword_at_another'],
    [/双手背|hands behind back/i, 'hands_behind_back'],
    [/扣.*扣子|扣上衣扣/i, 'buttoning_clothes'],
    [/牵.*袖|拉.*袖/i, 'holding_another_sleeve'],
    [/抓.*臀|扶.*臀/i, 'grabbing_another_hips'],
    [/从背后|身后/i, 'from_behind'],
    [/拔出/i, 'pulling_out'],
    [/伸手|摊开手掌|open palm/i, 'open_palm'],
    [/左|left/i, 'left_side'],
    [/右|right/i, 'right_side'],
    [/前景|foreground/i, 'foreground'],
    [/背景|background/i, 'background']
  ];
  tags.push(...rules.filter(([pattern]) => pattern.test(source)).map(([, tag]) => tag));
  if (!/龇牙|露齿|咬牙|狂笑|大笑|狞笑|张嘴/i.test(char.expression || '')) {
    tags.push('closed_mouth', 'natural_expression');
  }
  return uniqueTags(tags);
}

function buildCountTags(sceneCharacters = []) {
  let girls = 0;
  let boys = 0;
  for (const char of sceneCharacters) {
    const gender = String(char?.gender || '').toLowerCase();
    if (/girl|woman|female|少女|女人|女性/.test(gender)) girls++;
    else if (/boy|man|male|少年|男人|男性/.test(gender)) boys++;
  }
  return [
    girls ? `${girls}girl${girls > 1 ? 's' : ''}` : '',
    boys ? `${boys}boy${boys > 1 ? 's' : ''}` : '',
    sceneCharacters.length === 2 ? 'exactly_two_characters' : '',
    sceneCharacters.length === 3 ? 'exactly_three_characters' : ''
  ].filter(Boolean);
}

export function countChapterCharacters(text = '') {
  return String(text || '').replace(/\s/g, '').length;
}

export function countEnglishWords(text = '') {
  return String(text || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length || 0;
}

export function getSceneCountMetrics(text = '') {
  const source = String(text || '');
  const englishWordCount = countEnglishWords(source);
  const latinLetterCount = source.match(/[A-Za-z]/g)?.length || 0;
  const cjkCharacterCount = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0;
  const isEnglish = englishWordCount > 0 && latinLetterCount > cjkCharacterCount;

  if (isEnglish) {
    return {
      language: 'english',
      unit: 'words',
      count: englishWordCount,
      divisor: 350,
      sceneCount: Math.max(1, Math.ceil(englishWordCount / 350))
    };
  }

  const characterCount = countChapterCharacters(source);
  return {
    language: 'cjk',
    unit: 'characters',
    count: characterCount,
    divisor: 600,
    sceneCount: Math.max(1, Math.ceil(characterCount / 600))
  };
}

export function calculateSceneCount(text = '') {
  return getSceneCountMetrics(text).sceneCount;
}

function compileScenePromptDeterministically(sceneInput = {}) {
  const sceneCharacters = getSceneCharacters(sceneInput);
  const sceneText = [
    sceneInput.visual_description,
    sceneInput.environment,
    sceneInput.cinematography,
    sceneInput.interactions,
    ...(Array.isArray(sceneInput.must_show) ? sceneInput.must_show : [])
  ].filter(Boolean).join(' ');
  const entityTags = (Array.isArray(sceneInput.visual_entities) ? sceneInput.visual_entities : []).flatMap(entity => {
    const tags = mapVisualTextToTags(entity?.description || '');
    if (entity?.type === 'shadow_silhouette') {
      tags.push(entity.count >= 2 ? 'two_human_silhouettes' : 'human_silhouette', 'silhouette_behind_screen');
    }
    if (entity?.type === 'framing_object') tags.push('dark_foreground_framing');
    return tags;
  });
  const plotTags = String(sceneInput.plot_traces || '').split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
  const baseTags = uniqueTags([
    ...buildCountTags(sceneCharacters),
    ...mapVisualTextToTags(sceneText),
    ...entityTags,
    ...plotTags
  ]);
  const characterPrompts = sceneCharacters.map(char => ({
    name: char.name || '',
    prompt: mapCharacterTextToTags(char).join(', ')
  }));
  const negativeTags = uniqueTags([
    ...(Array.isArray(sceneInput.must_not_show) ? sceneInput.must_not_show : []),
    sceneCharacters.length >= 2 ? 'extra person' : '',
    sceneCharacters.length >= 2 ? 'duplicate character' : '',
    !sceneInput.text_elements ? 'readable text' : ''
  ]);
  const cameraText = String(sceneInput.cinematography || '');
  const orientation = sceneCharacters.length >= 2 || /全景|远景|wide|landscape/i.test(cameraText)
    ? 'landscape'
    : (/特写|近景|close-up/i.test(cameraText) ? 'portrait' : 'square');
  return {
    orientation,
    base_prompt: baseTags.join(', ') || 'cinematic composition, detailed environment',
    character_prompts: characterPrompts,
    prompt: [...baseTags, ...characterPrompts.flatMap(item => item.prompt.split(/[,，]/))].join(', '),
    negative_prompt: negativeTags.join(', ')
  };
}

export class LLMExtractor {
  constructor({ baseUrl = "https://api.openai.com/v1", apiKey = "", system_prompt_extract_scenes = "", system_prompt_character_dna = "", system_prompt_advanced_prompt = "", system_prompt_regenerate_scene = "", danbooru_mcp_url = "" } = {}) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.apiKey = apiKey.trim();
    this.system_prompt_extract_scenes = system_prompt_extract_scenes;
    this.system_prompt_character_dna = system_prompt_character_dna;
    this.system_prompt_advanced_prompt = system_prompt_advanced_prompt;
    this.system_prompt_regenerate_scene = system_prompt_regenerate_scene;
    this.danbooru_mcp_url = danbooru_mcp_url;
  }

  updateConfig(baseUrl, apiKey, system_prompt_extract_scenes, system_prompt_character_dna, system_prompt_advanced_prompt, system_prompt_regenerate_scene, danbooru_mcp_url) {
    this.baseUrl = (baseUrl || "").trim().replace(/\/+$/, "");
    this.apiKey = (apiKey || "").trim();
    if (system_prompt_extract_scenes !== undefined) this.system_prompt_extract_scenes = system_prompt_extract_scenes;
    if (system_prompt_character_dna !== undefined) this.system_prompt_character_dna = system_prompt_character_dna;
    if (system_prompt_advanced_prompt !== undefined) this.system_prompt_advanced_prompt = system_prompt_advanced_prompt;
    if (system_prompt_regenerate_scene !== undefined) this.system_prompt_regenerate_scene = system_prompt_regenerate_scene;
    if (danbooru_mcp_url !== undefined) this.danbooru_mcp_url = danbooru_mcp_url;
  }

  getHeaders() {
    const headers = {
      "Content-Type": "application/json"
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * 获取所有可用的聊天模型列表
   */
  async getAvailableModels() {
    if (!this.apiKey) {
      throw new Error("请先填写有效的 LLM API Key！");
    }

    const url = `${this.baseUrl}/models`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000)
      });

      if (res.status === 200) {
        const data = await res.json();
        const modelsList = data.data || [];
        const modelIds = modelsList.map(m => m.id).filter(Boolean);
        
        // 过滤出常见的文本聊天模型
        const chatModels = modelIds.filter(id => {
          const lower = id.toLowerCase();
          return ["gpt", "claude", "deepseek", "qwen", "llama", "mistral", "yi", "intern", "glm"].some(keyword => lower.includes(keyword));
        });

        return chatModels.length > 0 ? chatModels.sort() : modelIds.sort();
      } else {
        throw new Error(`HTTP 状态码: ${res.status}`);
      }
    } catch (e) {
      console.error("[LLM Extractor] 拉取模型列表失败:", e);
      throw new Error(`获取模型列表异常: ${e.message}`);
    }
  }

  /**
   * 单章小说文本提炼：中文按有效字符数，英文按单词数动态计算分镜数量。
   */
  async extractChapterScenes(chapterTitle, text, model = "deepseek-chat", onProgressLog = null, requestedSceneCount = null) {
    if (!this.apiKey) {
      throw new Error("请先配置有效的 LLM API Key！");
    }

    const systemPrompt = ensureStructuredScenePrompt(this.system_prompt_extract_scenes || DEFAULT_EXTRACT_SCENES_PROMPT);

    const cleanedTitle = preserveTextForLlm(chapterTitle);
    const cleanedText = preserveTextForLlm(text);
    const sceneCount = Number.isInteger(requestedSceneCount) && requestedSceneCount > 0
      ? requestedSceneCount
      : calculateSceneCount(text);
    const countMetrics = getSceneCountMetrics(text);
    const countRule = countMetrics.language === 'english'
      ? 'ceil(英文总词数 / 350)'
      : 'ceil(章节有效字符数 / 600)';
    const countLabel = countMetrics.language === 'english'
      ? '本章英文总词数'
      : '本章有效字符数';
    const userContent = `请通读以下完整章节文本，提炼为精美定格的二次元视觉多场景列表。

【场景数量硬约束（最高优先级）】
- 本地已按 ${countRule} 完成计算。
- ${countLabel}：${countMetrics.count}
- 必须输出恰好 ${sceneCount} 个场景，不得多于或少于 ${sceneCount} 个。
- scene_idx 必须从 1 连续编号到 ${sceneCount}。
- 完整回复必须使用 ${SCENES_JSON_START} 和 ${SCENES_JSON_END} 包裹 JSON 数组。

请覆盖全章不同事件阶段，不要只提取开头段落：

【章节名】：${cleanedTitle}
【完整正文文本】：
${cleanedText}`;

    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      temperature: 0.4,
      max_tokens: Math.max(8000, sceneCount * 1200)
    };

    onProgressLog?.(`[LLM] 正在调用大模型提炼 ${sceneCount} 个场景...`);
    console.log(`[LLM Extractor] 正在提炼章节「${chapterTitle}」的 ${sceneCount} 个场景...`);

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        onProgressLog?.(`[LLM] 场景提炼第 ${attempt}/3 次请求...`);
        const res = await fetch(url, {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(180000) // 180s 超时
        });

        if (res.status !== 200) {
          throw new Error(`HTTP Error ${res.status}`);
        }

        const resData = await res.json();
        const rawContent = (resData.choices?.[0]?.message?.content || "").trim();
        if (!rawContent) {
          throw new Error(`大模型返回内容为空: ${JSON.stringify(resData)}`);
        }

        onProgressLog?.(`[LLM] 大模型分镜提炼回复原始结果:\n${rawContent}`);

        const boundedJson = extractBoundedScenesJson(rawContent);
        const completeness = checkTextCompleteness(boundedJson);
        if (!completeness.isComplete) {
          onProgressLog?.(`[LLM] 场景提炼结果不完整: ${completeness.reason}。尝试 JSON 自愈解析...`, "warning");
        }

        const parsed = robustJsonLoads(boundedJson).map(scene => normalizeSceneCard(scene));
        if (parsed.length !== sceneCount) {
          throw new Error(`场景数量不符：要求 ${sceneCount} 个，实际返回 ${parsed.length} 个`);
        }
        const hasInvalidIndex = parsed.some((scene, index) => Number(scene.scene_idx) !== index + 1);
        if (hasInvalidIndex) {
          throw new Error(`scene_idx 未按 1-${sceneCount} 连续编号`);
        }

        onProgressLog?.(`[LLM] 第 ${attempt}/3 次场景提炼成功，共 ${parsed.length} 个场景。\n${parsed.map(s => `• 场景 ${s.scene_idx} -> 触发句: 「${s.trigger_sentence}」\n  分镜画面描述: ${buildSceneDescription(s)}`).join("\n")}`);
        return parsed;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          onProgressLog?.(`[LLM] 第 ${attempt}/3 次场景提炼失败，优先重试: ${error.message}`, "warning");
          console.warn(`[LLM Extractor] 场景提炼第 ${attempt}/3 次失败: ${error.message}`);
        }
      }
    }

    onProgressLog?.(`[LLM] 连续 3 次场景提炼均失败，使用兜底策略: ${lastError?.message || "未知错误"}`, "warning");
    console.error(`[LLM Extractor] 场景提炼连续 3 次失败:`, lastError);
    const lines = text.split("\n").filter(l => l.trim().length > 10);
    const fallbackSentence = lines[Math.floor(lines.length / 2)] || "起风了。";
    return [normalizeSceneCard({
      scene_idx: 1,
      trigger_sentence: fallbackSentence.substring(0, 30),
      nsfw_rating: 'sfw',
      visual_description: "1girl, solo, anime style, looking at viewer",
      environment: "detailed background",
      cinematography: "balanced composition, anime illustration",
      characters: [{
        name: "",
        gender: "girl",
        appearance: "",
        clothing: "",
        expression: "looking at viewer",
        pose: "solo",
        position: "center"
      }],
      interactions: "",
      plot_traces: "",
      text_elements: ""
    })];
  }

  /**
   * 单个分镜场景描述重构：针对特定触发句重新生成结构化 JSON
   */
  async regenerateSingleSceneCard(chapterTitle, chapterContent, sceneIdx, triggerSentence, model = "deepseek-chat", focusParagraph = "") {
    if (!this.apiKey) {
      throw new Error("请先配置有效的 LLM API Key！");
    }

    const systemPrompt = withSystemPrefix(this.system_prompt_regenerate_scene || DEFAULT_REGENERATE_SCENE_PROMPT);

    const cleanedTitle = preserveTextForLlm(chapterTitle);
    const cleanedText = preserveTextForLlm(chapterContent);
    const userContent = [
      `请针对以下章节正文中指定的「触发高潮句」，重新提炼并生成一份极其直白的二次元插画画面分镜描述。`,
      `【章节名】: ${cleanedTitle}`,
      `【触发句 (trigger_sentence)】: 「${triggerSentence}」`,
      focusParagraph
        ? `【触发句所在完整段落（必须结合整段理解上下文）】:\n${preserveTextForLlm(focusParagraph)}`
        : '',
      `【场景序号】: ${sceneIdx}`,
      `【完整章节原文】:`,
      cleanedText
    ].filter(Boolean).join('\n');

    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      stream: false
    };

    console.log(`[LLM Extractor] 正在重构场景 #${sceneIdx} 的画面描述... 触发句: 「${triggerSentence}」`);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000)
      });

      if (res.status !== 200) {
        throw new Error(`HTTP Error ${res.status}`);
      }

      const resData = await res.json();
      const rawContent = (resData.choices?.[0]?.message?.content || "").trim();

      const completeness = checkTextCompleteness(rawContent);
      if (!completeness.isComplete) {
        console.warn(`[LLM Extractor] 场景重构 JSON 不完整，启动修复...`);
      }

      const parsed = robustJsonLoads(rawContent);
      const normalized = normalizeSceneCard(parsed);

      normalized.scene_idx = sceneIdx;
      normalized.trigger_sentence = triggerSentence;

      return normalized;
    } catch (error) {
      console.error(`[LLM Extractor] 单场景描述重构失败:`, error);
      throw error;
    }
  }

  /**
   * 从 10 章小说切片中提炼主要角色及其结构化外貌 DNA 标签（Prompts Bundle）
   */
  async extractCharacterDNA(sliceText, model = "deepseek-chat", context = {}) {
    if (!this.apiKey) {
      throw new Error("请先配置有效的 LLM API Key！");
    }

    const systemPrompt = withSystemPrefix(this.system_prompt_character_dna || DEFAULT_CHARACTER_DNA_PROMPT);

    const cleanedSliceText = preserveTextForLlm(sliceText);
    const knownCharacters = context?.knownCharacters && Object.keys(context.knownCharacters).length > 0
      ? JSON.stringify(Object.entries(context.knownCharacters).map(([name, data]) => ({
          name,
          aliases: data.aliases || [],
          gender: data.gender || "",
          tags: data.tags || "",
          features: data.features || {},
          height_class: data.height_class || "",
          body_proportion: data.body_proportion || ""
        })), null, 2)
      : "[]";
    const sourceChapters = Array.isArray(context?.sourceChapters) ? context.sourceChapters : [];
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            "分析以下完整小说切片正文，提炼或更新主要人物及他们的角色外貌 DNA 属性。",
            "请把【已知角色库】视为上一轮结果：同一角色请沿用既有 name，并把新称谓写入 aliases；不要因为称谓变化创建重复角色。",
            `【本切片章节】: ${sourceChapters.join(", ") || "未知"}`,
            "",
            "【已知角色库】",
            knownCharacters,
            "",
            "【小说切片正文】",
            cleanedSliceText
          ].join("\n")
        }
      ],
      temperature: 0.2,
      max_tokens: 8000
    };

    console.log(`[LLM Extractor] 正在提取全局角色 DNA (切片长度: ${sliceText.length} 字)...`);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180000)
      });

      if (res.status !== 200) {
        throw new Error(`HTTP Error ${res.status}`);
      }

      const resData = await res.json();
      const rawContent = resData.choices[0].message.content.trim();

      const completeness = checkTextCompleteness(rawContent);
      if (!completeness.isComplete) {
        console.warn(`[LLM Extractor] 角色 DNA 提炼结果不完整: ${completeness.reason}. 启动自愈修复...`);
      }

      const rawList = robustJsonLoads(rawContent);

      // 对大模型提取出的角色 DNA 进行后处理二次净化，滤除任何瞬时/场景状态标签
      return rawList.map(char => {
        if (!char || !char.name) return char;

        const cleanFeatures = {};
        if (char.features) {
          for (const [key, val] of Object.entries(char.features)) {
            if (Array.isArray(val)) {
              cleanFeatures[key] = val
                .map(t => t.trim())
                .filter(t => t.length > 0 && !isTransientTag(t));
            } else {
              cleanFeatures[key] = val;
            }
          }
        }

        // 重新拼装出最干净、最常驻的外貌特征拼接串
        const allFeatureTags = [];
        const orderedKeys = ["外貌标签", "身材标签", "胸部标签", "发型标签", "发色标签", "眼睛标签", "肤色标签", "年龄感标签", "服装基底标签", "特殊特征标签"];
        for (const key of orderedKeys) {
          if (Array.isArray(cleanFeatures[key])) {
            allFeatureTags.push(...cleanFeatures[key]);
          }
        }

        const tagsStr = cleanCharacterDnaTags(char.tags || "");
        const mergedTags = cleanCharacterDnaTags([...tagsStr.split(/[,，]/), ...allFeatureTags]);
        const evidence = Array.isArray(char.evidence)
          ? char.evidence.map(item => {
              if (typeof item === 'string') {
                return { quote: preserveTextForLlm(item), attribute: "", tags: [] };
              }
              return {
                quote: preserveTextForLlm(item?.quote || item?.原文 || ""),
                attribute: preserveTextForLlm(item?.attribute || item?.字段 || ""),
                tags: Array.isArray(item?.tags) ? item.tags.map(t => String(t || '').trim()).filter(Boolean) : []
              };
            }).filter(item => item.quote || item.attribute || item.tags.length > 0)
          : [];

        const confidence = Number(char.confidence ?? char.confidence_score ?? 0);

        return {
          name: char.name,
          aliases: Array.isArray(char.aliases) ? char.aliases.map(a => String(a || '').trim()).filter(Boolean) : [],
          gender: String(char.gender || '').trim(),
          role_type: String(char.role_type || char.role || '').trim(),
          tags: mergedTags,
          features: cleanFeatures,
          height_class: String(char.height_class || '').trim(),
          body_proportion: String(char.body_proportion || '').trim(),
          evidence,
          confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
          source_chapters: Array.isArray(char.source_chapters) ? char.source_chapters : sourceChapters,
          source_text_summary: String(char.source_text_summary || '').trim()
        };
      });
    } catch (error) {
      console.error("[LLM Extractor] 提取角色 DNA 异常:", error);
      return [];
    }
  }

  /**
   * 使用大模型对输入的场景描述进行重写分解为3-5个短句，适配分词语义检索
   */
  async rewriteQueryLlm(text, model = "deepseek-chat") {
    const queryRewritePrompt = [
      "你是一个 Danbooru 标签检索的查询重写分词引擎。",
      "请将输入的完整画面描述，按语义维度拆解为 3~5 个中文短语（每个短语限 7 个字以内，以符合分词语义检索的最佳表现）。",
      "拆解短语的维度可以包括：",
      "- 人设服装：如发色、瞳色、发型、衣服款式等物理外貌",
      "- 动作姿态：如奔跑、持剑、微笑等面部表情与动作姿态",
      "- 外部环境：如雨后街道、夜晚城市、烈火废墟等背景和氛围环境",
      "",
      "【约束条件】",
      "1. 每个短语聚焦单一细节，不混合。",
      "2. 严格以 JSON 字符串数组的格式输出，例如：[\"雨夜街道\", \"白色水手服\", \"女孩在奔跑\"]。",
      "3. 不要输出任何 Markdown 标记或 ``` 块包裹，不要包含其它任何文字或解释。"
    ].join("\n");

    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: withSystemPrefix(queryRewritePrompt) },
        { role: "user", content: `请将以下内容重构为用于检索的短语 JSON 数组：\n\n${text}` }
      ],
      temperature: 0.3,
      max_tokens: 2000
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000)
      });
      if (res.status === 200) {
        const resData = await res.json();
        let content = resData.choices[0].message.content.trim();
        // 移除思考块
        content = content.replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, "").trim();
        content = content.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "").trim();
        // 剥离 markdown
        if (content.includes("```")) {
          const match = content.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
          if (match) {
            content = match[1].trim();
          }
        }
        if (!content.startsWith("[")) {
          const firstBrace = content.indexOf("[");
          if (firstBrace >= 0) {
            content = content.substring(firstBrace);
          }
        }
        return JSON.parse(content);
      }
    } catch (e) {
      console.warn("[LLM Extractor] 场景大模型重写失败:", e.message);
    }
    return [text.substring(0, 30)];
  }

  buildStructuredSearchJobs(sceneInput, characterAnchors = []) {
    if (!sceneInput || typeof sceneInput !== 'object') return [];

    const jobs = [];
    const pushJob = (label, query, search_mode) => {
      const cleanQuery = preserveTextForLlm(query || '').replace(/\s+/g, ' ').trim();
      if (!cleanQuery) return;
      const duplicate = jobs.some(job => job.search_mode === search_mode && job.query === cleanQuery);
      if (!duplicate) jobs.push({ label, query: cleanQuery, search_mode });
    };

    const visualDescription = sceneInput.scene_desc || sceneInput.visual_description || buildSceneDescription(sceneInput);
    pushJob(
      'scene_environment',
      [
        visualDescription,
        sceneInput.environment ? `环境：${sceneInput.environment}` : ''
      ].filter(Boolean).join('；'),
      'full_scene'
    );

    for (const char of getSceneCharacters(sceneInput)) {
      const name = char.name || 'unknown';
      const anchor = (characterAnchors || []).find(item => {
        return String(item?.name || '').trim().toLowerCase() === String(name).trim().toLowerCase();
      });
      const dnaTags = String(anchor?.正面提示词 || '')
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join(', ');
      pushJob(
        `character:${name}`,
        [
          `角色：${name}`,
          char.appearance ? `外貌：${char.appearance}` : '',
          char.clothing ? `服装：${char.clothing}` : '',
          char.expression ? `表情：${char.expression}` : '',
          char.pose ? `姿势：${char.pose}` : '',
          char.position ? `位置：${char.position}` : '',
          dnaTags ? `角色DNA tags：${dnaTags}` : ''
        ].filter(Boolean).join('；'),
        'subject_describe'
      );
    }

    pushJob(
      'composition_action',
      [
        sceneInput.cinematography ? `镜头构图：${sceneInput.cinematography}` : '',
        sceneInput.interactions ? `动作互动：${sceneInput.interactions}` : ''
      ].filter(Boolean).join('；'),
      'concept_explore'
    );

    pushJob(
      'plot_traces',
      [
        sceneInput.plot_traces ? `剧情痕迹：${sceneInput.plot_traces}` : '',
        sceneInput.text_elements ? `画面文字元素：${sceneInput.text_elements}` : ''
      ].filter(Boolean).join('；'),
      'precise_lookup'
    );

    return jobs.slice(0, 6);
  }

  async searchDanbooruTags(query, options = {}) {
    try {
      return await searchTagsMcp(query, {
        endpoint: this.danbooru_mcp_url,
        search_mode: options.search_mode || 'full_scene',
        category: options.category || 'all',
        show_nsfw: true,
        include_wiki: false,
        timeoutMs: 120000
      });
    } catch (mcpErr) {
      console.warn(`[MCP] 远端 DanbooruSearchOnline 检索失败，降级本地词库: ${mcpErr.message}`);
      return searchTagsLocal(query, { limit: options.limit || 30 });
    }
  }

  async getRelatedDanbooruTags(tags, limit = 15) {
    try {
      return await getRelatedTagsMcp(tags, {
        endpoint: this.danbooru_mcp_url,
        limit,
        show_nsfw: true,
        include_wiki: false,
        timeoutMs: 120000
      });
    } catch (mcpErr) {
      console.warn(`[MCP] 远端 DanbooruSearchOnline 关联推荐失败，降级本地推荐: ${mcpErr.message}`);
      return getRelatedTagsLocal(tags, limit);
    }
  }

  formatStructuredSceneForLlm(sceneInput) {
    if (!sceneInput || typeof sceneInput !== 'object') return preserveTextForLlm(sceneInput);
    return JSON.stringify({
      visual_description: sceneInput.visual_description || sceneInput.scene_desc || buildSceneDescription(sceneInput),
      character_names: Array.isArray(sceneInput.character_names) ? sceneInput.character_names : [],
      environment: sceneInput.environment || '',
      cinematography: sceneInput.cinematography || '',
      characters: getSceneCharacters(sceneInput),
      interactions: sceneInput.interactions || '',
      interaction_actions: sceneInput.interaction_actions || [],
      text_elements: sceneInput.text_elements || '',
      visual_entities: Array.isArray(sceneInput.visual_entities) ? sceneInput.visual_entities : [],
      must_show: Array.isArray(sceneInput.must_show) ? sceneInput.must_show : [],
      must_not_show: Array.isArray(sceneInput.must_not_show) ? sceneInput.must_not_show : []
    }, null, 2);
  }

  /**
   * 高级场景生图参数生成（核心升级版）
   *
   * 整合：前置风格 + 场景生图词组 + 角色 DNA 标签（Prompts Bundle） + 后置构图画质增强
   *
   * @param {string} sceneDesc - 中文场景视觉描述（来自 LLM 分镜提取）
   * @param {Array}  characterAnchors - 已匹配的角色 DNA 信息数组
   * @param {string} model - 使用的 LLM 模型名
   * @param {function} onProgressLog - UI 进度日志回调函数
   * @returns {{ orientation: string, prompt: string, negative_prompt: string }}
   */
  async generateScenePromptAdvanced(sceneDesc, characterAnchors = [], model = "deepseek-chat", onProgressLog = null) {
    if (!this.apiKey) {
      throw new Error("请先填写有效的 API Key！");
    }

    // ── 1. 启动 DanbooruSearchOnline MCP 智能标签检索流 ──
    let candidatesStr = "";
    const fallbackBaseTags = [];
    const fallbackCharacterTags = new Map();
    const addFallbackTag = (target, tag) => {
      const value = String(tag || '').trim();
      if (!value || target.includes(value)) return;
      target.push(value);
    };
    try {
      onProgressLog?.(`[MCP] 正在为场景启用 DanbooruSearchOnline MCP 智能标签检索流...`);

      const isStructuredScene = sceneDesc && typeof sceneDesc === 'object';
      const searchJobs = [];

      if (isStructuredScene) {
        searchJobs.push(...this.buildStructuredSearchJobs(sceneDesc, characterAnchors));
        onProgressLog?.(`[MCP] 结构化字段检索任务: ${JSON.stringify(searchJobs.map(job => `${job.label}:${job.search_mode}`))}`);
      } else {
        // A. 查询重写（旧字符串场景兼容路径）
        onProgressLog?.(`[MCP] 正在调用大模型重写场景查询...`);
        const subQueries = await this.rewriteQueryLlm(sceneDesc, model);
        onProgressLog?.(`[LLM] 场景查询重写回复: ${JSON.stringify(subQueries)}`);
        searchJobs.push(...subQueries.map((query, index) => ({
          label: `legacy:${index + 1}`,
          query,
          search_mode: 'full_scene'
        })));
      }

      // B. MCP 语义搜索
      onProgressLog?.(`[MCP] 正在调用 DanbooruSearchOnline 搜索 Danbooru 标签...`);
      const candidateTags = [];
      const uniqueTags = new Set();
      const groupedCandidates = new Map();
      const MAX_CANDIDATES_PER_GROUP = 8;
      const MAX_TOTAL_CANDIDATES = 36;
      const isUsableCandidate = (item) => {
        const tag = String(item?.tag || '').trim();
        if (!tag) return false;
        if (item?.category && String(item.category).toLowerCase() !== 'general') return false;
        if (/^(?:white|black|grey|gray|blue|red|green|yellow|pink)_background$|^(?:simple|plain|empty|gradient)_background$/i.test(tag)) return false;
        return !/^(masterpiece|best quality|highly detailed|ultra-detailed|official art|artist:)/i.test(tag);
      };
      const rankCandidates = (items = []) => {
        return [...items]
          .filter(isUsableCandidate)
          .sort((a, b) => {
            const scoreA = Number(a.score ?? a.similarity ?? a.relevance ?? 0);
            const scoreB = Number(b.score ?? b.similarity ?? b.relevance ?? 0);
            if (scoreA !== scoreB) return scoreB - scoreA;
            return Number(b.count || 0) - Number(a.count || 0);
          })
          .filter((item, index, list) => list.findIndex(other => other.tag === item.tag) === index)
          .slice(0, MAX_CANDIDATES_PER_GROUP);
      };

      for (const job of searchJobs) {
        try {
          onProgressLog?.(`[MCP] ${job.label} -> ${job.search_mode}: ${job.query}`);
          const searchRes = await this.searchDanbooruTags(job.query, {
            search_mode: job.search_mode,
            category: job.label === 'plot_traces' ? 'general' : 'all',
            limit: 30
          });
          if (searchRes && !searchRes.error) {
            const results = rankCandidates(searchRes.results || []);
            for (const item of results) {
              const tag = item.tag;
              if (!tag) continue;
              const keyedItem = { ...item, search_label: job.label, search_mode: job.search_mode };
              if (!groupedCandidates.has(job.label)) groupedCandidates.set(job.label, []);
              groupedCandidates.get(job.label).push(keyedItem);
              if (!uniqueTags.has(tag)) {
                uniqueTags.add(tag);
                candidateTags.push(keyedItem);
              }
            }
            const characterMatch = job.label.match(/^character:([^:]+)(?::|$)/);
            const fallbackTarget = characterMatch
              ? (fallbackCharacterTags.get(characterMatch[1]) || [])
              : fallbackBaseTags;
            for (const item of results.slice(0, characterMatch ? 5 : 6)) {
              addFallbackTag(fallbackTarget, item?.tag);
            }
            if (characterMatch) fallbackCharacterTags.set(characterMatch[1], fallbackTarget);
          }
        } catch (searchErr) {
          console.error(`[MCP] 本地搜索 '${job.label}' 失败:`, searchErr.message);
        }
      }

      const selectedGroupedCandidates = new Map(
        Array.from(groupedCandidates.keys()).map(label => [label, []])
      );
      const selectedTags = new Set();
      for (let rank = 0; rank < MAX_CANDIDATES_PER_GROUP && selectedTags.size < MAX_TOTAL_CANDIDATES; rank++) {
        for (const [label, items] of groupedCandidates.entries()) {
          const item = items[rank];
          if (!item || selectedTags.has(item.tag)) continue;
          selectedTags.add(item.tag);
          selectedGroupedCandidates.get(label).push(item);
          if (selectedTags.size >= MAX_TOTAL_CANDIDATES) break;
        }
      }
      const selectedCandidates = candidateTags.filter(item => selectedTags.has(item.tag));

      onProgressLog?.(`[MCP] DanbooruSearchOnline 送入 LLM 的候选标签: ${JSON.stringify(selectedCandidates.map(t => `${t.tag}(${t.cn_name || ''})`))}`);

      // C. 组合候选标签上下文。LLM 负责主生成，MCP 只提供少量标准标签参考。
      if (candidateTags.length > 0) {
        onProgressLog?.(`[MCP] DanbooruSearchOnline 检索完成：捕获 ${candidateTags.length} 个候选，按全局预算选取 ${selectedCandidates.length} 个送入 LLM。`);
        if (groupedCandidates.size > 0) {
          candidatesStr = Array.from(selectedGroupedCandidates.entries()).map(([label, items]) => {
            if (items.length === 0) return '';
            const mode = items[0]?.search_mode || 'full_scene';
            const lines = items.map(item => `- ${item.tag} -> ${item.cn_name || '无'} (${item.category || 'General'})`).join("\n");
            return `【${label} / ${mode}】\n${lines}`;
          }).filter(Boolean).join("\n\n");
        } else {
          candidatesStr = candidateTags.slice(0, MAX_TOTAL_CANDIDATES).map(item => {
            return `- ${item.tag} -> ${item.cn_name || '无'} (${item.category || 'General'})`;
          }).join("\n");
        }
      } else {
        onProgressLog?.(`[MCP] DanbooruSearchOnline 检索完毕，未发现匹配的候选标签。`);
      }

    } catch (mcpErr) {
      onProgressLog?.(`[MCP] DanbooruSearchOnline 工作流异常或超时: ${mcpErr.message}，将优雅降级为大模型直译...`);
    }

    // ── 2. 构造混合大模型合成 Prompt ──
    // 构建角色上下文文本（将已有的 DNA tags 传给 LLM，让它感知角色外观）
    let characterContext = "";
    if (characterAnchors && characterAnchors.length > 0) {
      const charLines = characterAnchors.map(anchor => {
        const name = anchor.name || "未知角色";
        const tags = anchor.正面提示词 || "";
        return `• ${name}：${tags}`;
      }).join("\n");
      characterContext = `\n\n【本场景涉及角色外貌参考（已预先提取的 Danbooru tags）】\n${charLines}`;
    }

    let mcpContext = "";
    if (candidatesStr) {
      mcpContext = `\n\n【DanbooruSearchOnline MCP 标准标签参考】\n以下仅用于校验拼写或补充难以直译的服装、物件、动作标签。请以场景语义为主，只选择明确匹配的少量标签，禁止为了使用候选而引入无关概念。\n${candidatesStr}`;
    }

    const systemPrompt = ensureAdvancedPromptContract(this.system_prompt_advanced_prompt || DEFAULT_ADVANCED_PROMPT);
    const scenePayload = this.formatStructuredSceneForLlm(sceneDesc);

    // 提取 nsfw_rating 和 plot_traces，显式告知 LLM
    const nsfwRating = (typeof sceneDesc === 'object' ? sceneDesc.nsfw_rating : '') || 'sfw';
    const plotTraces = (typeof sceneDesc === 'object' ? sceneDesc.plot_traces : '') || '';
    const nsfwLine = `【NSFW 等级】${nsfwRating}（请严格按照系统 Prompt 中对该等级的 tag 规则生成，不得遗漏也不得升级）`;
    const nsfwPerspectiveLine = nsfwRating !== 'sfw'
      ? "【NSFW 透视与机位（必须）】base_prompt 必须根据人物相对位置与动作接触关系加入一个明确主视角（如 pov、from_above、from_below、side_view、over_the_shoulder、three-quarter_view），并加入至少一个空间透视 tag（如 dynamic_perspective、foreshortening、depth_of_field、foreground_background）。必须让关键身体互动、遮挡层次和接触点清楚可见；只能使用一套连贯机位，禁止 multiple_views、split_screen 或互相矛盾的角度。"
      : '';
    const plotTracesLine = plotTraces ? `【剧情痕迹 tags（必须全部写入对应角色的 prompt 中）】${plotTraces}` : '';

    const userMessage = [
      "请为以下中文小说插画场景生成 NovelAI 生图参数。",
      `本场景可见角色数量固定为 ${getSceneCharacters(sceneDesc).length}，不得添加任何路人、背景人物或重复角色。character_prompts 数量必须等于可见角色数量。`,
      "要求：base_prompt 只能包含精确人物总数、全局环境、镜头、氛围、角色间动作关系、NSFW全局标签（若适用）；禁止在 base_prompt 重复任何单个角色的发色、身材、服装、表情和个人姿势。character_prompts 必须按角色拆分。每个角色只保留一个符合剧情的主情绪，优先使用轻微微笑、担忧、羞涩、惊讶、恼怒、悲伤、疲惫、坚定等克制但明确的表情，并用眼神、眉形和轻微嘴角变化表现；不要把所有角色都写成 calm、expressionless 或 natural_expression。除非原文明确要求露齿、咬牙、狂笑或尖牙，否则保持 closed_mouth / relaxed_lips，禁止 bared_teeth、clenched_teeth、sharp_teeth、fang、crazy_grin、distorted_mouth。多人场景不要输出 solo，保持同一地面、自然比例与轻微相对身高差。两个或更多角色时优先 square 或 landscape。",
      "NSFW 场景的角色表情必须针对当前情境生成：可使用 restrained pleasured_expression、half-closed_eyes、bedroom_eyes、deep_blush、embarrassed、pained_expression、dazed_expression、unfocused_eyes、teasing_expression、satisfied_expression、slightly_parted_lips 或 biting_lip；根据角色实际状态选择一个主情绪，禁止所有角色复用同一副表情，也禁止无依据的 ahegao、crazy_grin 或 distorted_face。",
      "背景不是硬性要求。根据原文与构图需要选择详细环境、简洁背景或纯色背景；近景、动作特写和角色主导画面可以使用 simple_background、plain_background、white_background、black_background、gradient_background 或 backgroundless。不要为了凑背景标签挤占主体动作与角色细节。",
      "精确接触动作必须写清：谁持有什么物体、对准谁、接触哪个身体部位、用什么镜头清楚显示接触点。剑尖抵喉必须使用 sword_tip_touching_throat / blade_pressed_against_neck / visible_throat_contact，不能只写 holding_sword、confrontation 或 attacking。",
      "多人互动必须区分动作供体与受体。character_prompts 中供体写 interaction_role=source，受体写 interaction_role=target，双方主动互相执行时写 mutual；interaction_action 只写同一个英文 Danbooru 动作标签，不要自行添加 source#/target#/mutual# 前缀。",
      getSceneCharacters(sceneDesc).length >= 3
        ? "三人及以上复杂互动必须构建清晰动作图：每个直接身体接触单独输出一条 interaction_requirements，并在对应双方的 interaction_actions 中使用同一个精确动作标签。不要把 penetration、sucking、touching 等不同接触合并成泛化 sex。为每个角色分配互不冲突的 left/center/right 与 foreground/midground/background 位置；同一角色可以同时接收或发出多条动作。只有双方确实共同执行同一动作时才写 mutual，具有明确主动方和受体的性交、插入、吸吮、抓握等动作必须保留 source/target。"
        : '',
      nsfwLine,
      nsfwPerspectiveLine,
      plotTracesLine,
      "",
      "【结构化/兼容场景描述】",
      scenePayload,
      characterContext,
      mcpContext
    ].filter(part => part !== "").join("\n");

    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      stream: false
    };

    onProgressLog?.(`[LLM] 正在调用大模型进行参数合成...`);
    const expectedSceneCharacters = getSceneCharacters(sceneDesc);

    const parseAdvancedContent = (content) => {
      let rawContent = String(content || '').trim();
      rawContent = rawContent.replace(/<\s*thinking\s*>[\s\S]*?<\s*\/\s*thinking\s*>/gi, "").trim();
      rawContent = rawContent.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "").trim();

      let jsonStr = rawContent;
      const jsonMatch = rawContent.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();
      if (!jsonStr.startsWith("{")) {
        const firstBrace = jsonStr.indexOf("{");
        if (firstBrace >= 0) jsonStr = jsonStr.substring(firstBrace);
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.warn("[LLM Extractor] 高级参数 JSON 解析失败，尝试 robustJsonLoads:", parseErr.message);
        parsed = robustJsonLoads(jsonStr);
      }

      const VALID_ORIENTATIONS = new Set(["portrait", "landscape", "square", "default"]);
      const orientation = VALID_ORIENTATIONS.has(parsed?.orientation) ? parsed.orientation : "default";
      const base_prompt = (parsed?.base_prompt || "").trim();
      if (!base_prompt) {
        throw new Error("缺少非空 base_prompt；旧式 prompt 单字段不再接受");
      }
      const normalizeInteractionAction = (value) => String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
      const normalizeInteractionRole = (role, action) => {
        const normalizedRole = String(role || '').toLowerCase();
        return ['source', 'target', 'mutual'].includes(normalizedRole) ? normalizedRole : 'none';
      };
      const character_prompts = Array.isArray(parsed?.character_prompts)
        ? parsed.character_prompts.map(item => {
            if (typeof item === 'string') return { name: '', prompt: item.trim() };
            return {
              name: (item?.name || '').trim(),
              prompt: (item?.prompt || '').trim(),
              negative_prompt: String(item?.negative_prompt || '').trim(),
              interaction_actions: (Array.isArray(item?.interaction_actions)
                ? item.interaction_actions
                : (item?.interaction_action ? [{
                    role: item?.interaction_role,
                    action: item?.interaction_action
                  }] : []))
                .map(action => ({
                  action: String(action?.action || '').trim(),
                  role: normalizeInteractionRole(action?.role, action?.action)
                }))
                .filter(action => action.role !== 'none' && action.action),
              interaction_role: normalizeInteractionRole(item?.interaction_role, item?.interaction_action),
              interaction_action: String(item?.interaction_action || '').trim()
            };
          }).filter(item => item.prompt)
        : [];
      if (character_prompts.length !== expectedSceneCharacters.length) {
        throw new Error(`character_prompts 数量 ${character_prompts.length} 与场景角色数量 ${expectedSceneCharacters.length} 不一致`);
      }
      for (let index = 0; index < expectedSceneCharacters.length; index++) {
        const expectedName = String(expectedSceneCharacters[index]?.name || '').trim();
        const actualName = String(character_prompts[index]?.name || '').trim();
        if (expectedName && actualName !== expectedName) {
          throw new Error(`character_prompts[${index}].name 应为「${expectedName}」，实际为「${actualName || '空'}」`);
        }
      }
      const interactionRequirements = Array.isArray(parsed?.interaction_requirements)
        ? parsed.interaction_requirements.map(item => ({
            action: normalizeInteractionAction(item?.action),
            source: String(item?.source || '').trim(),
            target: String(item?.target || '').trim(),
            requires_pairing: item?.requires_pairing !== false,
            mutual: item?.mutual === true
          })).filter(item => item.action && item.source)
        : [];
      const interactionRequirementMap = new Map(
        interactionRequirements.map(item => [
          `${item.action}::${item.source}::${item.target}`,
          item.requires_pairing
        ])
      );
      const promptsByName = new Map(
        character_prompts.map(item => [String(item.name || '').trim(), item])
      );
      for (const interaction of Array.isArray(sceneDesc?.interaction_actions) ? sceneDesc.interaction_actions : []) {
        const action = normalizeInteractionAction(interaction?.action);
        const sourceName = String(interaction?.source || '').trim();
        const targetName = String(interaction?.target || '').trim();
        const interactionKey = `${action}::${sourceName}::${targetName}`;
        const requiresPairing = interactionRequirementMap.has(interactionKey)
          ? interactionRequirementMap.get(interactionKey) !== false
          : !SELF_DIRECTED_INTERACTION_ACTIONS.has(action);
        const requireMutual = interaction?.mutual === true || interactionRequirements.some(item => (
          item.action === action
          && item.source === sourceName
          && item.target === targetName
          && item.mutual === true
        ));
        if (!action || !sourceName || (!targetName && !SELF_DIRECTED_INTERACTION_ACTIONS.has(action))) {
          throw new Error("interaction_actions 必须包含非空 action、source 和 target");
        }
        const sourcePrompt = promptsByName.get(sourceName);
        const targetPrompt = promptsByName.get(targetName);
        if (!sourcePrompt) {
          throw new Error(`互动角色未出现在 character_prompts: ${sourceName} -> ${targetName || '空'}`);
        }
        if (
          requiresPairing
          && !targetPrompt
        ) {
          throw new Error(`互动角色未出现在 character_prompts: ${sourceName} -> ${targetName}`);
        }
        if (!requiresPairing) continue;
        const expectedRole = interaction?.mutual === true ? 'mutual' : 'source';
        const expectedTargetRole = interaction?.mutual === true ? 'mutual' : 'target';
        const effectiveExpectedRole = requireMutual ? 'mutual' : expectedRole;
        const effectiveExpectedTargetRole = requireMutual ? 'mutual' : expectedTargetRole;
        const hasInteraction = (promptItem, role) => promptItem.interaction_actions.some(item => (
          item.role === role && normalizeInteractionAction(item.action) === action
        ));
        if (!hasInteraction(sourcePrompt, effectiveExpectedRole)) {
          throw new Error(`角色「${sourceName}」必须标记为 ${effectiveExpectedRole}#${action}`);
        }
        if (!hasInteraction(targetPrompt, effectiveExpectedTargetRole)) {
          throw new Error(`角色「${targetName}」必须标记为 ${effectiveExpectedTargetRole}#${action}`);
        }
      }
      const characterSpecificTags = new Set(
        character_prompts
          .flatMap(item => item.prompt.split(/[,，]/))
          .map(tag => tag.trim().toLowerCase())
          .filter(Boolean)
      );
      const cleanedBasePrompt = base_prompt
        .split(/[,，]/)
        .map(tag => tag.trim())
        .filter(Boolean)
        .filter(tag => !characterSpecificTags.has(tag.toLowerCase()))
        .join(', ');
      const hasNsfwViewpoint = /(?:^|,\s*)(?:pov|from_above|from_below|side_view|over_the_shoulder|three-quarter_view)(?:\s*,|$)/i.test(cleanedBasePrompt);
      const hasNsfwSpatialPerspective = /(?:^|,\s*)(?:dynamic_perspective|foreshortening|depth_of_field|foreground_background)(?:\s*,|$)/i.test(cleanedBasePrompt);
      const resolvedBasePrompt = nsfwRating !== 'sfw'
        ? uniqueTags([
            ...cleanedBasePrompt.split(/[,，]/),
            ...(!hasNsfwViewpoint ? ['three-quarter_view'] : []),
            ...(!hasNsfwSpatialPerspective ? ['dynamic_perspective', 'depth_of_field'] : [])
          ]).join(', ')
        : cleanedBasePrompt;
      const prompt = uniqueTags([
        ...resolvedBasePrompt.split(/[,，]/),
        ...character_prompts.flatMap(item => item.prompt.split(/[,，]/))
      ]).join(', ');
      const negative_prompt = (parsed?.negative_prompt || "").trim();
      if (!prompt && !resolvedBasePrompt) throw new Error("LLM 返回的 prompt 为空");
      return { orientation, prompt, base_prompt: resolvedBasePrompt, character_prompts, negative_prompt };
    };

    try {
      const retryUserMessage = [
        "上一次输出为空、截断或 JSON 结构无效。请重新生成，只输出一个完整 JSON 对象。",
        "不要解释，不要 Markdown，不要颜文字。",
        "必须包含 orientation、base_prompt、character_prompts、negative_prompt。",
        "每个 character_prompts 项必须包含 negative_prompt 和 interaction_actions 数组；同时必须返回 interaction_requirements，逐项判断 scene card 里的动作是否真的需要 source/target 成对校验。",
        `character_prompts 必须严格包含 ${expectedSceneCharacters.length} 项，按以下顺序且 name 原样复制：${expectedSceneCharacters.map(char => char.name).join("、") || "无角色"}`,
        "禁止只返回旧式 prompt 字段。base_prompt 中不得包含角色外貌、服装、表情或个人姿势。",
        nsfwPerspectiveLine,
        "务必完整闭合 JSON；若内容较长，优先减少次要 tags，不得截断。",
        "【场景】",
        scenePayload,
        characterContext
      ].join("\n");
      let lastAttemptError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const attemptPayload = attempt === 1
          ? payload
          : {
              model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: retryUserMessage }
              ],
              temperature: 0.1,
              max_tokens: 4000,
              stream: false
            };

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(attemptPayload),
            signal: AbortSignal.timeout(120000)
          });
          if (res.status !== 200) throw new Error(`HTTP Error ${res.status}`);

          const { responseData, content: rawContent } = await readLlmResponse(res);
          onProgressLog?.(`[LLM] 第 ${attempt}/3 次生成结果:\n${rawContent}`);
          if (!rawContent) {
            throw new Error(`上游响应未包含可用文本；响应结构 ${summarizeLlmResponseShape(responseData)}`);
          }

          const finishReason = responseData?.choices?.[0]?.finish_reason;
          const completeness = checkTextCompleteness(rawContent);
          if (finishReason === 'length' || finishReason === 'max_tokens' || !completeness.isComplete) {
            const reason = finishReason === 'length' || finishReason === 'max_tokens'
              ? `finish_reason=${finishReason}`
              : completeness.reason;
            throw new Error(`响应疑似截断：${reason}`);
          }

          const normalized = parseAdvancedContent(rawContent);
          onProgressLog?.(`[LLM] 第 ${attempt}/3 次解析成功: ${JSON.stringify(normalized, null, 2)}`);
          return normalized;
        } catch (attemptError) {
          lastAttemptError = attemptError;
          if (attempt < 3) {
            onProgressLog?.(
              `[LLM] 第 ${attempt}/3 次参数生成失败，优先重试（下一次使用精简上下文）: ${attemptError.message}`,
              "warning"
            );
          } else {
            onProgressLog?.(`[LLM] 连续 3 次参数生成失败，不执行降级: ${attemptError.message}`, "warning");
          }
        }
      }

      throw lastAttemptError || new Error("连续 3 次参数生成失败");
    } catch (e) {
      onProgressLog?.(`[LLM] 参数合成失败，不允许降级: ${e.message}`, "warning");
      console.error("[LLM Extractor] 高级场景参数生成失败:", e.message);
      throw e;
    }
  }

  /**
   * 将中文描述翻译提炼为 NovelAI 英文 Danbooru Tags（角色DNA用，保留兼容）
   */
  async translateToTags(text, model = "deepseek-chat", taskType = "character") {
    if (!this.apiKey) {
      throw new Error("请先填写有效的 API Key！");
    }

    const url = `${this.baseUrl}/chat/completions`;
    let systemPrompt = "";
    let cotPrefill = "";

    if (taskType === "character") {
      systemPrompt = [
        "你是分词器大师。",
        "你的职责是把输入资料整理成稳定、可执行、可直接投喂图像模型的高质量英文提示词（Danbooru Tags）。",
        "请严格遵循系统层给定的角色、规则、任务和输出约束，围绕任务目标组织结果。",
        "",
        "【任务约束】",
        "1. 将角色资料中的性别、年龄、身份、服饰、发色、外貌特征等彻底翻译、提炼为逗号分隔的英文 tags。",
        "2. 请只输出 <提示词>...</提示词>。不要输出任何除了这组标签外的其他字句、解释、序号前缀或标记。",
        "3. 严禁补全除输入资料以外的无关古风或现代饰品道具。",
        "4. 严禁包含任何视距、镜头、构图、多视角或肖像相关的提示词。"
      ].join("\n");
      
      cotPrefill = [
        "<think>好的思考结束</think>",
        "好的，将先输出<thinking></thinking>，再输出<提示词></提示词>；",
        "<提示词>内只保留当前单个角色最终用于生图的 tags："
      ].join("\n");
    } else {
      systemPrompt = [
        "你是通用叙事场景提示词转换器。",
        "你的任务是：把当前的画面视觉定格描述整理成可直接生图的高质量英文 Danbooru tags。",
        "",
        "【任务约束】",
        "1. 提取画面定格中的动作、光影、色彩、氛围、具体环境并翻译提炼为逗号分隔的英文 tags。",
        "2. 保持协调统一，镜头约束在单一画面、单一主姿态下。",
        "3. 请只输出 <提示词>...</提示词>。不要输出任何除了这组标签外的其他字句。"
      ].join("\n");

      cotPrefill = [
        "<think>好的思考结束</think>",
        "好的，将先输出<thinking></thinking>，再输出<提示词></提示词>；",
        "<提示词>内只保留当前单个场景最终用于生图的 tags："
      ].join("\n");
    }

    const payload = {
      model,
      messages: [
        { role: "system", content: withSystemPrefix(systemPrompt) },
        { role: "user", content: `请将以下内容转化为精细的生图 tags：\n\n${text}` },
        { role: "assistant", content: cotPrefill }
      ],
      temperature: 0.5,
      max_tokens: 2000
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000)
      });

      if (res.status !== 200) {
        throw new Error(`HTTP Error ${res.status}`);
      }

      const resData = await res.json();
      const rawContent = resData.choices[0].message.content.trim();
      return conservativeCompletionNaiWeights(rawContent);
    } catch (e) {
      console.error("[LLM Extractor] 词组转化失败:", e);
      throw new Error(`词组转化过程中发生异常: ${e.message}`);
    }
  }
}
