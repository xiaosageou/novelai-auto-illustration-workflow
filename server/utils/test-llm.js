import fs from 'node:fs/promises';
import { readConfig } from './config-store.js';
import { scrubChatPayload } from './age-text-scrubber.js';

async function readStreamedText(res) {
  const raw = await res.text();
  return raw
    .split(/\r?\n/)
    .filter(line => line.trim().startsWith('data:'))
    .map(line => line.replace(/^\s*data:\s*/, '').trim())
    .filter(payload => payload && payload !== '[DONE]')
    .map(payload => {
      try {
        const data = JSON.parse(payload);
        return data.choices?.[0]?.delta?.content || data.choices?.[0]?.message?.content || '';
      } catch {
        return payload;
      }
    })
    .join('');
}

async function test() {
  const config = await readConfig('illustrator_config.json');
  const url = `${config.llm_url.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.llm_key}`
  };

  const payload = {
    model: config.llm_model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello! Please reply in 3 words.' }
    ],
    temperature: 0.4,
    stream: true
    // Removed max_tokens
  };

  console.log('Sending request to:', url);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(scrubChatPayload(payload))
    });
    console.log('Status:', res.status);
    const text = await readStreamedText(res);
    console.log('Streamed response:', text);
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
