import https from 'https';
import fs from 'fs';

const url = 'https://novelai.quicktagcloud.com/assets/app/data.js';

https.get(url, (res) => {
  let js = '';
  res.on('data', chunk => js += chunk);
  res.on('end', () => {
    console.log('data.js size:', js.length);
    fs.writeFileSync('docs/data.js', js, 'utf8');

    // Print contents or snippets
    console.log('Snippet of data.js:');
    console.log(js.slice(0, 1500));
  });
}).on('error', err => console.error(err));
