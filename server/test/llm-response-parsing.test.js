import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLlmResponseText } from '../services/llm-extractor.js';

test('兼容网关 { data: { choices } } 响应外壳', () => {
  const payload = {
    data: {
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: '收到' } }
      ]
    }
  };
  assert.equal(extractLlmResponseText(payload), '收到');
});

test('兼容 reasoning 字段（非 reasoning_content）', () => {
  const payload = {
    choices: [
      { message: { content: 'ok', reasoning: '先想一下' } }
    ]
  };
  const output = extractLlmResponseText(payload);
  assert.match(output, /\/thinking\/\n先想一下\n\/thinking\/\nok/);
});

test('正文为空但 reasoning 含 JSON 时回退到 reasoning', () => {
  const payload = {
    data: {
      choices: [
        { message: { content: '', reasoning: '草稿 {"name":"测试"}' } }
      ]
    }
  };
  assert.match(extractLlmResponseText(payload), /草稿 \{"name":"测试"\}/);
});

test('SSE 流中 reasoning 分片不污染正文，content 分片正常拼接', () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning":"think"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');
  assert.equal(extractLlmResponseText(sse), 'ok');
});
