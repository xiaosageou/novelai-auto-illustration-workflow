import https from 'https';

const url = 'https://assets.quicktagcloud.com/data/releases/r-05de54c4d3a577be5380/codexes.json';

https.get(url, res => {
  let s = '';
  res.on('data', c => s += c);
  res.on('end', () => {
    const list = JSON.parse(s);
    console.log('Total codexes:', list.length);
    for (const c of list) {
      console.log(JSON.stringify({
        id: c.id,
        title: c.title,
        author: c.author,
        nsfw: c.nsfw,
        dataFile: c.dataFile || c.dataUrl || c.file || c.id,
        entriesCount: c.entriesCount,
        description: (c.description || '').slice(0, 50)
      }));
    }
  });
}).on('error', err => console.error(err));
