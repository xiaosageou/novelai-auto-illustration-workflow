import https from 'https';
import fs from 'fs';

const url = 'https://novelai.quicktagcloud.com/assets/app.js';

https.get(url, (res) => {
  let js = '';
  res.on('data', chunk => js += chunk);
  res.on('end', () => {
    console.log('app.js size:', js.length);
    fs.writeFileSync('docs/app.js', js, 'utf8');

    // Search for suozhang, releases, json, api endpoints
    const urls = [...new Set(js.match(/https?:\/\/[^\s"'`<>]+(?:\.json|releases[^\s"'`<>]*)/g) || [])];
    console.log('URLs in app.js:', urls);

    const suozhang = [...new Set(js.match(/[a-zA-Z0-9_\-\/]*suozhang[a-zA-Z0-9_\-\/]*/gi) || [])];
    console.log('suozhang in app.js:', suozhang);

    // Look for data/manifest or releases
    const dataMatches = [...new Set(js.match(/\/data\/[^\s"'`]+/g) || [])];
    console.log('data matches:', dataMatches);

    // Look for codex definition or list of codexes
    const codexes = [...new Set(js.match(/name\s*:\s*["'][^"']+["']\s*,\s*id\s*:\s*["'][^"']+["']/g) || [])];
    console.log('codexes samples:', codexes.slice(0, 10));
  });
}).on('error', err => console.error(err));
