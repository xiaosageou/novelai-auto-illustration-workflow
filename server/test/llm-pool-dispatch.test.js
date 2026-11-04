import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LLMConnectionPool } from '../utils/llm-pool.js';
import { postChatCompletionWith429Retry } from '../services/llm-extractor.js';

function startMockServer(handler) {
  const state = { hits: 0 };
  const server = http.createServer(async (req, res) => {
    state.hits += 1;
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch {}
    handler({ req, res, state, payload });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        state,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

const okBody = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] });

test('并发请求按槽位摊到不同模型：A 返 429 时由 B 接住，整体不失败', async () => {
  // A：前 3 次直接 429（模拟单模型被打爆），之后正常
  const a = await startMockServer(({ res, state }) => {
    if (state.hits <= 3) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":"rate limited"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(okBody);
  });
  // B：始终正常
  const b = await startMockServer(({ res }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(okBody);
  });

  const pool = new LLMConnectionPool([
    { id: 'a', label: 'A', baseUrl: a.url, apiKey: 'sk-a', model: 'model-a', rateLimit: { enabled: false, rpm: 3, key: 'preset:a' } },
    { id: 'b', label: 'B', baseUrl: b.url, apiKey: 'sk-b', model: 'model-b', rateLimit: { enabled: false, rpm: 3, key: 'preset:b' } }
  ], { cooldownMs: 1000, hopOn429: true });

  try {
    const requests = Array.from({ length: 6 }, (_, index) => postChatCompletionWith429Retry({
      url: `${a.url}/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-a' },
      payload: { model: 'model-a', messages: [{ role: 'user', content: `scene-${index}` }], stream: false },
      max429Retries: 0,
      initialDelaySeconds: 0,
      logPrefix: '[pool-dispatch-test]',
      pool
    }));

    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(res => res.status), [200, 200, 200, 200, 200, 200]);

    // 两个模型都被用到：单模型不再独自承受全部并发
    assert.ok(a.state.hits > 0, 'A 应收到请求');
    assert.ok(b.state.hits > 0, 'B 应分担部分请求');
    assert.equal(a.state.hits + b.state.hits >= 6, true);

    // 池内没有残留的在飞计数
    const stats = pool.stats();
    assert.equal(stats.slots.every(slot => slot.inflight === 0), true);
    assert.equal(stats.slots.reduce((sum, slot) => sum + slot.served, 0) >= 6, true);
  } finally {
    await a.close();
    await b.close();
  }
});

test('单模型 429 且无其它槽位可换时：重试耗尽后按原语义抛 LLM_429_EXHAUSTED', async () => {
  const a = await startMockServer(({ res }) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end('{"error":"rate limited"}');
  });

  try {
    await assert.rejects(
      () => postChatCompletionWith429Retry({
        url: `${a.url}/chat/completions`,
        headers: { 'Content-Type': 'application/json' },
        payload: { model: 'model-a', messages: [{ role: 'user', content: 'x' }], stream: false },
        max429Retries: 0,
        initialDelaySeconds: 0,
        logPrefix: '[pool-dispatch-test]',
        pool: null
      }),
      error => error.code === 'LLM_429_EXHAUSTED'
    );
  } finally {
    await a.close();
  }
});
