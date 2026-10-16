import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

const data = JSON.parse(fs.readFileSync('docs/suozhang-regular.json', 'utf8'));
const entries = Object.values(data.entries).filter(e => e.image);
console.log(`Total entries with images: ${entries.length}`);

const outDir = path.join(process.cwd(), 'docs', 'suozhang_images');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Download function supporting HTTP CONNECT proxy (127.0.0.1:10808) or direct fallback
function downloadImage(imgName, proxyHost = '127.0.0.1', proxyPort = 10808) {
  const filePath = path.join(outDir, imgName);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
    return Promise.resolve({ imgName, status: 'exists' });
  }

  return new Promise((resolve) => {
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: 'assets.quicktagcloud.com:443',
      timeout: 10000,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        return resolve({ imgName, status: 'proxy_failed' });
      }

      const client = https.get({
        path: `/images/suozhang/${imgName}`,
        socket: socket,
        agent: false,
        headers: { 'Host': 'assets.quicktagcloud.com', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      }, (imgRes) => {
        if (imgRes.statusCode !== 200) {
          return resolve({ imgName, status: `http_${imgRes.statusCode}` });
        }
        const fileStream = fs.createWriteStream(filePath);
        imgRes.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve({ imgName, status: 'ok', size: fs.statSync(filePath).size });
        });
        fileStream.on('error', err => {
          fs.unlink(filePath, () => {});
          resolve({ imgName, status: 'write_error', error: err.message });
        });
      });

      client.on('error', err => resolve({ imgName, status: 'client_error', error: err.message }));
      client.on('timeout', () => { client.destroy(); resolve({ imgName, status: 'timeout' }); });
    });

    req.on('error', err => resolve({ imgName, status: 'connect_error', error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ imgName, status: 'req_timeout' }); });
    req.end();
  });
}

async function testBatch() {
  const sample = entries.slice(0, 10);
  console.log(`Testing download of ${sample.length} images...`);
  const t0 = Date.now();
  const results = await Promise.all(sample.map(e => downloadImage(e.image)));
  const cost = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Finished test batch in ${cost}s:`, results);
}

testBatch();
