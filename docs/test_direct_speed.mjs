import fs from 'fs';
import path from 'path';
import https from 'https';

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  timeout: 10000,
});

const outDir = path.join(process.cwd(), 'docs', 'suozhang_images');

function downloadDirect(imgName) {
  const filePath = path.join(outDir, imgName);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
    return Promise.resolve({ imgName, status: 'exists' });
  }

  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'assets.quicktagcloud.com',
      port: 443,
      path: `/images/suozhang/${imgName}`,
      agent: agent,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) {
        return resolve({ imgName, status: `http_${res.statusCode}` });
      }
      const fileStream = fs.createWriteStream(filePath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve({ imgName, status: 'ok', size: fs.statSync(filePath).size });
      });
      fileStream.on('error', err => {
        fs.unlink(filePath, () => {});
        resolve({ imgName, status: 'write_error', error: err.message });
      });
    });

    req.on('error', err => resolve({ imgName, status: 'error', error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ imgName, status: 'timeout' }); });
  });
}

async function testDirect() {
  const data = JSON.parse(fs.readFileSync('docs/suozhang-regular.json', 'utf8'));
  const entries = Object.values(data.entries).filter(e => e.image).slice(10, 30);
  console.log(`Testing direct keep-alive download of ${entries.length} images...`);
  const t0 = Date.now();
  const results = await Promise.all(entries.map(e => downloadDirect(e.image)));
  const cost = ((Date.now() - t0) / 1000).toFixed(2);
  const okCount = results.filter(r => r.status === 'ok').length;
  console.log(`Direct keep-alive: ${okCount}/${entries.length} ok in ${cost}s (${(okCount / cost).toFixed(1)} img/s)`);
}

testDirect();
