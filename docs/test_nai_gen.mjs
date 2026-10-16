import fs from 'fs';
import path from 'path';
import { ProxyAgent, setGlobalDispatcher } from '../server/node_modules/undici/index.js';
import { NovelAIClient } from '../server/services/nai-client.js';

const config = JSON.parse(fs.readFileSync('illustrator_config.json', 'utf8'));

// Apply proxy
if (config.proxy_url) {
  setGlobalDispatcher(new ProxyAgent(config.proxy_url));
  console.log(`[Test] Proxy enabled: ${config.proxy_url}`);
}

const client = new NovelAIClient({
  token: config.nai_token,
  baseUrl: config.nai_url || 'https://image.novelai.net'
});

async function testGen() {
  console.log('[Test] Calling NovelAI generateImage...');
  const prompt = '1girl, solo, snow, white cloak, holding sword, floating snowflakes, cinematic lighting, 1.05::artist:yoneyama mai::, year 2025, masterpiece, best quality';
  try {
    const result = await client.generateImage(prompt, {
      model: config.nai_model || 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      steps: 28,
      scale: 6.0,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras'
    });

    console.log('[Test] Generation result keys:', Object.keys(result));
    if (result.image) {
      console.log('[Test] Image data length:', result.image.length);
      const outPath = path.join(process.cwd(), 'docs', 'test_gen_result.png');
      const base64Data = result.image.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(outPath, Buffer.from(base64Data, 'base64'));
      console.log(`[Test] Saved test image to: ${outPath}, size: ${fs.statSync(outPath).size} bytes`);
    }
  } catch (err) {
    console.error('[Test] Error generating image:', err);
  }
}

testGen();
