import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LLMExtractor, disableLlmRateLimiterForTests } from '../services/llm-extractor.js';

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

function emptyChoice() {
  return { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] };
}

test('角色 DNA：空内容连续失败 3 次后抛错，不再把失败当成 0 角色', async () => {
  let calls = 0;
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    jsonResponse(res, emptyChoice());
  });

  try {
    const extractor = new LLMExtractor({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      streamEnabled: false,
      rateLimitEnabled: false,
      retryDelayMs: 0
    });

    await assert.rejects(
      () => extractor.extractCharacterDNA('测试正文', 'test-model', { sourceChapters: ['第1章'] }),
      /连续 3 次失败|返回内容为空/
    );
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test('角色 DNA：前两次失败，第 3 次成功返回结果', async () => {
  let calls = 0;
  const valid = JSON.stringify([
    { name: '张三', gender: 'man', role_type: '主角', tags: 'short black hair, black eyes', features: {}, confidence: 0.8 }
  ]);

  const { server, port } = await startServer((req, res) => {
    calls += 1;
    if (calls < 3) {
      jsonResponse(res, emptyChoice());
      return;
    }
    jsonResponse(res, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: valid } }] });
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
    assert.equal(calls, 3);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '张三');
  } finally {
    server.close();
  }
});
