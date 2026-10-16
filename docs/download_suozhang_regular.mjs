import https from 'https';
import fs from 'fs';

const url = 'https://assets.quicktagcloud.com/data/releases/r-05de54c4d3a577be5380/suozhang.json';

https.get(url, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    fs.writeFileSync('docs/suozhang-regular.json', data, 'utf8');
    const parsed = JSON.parse(data);
    const entries = parsed.entries || {};
    console.log('Saved suozhang-regular.json, total entries:', Object.keys(entries).length);
    
    let withImage = 0;
    const catMap = {};
    const sampleImages = [];

    for (const [id, e] of Object.entries(entries)) {
      if (e.image) {
        withImage++;
        if (sampleImages.length < 5) {
          sampleImages.push({ id, title: e.title, image: e.image });
        }
      }
      const cat = e.path ? e.path[0] : (e.category || '未分类');
      catMap[cat] = (catMap[cat] || 0) + 1;
    }

    console.log('Entries with image:', withImage, 'Total entries:', Object.keys(entries).length);
    console.log('Top categories:', catMap);
    console.log('Sample images:', sampleImages);
  });
}).on('error', err => console.error(err));
