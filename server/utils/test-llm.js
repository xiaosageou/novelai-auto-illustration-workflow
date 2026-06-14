import fs from 'node:fs/promises';
import path from 'node:path';

async function test() {
  const config = JSON.parse(await fs.readFile('illustrator_config.json', 'utf8'));
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
    temperature: 0.4
    // Removed max_tokens
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
    console.log('Full JSON response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
