import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  LLMExtractor,
  disableLlmRateLimiterForTests,
  sanitizeCharacterDnaEntry,
  findProxyAssignmentIssues,
  applyProxyAssignmentFixes
} from '../services/llm-extractor.js';

disableLlmRateLimiterForTests();

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function jsonResponse(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('脸模：sanitize 解析并规范 proxy_character.gender 与 danbooru_tag', () => {
  const entry = sanitizeCharacterDnaEntry({
    name: '张三',
    gender: 'man',
    proxy_character: {
      danbooru_tag: 'Gojo Satoru',
      gender: 'MALE',
      character_name_cn: '五条悟',
      series: '咒术回战',
      reason: '白发高个',
      suppress_tags: 'blindfold, jujutsu_uniform'
    },
    tags: 'white hair, blue eyes',
    features: {},
    confidence: 0.9
  });
  assert.equal(entry.proxy_character.danbooru_tag, 'gojo_satoru');
  assert.equal(entry.proxy_character.gender, 'male');
  assert.deepEqual(entry.proxy_character.suppress_tags, ['blindfold', 'jujutsu_uniform']);
});

test('脸模校验：识别重复绑定、已知库冲突、性别错配与本人沿用', () => {
  const chars = [
    { name: '甲', gender: 'woman', proxy_character: { danbooru_tag: 'frieren', gender: 'female' } },
    { name: '乙', gender: 'man', proxy_character: { danbooru_tag: 'frieren', gender: 'female' } },
    { name: '丙', gender: 'man', proxy_character: { danbooru_tag: 'rem_(re:zero)', gender: 'female' } }
  ];
  const known = { 丁: { aliases: [], proxy_character: { danbooru_tag: 'yor_forger' } } };
  const issues = findProxyAssignmentIssues(chars, known);

  const dup = issues.find(i => i.type === 'duplicate');
  assert.ok(dup && dup.tag === 'frieren', '必须识别批内重复绑定');
  const gender = issues.find(i => i.type === 'gender_mismatch');
  assert.ok(gender && gender.charName === '乙', '必须识别男性角色绑女性脸模');
  assert.ok(!issues.some(i => i.type === 'conflict_known'), '不同 tag 与已知库不冲突');

  // 本人沿用已知库脸模（含别名命中）不算违规
  assert.equal(findProxyAssignmentIssues(
    [{ name: '丁', aliases: [], proxy_character: { danbooru_tag: 'yor_forger' } }],
    known
  ).length, 0);
  assert.equal(findProxyAssignmentIssues(
    [{ name: '丁的 alias', aliases: ['丁'], proxy_character: { danbooru_tag: 'yor_forger' } }],
    known
  ).length, 0);

  // 与已知库其他角色冲突
  const conflict = findProxyAssignmentIssues(
    [{ name: '戊', gender: 'woman', proxy_character: { danbooru_tag: 'yor_forger', gender: 'female' } }],
    known
  );
  assert.ok(conflict.some(i => i.type === 'conflict_known'), '必须识别改配已知角色的脸模');
});

test('脸模兜底：性别错配解绑，重复绑定择优保留，已知库冲突解绑新条目', () => {
  const chars = [
    { name: '乙', gender: 'man', confidence: 0.9, proxy_character: { danbooru_tag: 'frieren', gender: 'female' } },
    { name: '甲', gender: 'woman', confidence: 0.6, proxy_character: { danbooru_tag: 'frieren', gender: 'female' } },
    { name: '丙', gender: 'woman', confidence: 0.8, proxy_character: { danbooru_tag: 'gojo_satoru', gender: 'male' } }
  ];
  const fixes = applyProxyAssignmentFixes(chars, {});
  assert.equal(fixes, 2, '两处性别错配各解除 1 处');
  assert.equal(chars[0].proxy_character, null, '男性绑女性脸模 → 解绑');
  assert.ok(chars[1].proxy_character, '女性保留 frieren');
  assert.equal(chars[2].proxy_character, null, '女性绑男性脸模 → 解绑');

  const pair = [
    { name: 'A', gender: 'woman', confidence: 0.5, proxy_character: { danbooru_tag: 'frieren', gender: 'female' } },
    { name: 'B', gender: 'woman', confidence: 0.8, proxy_character: { danbooru_tag: 'frieren', gender: 'female' } }
  ];
  assert.equal(applyProxyAssignmentFixes(pair, {}), 1);
  assert.equal(pair[0].proxy_character, null, 'confidence 低者解除');
  assert.equal(pair[1].proxy_character.danbooru_tag, 'frieren');

  const knownChars = [{ name: '戊', gender: 'woman', proxy_character: { danbooru_tag: 'yor_forger', gender: 'female' } }];
  assert.equal(applyProxyAssignmentFixes(knownChars, { 丁: { aliases: [], proxy_character: { danbooru_tag: 'yor_forger' } } }), 1);
  assert.equal(knownChars[0].proxy_character, null, '改配已知角色的脸模 → 解绑');
});

test('角色 DNA：脸模重复触发带修正令重试，修正后通过', async () => {
  let calls = 0;
  const bodies = [];
  const bad = JSON.stringify([
    { name: '甲', gender: 'woman', proxy_character: { danbooru_tag: 'frieren', gender: 'female' }, confidence: 0.7 },
    { name: '乙', gender: 'woman', proxy_character: { danbooru_tag: 'frieren', gender: 'female' }, confidence: 0.6 }
  ]);
  const good = JSON.stringify([
    { name: '甲', gender: 'woman', proxy_character: { danbooru_tag: 'frieren', gender: 'female' }, confidence: 0.7 },
    { name: '乙', gender: 'woman', proxy_character: { danbooru_tag: 'fern_(frieren)', gender: 'female' }, confidence: 0.6 }
  ]);

  const { server, port } = await startServer((req, res) => {
    calls += 1;
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      bodies.push(raw);
      jsonResponse(res, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: calls === 1 ? bad : good } }] });
    });
  });

  try {
    const extractor = new LLMExtractor({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false,
      retryDelayMs: 0
    });
    const result = await extractor.extractCharacterDNA('测试正文', 'test-model', { sourceChapters: ['第1章'] });
    assert.equal(calls, 2, '重复脸模必须触发一次重试');
    assert.ok(bodies[1].includes('同人脸模修正令'), '第二轮请求必须携带修正令');
    assert.ok(bodies[1].includes('frieren'), '修正令必须点名冲突脸模');
    const tags = result.map(c => c.proxy_character?.danbooru_tag).filter(Boolean);
    assert.equal(new Set(tags).size, tags.length, '修正后全书脸模不得重复');
  } finally {
    server.close();
  }
});

test('角色 DNA：脸模违规持续到最后一轮时执行确定性去重兜底', async () => {
  let calls = 0;
  const bad = JSON.stringify([
    { name: '甲', gender: 'woman', proxy_character: { danbooru_tag: 'frieren', gender: 'female' }, confidence: 0.7 },
    { name: '乙', gender: 'woman', proxy_character: { danbooru_tag: 'frieren', gender: 'female' }, confidence: 0.6 }
  ]);

  const { server, port } = await startServer((req, res) => {
    calls += 1;
    jsonResponse(res, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: bad } }] });
  });

  try {
    const extractor = new LLMExtractor({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false,
      retryDelayMs: 0
    });
    const result = await extractor.extractCharacterDNA('测试正文', 'test-model', { sourceChapters: ['第1章'] });
    assert.equal(calls, 3, '违规持续时应重试满 maxRetries 轮');
    const kept = result.filter(c => c.proxy_character);
    assert.equal(kept.length, 1, '兜底后只保留一条绑定');
    assert.equal(kept[0].name, '甲', 'confidence 高者保留');
    assert.equal(result.find(c => c.name === '乙').proxy_character, null);
  } finally {
    server.close();
  }
});
