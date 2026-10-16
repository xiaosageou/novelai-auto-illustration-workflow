import https from 'https';
import fs from 'fs';

const url = 'https://novelai.quicktagcloud.com/assets/data-source.js';

https.get(url, (res) => {
  let js = '';
  res.on('data', chunk => js += chunk);
  res.on('end', () => {
    console.log('data-source.js size:', js.length);
    fs.writeFileSync('docs/data-source.js', js, 'utf8');
    console.log('Snippet of data-source.js:');
    console.log(js.slice(0, 1500));
  });
}).on('error', err => console.error(err));
