import https from 'https';
import fs from 'fs';

const baseUrl = 'https://assets.quicktagcloud.com/data/releases/r-05de54c4d3a577be5380/';

async function inspect(codexName) {
  return new Promise((resolve, reject) => {
    https.get(`${baseUrl}${codexName}.json`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const entries = parsed.entries || {};
          const withImg = Object.values(entries).filter(e => e.image).length;
          console.log(`[${codexName}] Title: ${parsed.title}, Entries: ${Object.keys(entries).length}, WithImg: ${withImg}, Size: ${(data.length/1024).toFixed(1)} KB`);
          fs.writeFileSync(`docs/${codexName}.json`, data, 'utf8');
          resolve({ codexName, parsed, count: Object.keys(entries).length });
        } catch (e) {
          console.error(`Error inspecting ${codexName}:`, e.message);
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  await inspect('raven_composition');
  await inspect('composition_style');
  await inspect('artist_nai45_personal');
}

run();
