import test from 'node:test';
import assert from 'node:assert/strict';
import { promptReferenceService, cleanReferenceTags } from '../services/prompt-reference-service.js';

test('cleanReferenceTags strips boilerplate quality, year and artist tags', () => {
  const sample = '0.95::hyulla::,0.8::artist:blue gk::,1girl,1boy,from behind,doggystyle,arched back,looking back,masterpiece,best quality,ultra high resolution,Variety+,year 2025,censored';
  const cleaned = cleanReferenceTags(sample);
  assert.match(cleaned, /1girl/);
  assert.match(cleaned, /doggystyle/);
  assert.match(cleaned, /from behind/);
  assert.doesNotMatch(cleaned, /artist:/);
  assert.doesNotMatch(cleaned, /masterpiece/);
  assert.doesNotMatch(cleaned, /Variety\+/);
  assert.doesNotMatch(cleaned, /year 2025/);
});

test('PromptReferenceService initializes and builds indexes', async () => {
  await promptReferenceService.initialize();
  assert.equal(promptReferenceService.isInitialized, true);
  assert.ok(promptReferenceService.r18Entries.length > 5000, 'R18 entries loaded');
  assert.ok(promptReferenceService.regularEntries.length > 3000, 'Regular entries loaded');
  assert.ok(promptReferenceService.r18TermIndex.size > 1000, 'R18 term index populated');
  assert.ok(promptReferenceService.regularTermIndex.size > 1000, 'Regular term index populated');
});

test('PromptReferenceService retrieves SFW fighting/sword scene', async () => {
  await promptReferenceService.initialize();
  const scene = {
    visual_description: '月夜下废墟中少年与少女背靠背拔剑迎敌',
    core_action: '背靠背拔剑迎敌',
    characters: [{}, {}],
    nsfw_rating: 'sfw'
  };

  const results = promptReferenceService.findReferences(scene, { limit: 2 });
  assert.ok(results.length > 0, 'Should return results');
  const top = results[0];
  assert.ok(top.score > 20, 'Should have positive score');
  const matched = `${top.title} ${top.category} ${top.tags}`.toLowerCase();
  assert.ok(
    matched.includes('剑') || matched.includes('sword') || matched.includes('背靠背') || matched.includes('战') || matched.includes('fight'),
    `Result should be relevant to sword/battle/back-to-back: ${top.title} (${top.category})`
  );
});

test('PromptReferenceService retrieves NSFW rear penetration / doggystyle scene', async () => {
  await promptReferenceService.initialize();
  const scene = {
    visual_description: '两人在榻榻米上，男子从背后抱住女子进行后入交合',
    core_action: '后入交合',
    sex_position: '后入',
    characters: [{}, {}],
    nsfw_rating: 'nsfw_explicit'
  };

  const results = promptReferenceService.findReferences(scene, { limit: 2 });
  assert.ok(results.length > 0, 'Should return results');
  const top = results[0];
  const matched = `${top.title} ${top.category} ${top.tags}`.toLowerCase();
  assert.ok(
    matched.includes('后入') || matched.includes('behind') || matched.includes('doggystyle'),
    `Result should match doggystyle / from behind: ${top.title} (${top.category})`
  );
});

test('PromptReferenceService retrieves NSFW cowgirl / straddling scene', async () => {
  await promptReferenceService.initialize();
  const scene = {
    visual_description: '女子跨坐在男子身上，正向骑乘位摇曳',
    core_action: '骑乘位',
    sex_position: '骑乘',
    characters: [{}, {}],
    nsfw_rating: 'nsfw_explicit'
  };

  const results = promptReferenceService.findReferences(scene, { limit: 2 });
  assert.ok(results.length > 0, 'Should return results');
  const top = results[0];
  const matched = `${top.title} ${top.category} ${top.tags}`.toLowerCase();
  assert.ok(
    matched.includes('骑乘') || matched.includes('cowgirl') || matched.includes('straddling'),
    `Result should match cowgirl position: ${top.title} (${top.category})`
  );
});

test('PromptReferenceService retrieves NSFW oral / fellatio scene', async () => {
  await promptReferenceService.initialize();
  const scene = {
    visual_description: '少女跪在男子面前，双手扶着进行口交侍奉',
    core_action: '口交侍奉',
    sex_position: '口交',
    characters: [{}, {}],
    nsfw_rating: 'nsfw_explicit'
  };

  const results = promptReferenceService.findReferences(scene, { limit: 2 });
  assert.ok(results.length > 0, 'Should return results');
  const top = results[0];
  const matched = `${top.title} ${top.category} ${top.tags}`.toLowerCase();
  assert.ok(
    matched.includes('口交') || matched.includes('fellatio') || matched.includes('blowjob'),
    `Result should match fellatio / oral: ${top.title} (${top.category})`
  );
});

test('formatReferencesForLlm creates compact few-shot block', async () => {
  await promptReferenceService.initialize();
  const scene = {
    visual_description: '两人在榻榻米上后入',
    sex_position: '后入',
    characters: [{}, {}],
    nsfw_rating: 'nsfw_explicit'
  };
  const results = promptReferenceService.findReferences(scene, { limit: 2 });
  const formatted = promptReferenceService.formatReferencesForLlm(results);
  assert.match(formatted, /【本地精选真机参考范例（Few-Shot 构图与标签参考）】/);
  assert.match(formatted, /• 范例 1/);
});

test('PromptReferenceService benchmark completes query in under 5ms', async () => {
  await promptReferenceService.initialize();
  const scene = {
    visual_description: '在教室里少女向窗外的少年微笑招手',
    core_action: '微笑招手',
    characters: [{}, {}],
    nsfw_rating: 'sfw'
  };

  const start = performance.now();
  for (let i = 0; i < 20; i++) {
    promptReferenceService.findReferences(scene, { limit: 2 });
  }
  const avgMs = (performance.now() - start) / 20;
  assert.ok(avgMs < 5, `Average query latency was ${avgMs.toFixed(3)}ms (expected < 5ms)`);
});

test('generateScenePromptAdvanced injects Few-Shot reference examples into user message', async () => {
  const { LLMExtractor } = await import('../services/llm-extractor.js');
  let capturedPayload = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (url.includes('/chat/completions')) {
      capturedPayload = JSON.parse(options.body);
      const mockResponse = {
        choices: [
          {
            message: {
              content: [
                '/thinking/',
                'Thinking about scene',
                '/thinking/',
                '/JSON/',
                JSON.stringify({
                  orientation: 'square',
                  base_prompt: '1girl, 1boy, doggystyle, 1.3::rim light::',
                  character_prompts: [
                    { name: '女主', prompt: 'girl, on knees, arched back, looking back' },
                    { name: '男主', prompt: 'boy, standing behind' }
                  ],
                  negative_prompt: '-1.5::multiple views::'
                }),
                '/JSON/'
              ].join('\n')
            }
          }
        ]
      };
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(url, options);
  };

  try {
    const extractor = new LLMExtractor({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.test.com/v1'
    });

    const sceneDesc = {
      scene_idx: 1,
      trigger_sentence: '他在床榻上从背后抱住她进行后入交合。',
      nsfw_rating: 'nsfw_explicit',
      sex_position: '后入',
      visual_description: '床榻上，男子从背后抱住女子腰身进行后入交合。',
      core_action: '后入交合',
      characters: [
        { name: '女主', appearance: '黑发少女' },
        { name: '男主', appearance: '黑发少年' }
      ]
    };

    let loggedReference = false;
    await extractor.generateScenePromptAdvanced(sceneDesc, [], 'deepseek-chat', (msg) => {
      if (msg.includes('真机参考检索')) loggedReference = true;
    });

    assert.ok(capturedPayload, 'Payload should be captured');
    const userContent = capturedPayload.messages.find(m => m.role === 'user')?.content || '';
    assert.match(userContent, /【本地精选真机参考范例（Few-Shot 构图与标签参考）】/);
    assert.match(userContent, /• 范例 1/);
    assert.equal(loggedReference, true, 'Should log reference retrieval progress');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

