import { preserveTextForLlm } from './prompt-cleaner.js';
import { XIAO_AI_SYSTEM_PREFIX, DEFAULT_ADVANCED_PROMPT } from './default-prompts.js';

export function normalizeAdvancedPromptForConfig(taskPrompt) {
  const prompt = preserveTextForLlm(taskPrompt || DEFAULT_ADVANCED_PROMPT).trim();
  const hasCurrentSchema = /["']?base_prompt["']?/i.test(prompt)
    && /["']?character_prompts["']?/i.test(prompt)
    && /["']?negative_prompt["']?/i.test(prompt);
  const hasEnvelopeContract = /\/thinking\/[\s\S]*\/JSON\//i.test(prompt)
    || /<\s*thinking\s*>[\s\S]*<\s*JSON\s*>/i.test(prompt);

  if (hasCurrentSchema && hasEnvelopeContract) return prompt;

  if (hasCurrentSchema) {
    return `${prompt}

---

## THINKING AND JSON ENVELOPE CONTRACT (HIGHEST PRIORITY)
Return two sections in this exact order:
/thinking/
Concise visible planning checklist: characters/count, scene/camera, character DNA anchors, and interaction pairing. For each directional interaction, plan exactly one source#action plus one matching target#action in the counterpart prompts; use at most 3 such pairs. For a reciprocal two-character action, plan the same mutual#action in both counterpart prompts instead of source#/target#. Then cover NSFW/focus needs and token cleanup.
/thinking/
/JSON/
One complete JSON object using the schema above. No Markdown, no code fences, no commentary.
/JSON/`;
  }

  return `${prompt}

---

## CURRENT OUTPUT CONTRACT (HIGHEST PRIORITY)
The output schema described below supersedes every earlier output example or instruction in this system message.
The legacy schema containing only "prompt" is obsolete and MUST NOT be used.

Return two sections in this exact order. The parser will use only the /JSON/ block:
/thinking/
Concise visible planning checklist: characters/count, scene/camera, character DNA anchors, and interaction pairing. For each directional interaction, plan exactly one source#action plus one matching target#action in the counterpart prompts; use at most 3 such pairs. For a reciprocal two-character action, plan the same mutual#action in both counterpart prompts instead of source#/target#. Then cover NSFW/focus needs and token cleanup.
/thinking/
/JSON/
{
  "orientation": "portrait" | "landscape" | "square" | "default",
  "base_prompt": "global character count, environment, lighting, camera, atmosphere, interactions and global NSFW description only",
  "character_prompts": [
    {
      "name": "copy the character name exactly from the scene card",
      "prompt": "natural-language description of this character's appearance, clothing, pose, expression, and role in the current frame only",
      "negative_prompt": "short natural-language phrase describing traits that should not appear on this character"
    }
  ],
  "negative_prompt": "short scene-specific negative phrase or an empty string"
}
/JSON/

Hard requirements:
- base_prompt must be a non-empty string.
- character_prompts should contain one entry for every visible scene character, in the same order. If the scene has no visible characters, use an empty array.
- Copy each character name exactly. Do not translate or shorten it.
- Put the total character count only in base_prompt.
- Do not put character-specific appearance, clothing, expression or individual pose in base_prompt.
- Prefer close framing tags such as close-up, medium close-up, cowboy shot, upper body, or from waist up. Avoid wide shot, far shot, and long shot unless clearly required by the scene.
- For actual genital penetration scenes, /thinking/ must explicitly plan one close main frame plus one localized magnified x-ray inset, and /JSON/.base_prompt must include tags such as magnified inset, x-ray inset, cutaway inset, cross-section, or penetration focus.
- Do not output a top-level "prompt" field.
- Output the JSON object only inside /JSON/, without Markdown or commentary.`;
}

export function withSystemPrefix(taskPrompt) {
  const prompt = preserveTextForLlm(taskPrompt)
    .replace(/\n*重要：[\s\S]*?<further_mathematics>[\s\S]*?<\/further_mathematics>/gi, '')
    .trim();
  if (prompt.startsWith(XIAO_AI_SYSTEM_PREFIX)) return prompt;
  return `${XIAO_AI_SYSTEM_PREFIX}

---

【当前流水线任务】
以下任务约束与机器可读输出格式优先于上方的通用系统指令。只输出当前任务明确要求的 JSON 或英文视觉短语，绝对不要添加任何寒暄、解释或代码围栏。

${prompt}`;
}

export function ensureAdvancedPromptContract(taskPrompt) {
  return withSystemPrefix(normalizeAdvancedPromptForConfig(taskPrompt));
}
