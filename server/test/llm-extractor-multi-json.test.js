import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMExtractor, extractAdvancedJsonEnvelope, findLastAdvancedJsonObject, disableLlmRateLimiterForTests } from '../services/llm-extractor.js';

disableLlmRateLimiterForTests();

test('extractAdvancedJsonEnvelope correctly ignores thinking draft JSON and extracts final /JSON/ block', () => {
  const modelOutput = `
<think>
用户要求输出格式为：
/thinking/
...
/thinking/
/JSON/
...
/JSON/

让我仔细分析。规则提到 /JSON/.base_prompt 必须包含特定标签。
我先在草稿中草拟一下：
/JSON/
{
  "orientation": "portrait",
  "base_prompt": "draft prompt"
}
/JSON/

等等，场景是双人客厅沙发互动，需要 square 比例，且人物是哥哥和妹妹。
</think>
/thinking/
- 角色数量：2（哥哥、妹妹）
- 场景：客厅沙发
/thinking/
/JSON/
{
  "orientation": "square",
  "base_prompt": "1girl, 1boy, living room, sofa",
  "character_prompts": [
    { "name": "哥哥", "prompt": "boy, short_hair, black_hair", "negative_prompt": "long_hair" },
    { "name": "妹妹", "prompt": "girl, long_hair, black_hair", "negative_prompt": "short_hair" }
  ],
  "negative_prompt": "multiple views, split screen"
}
/JSON/
`;

  const extracted = extractAdvancedJsonEnvelope(modelOutput);
  assert.ok(extracted.includes('"orientation": "square"'));
  assert.ok(extracted.includes('"base_prompt": "1girl, 1boy, living room, sofa"'));
  assert.ok(!extracted.includes('draft prompt'));

  const parsed = findLastAdvancedJsonObject(extracted);
  assert.equal(parsed?.orientation, 'square');
  assert.equal(parsed?.base_prompt, '1girl, 1boy, living room, sofa');
  assert.equal(parsed?.character_prompts?.length, 2);
});

test('findLastAdvancedJsonObject scans from end to find the final valid object even without envelope tags', () => {
  const rawText = `
这里是一个中间草稿：
{"name": "妹妹", "draft": true}

这是最终的完整生图参数：
{
  "orientation": "landscape",
  "base_prompt": "1girl, garden, flowers, sunlight",
  "character_prompts": [
    { "name": "妹妹", "prompt": "girl, cute dress", "negative_prompt": "" }
  ],
  "negative_prompt": "low quality"
}
`;

  const parsed = findLastAdvancedJsonObject(rawText);
  assert.ok(parsed);
  assert.equal(parsed.orientation, 'landscape');
  assert.equal(parsed.base_prompt, '1girl, garden, flowers, sunlight');
  assert.equal(parsed.character_prompts[0].name, '妹妹');
});

test('LLMExtractor.generateScenePromptAdvanced successfully parses multi-JSON thinking response without retrying', async () => {
  const extractor = new LLMExtractor({ apiKey: 'test', baseUrl: 'https://example.invalid' });

  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    const complexOutput = `
<think>
block:
/thinking/
...
/thinking/
/JSON/
...
/JSON/
The parser will use only the /JSON/ block:
/JSON/.base_prompt must include tags such as cross-section
</think>
/thinking/
Checklist completed.
/thinking/
/JSON/
{
  "orientation": "square",
  "base_prompt": "nsfw, explicit, uncensored, 1girl, 1boy, sofa",
  "character_prompts": [
    { "name": "哥哥", "prompt": "boy, short_hair", "negative_prompt": "" },
    { "name": "妹妹", "prompt": "girl, long_hair", "negative_prompt": "" }
  ],
  "negative_prompt": "split screen"
}
/JSON/
`;
    return {
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: { content: complexOutput }
        }]
      })
    };
  };

  try {
    const result = await extractor.generateScenePromptAdvanced({
      visual_description: '两人坐在沙发上',
      characters: [
        { name: '哥哥', gender: 'man' },
        { name: '妹妹', gender: 'woman' }
      ]
    }, [], 'test');

    assert.equal(fetchCount, 1, '必须一次性成功提取最终 JSON，不触发错误重试');
    assert.equal(result.orientation, 'square');
    assert.ok(result.base_prompt.includes('nsfw, explicit, uncensored'));
    assert.equal(result.character_prompts.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
