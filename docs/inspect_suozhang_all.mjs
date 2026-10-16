import https from 'https';
import fs from 'fs';

const baseUrl = 'https://assets.quicktagcloud.com/data/releases/r-05de54c4d3a577be5380/';

async function inspectCodex(name) {
  return new Promise((resolve, reject) => {
    https.get(`${baseUrl}${name}.json`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const entries = parsed.entries || {};
          console.log(`[${name}] Title: ${parsed.title}, Total entries: ${Object.keys(entries).length}, Size: ${data.length} bytes`);
          resolve({ name, parsed, count: Object.keys(entries).length });
        } catch(e) {
          console.error(`Error parsing ${name}:`, e.message);
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  await inspectCodex('suozhang');
  await inspectCodex('suozhang_nai5');
  await inspectCodex('suozhang_nai5_r18');
  await inspectCodex('suozhang_r18');
}

run();
