import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';

const outDir = path.join(process.cwd(), 'docs', 'suozhang_images');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const data = JSON.parse(fs.readFileSync('docs/suozhang-regular.json', 'utf8'));
const entries = Object.values(data.entries).filter(e => e.image);
console.log(`[Init] Total entries with images: ${entries.length}`);

// Agents
const directAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 25,
  timeout: 12000,
});

function downloadViaDirect(imgName) {
  const filePath = path.join(outDir, imgName);
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'assets.quicktagcloud.com',
      port: 443,
      path: `/images/suozhang/${imgName}`,
      agent: directAgent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 12000,
    }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const stream = fs.createWriteStream(filePath);
      res.pipe(stream);
      stream.on('finish', () => {
        stream.close();
        resolve(fs.statSync(filePath).size);
      });
      stream.on('error', err => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Direct timeout'));
    });
  });
}

function downloadViaProxy(imgName, host = '127.0.0.1', port = 10808) {
  const filePath = path.join(outDir, imgName);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      method: 'CONNECT',
      path: 'assets.quicktagcloud.com:443',
      timeout: 10000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Proxy tunnel error ${res.statusCode}`));
      }
      const client = https.get({
        path: `/images/suozhang/${imgName}`,
        socket,
        agent: false,
        headers: { 'Host': 'assets.quicktagcloud.com', 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      }, imgRes => {
        if (imgRes.statusCode !== 200) {
          return reject(new Error(`Proxy HTTP ${imgRes.statusCode}`));
        }
        const stream = fs.createWriteStream(filePath);
        imgRes.pipe(stream);
        stream.on('finish', () => {
          stream.close();
          resolve(fs.statSync(filePath).size);
        });
        stream.on('error', err => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
      });
      client.on('error', reject);
      client.on('timeout', () => {
        client.destroy();
        reject(new Error('Proxy client timeout'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Proxy connect timeout'));
    });
    req.end();
  });
}

async function fetchOneWithFallback(imgName) {
  const filePath = path.join(outDir, imgName);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
    return 'skipped';
  }

  // Attempt 1: Direct keepalive
  try {
    await downloadViaDirect(imgName);
    return 'direct';
  } catch (err1) {
    // Attempt 2: Local 10808 proxy
    try {
      await downloadViaProxy(imgName, '127.0.0.1', 10808);
      return 'proxy_10808';
    } catch (err2) {
      // Attempt 3: NAS 7890 proxy
      try {
        await downloadViaProxy(imgName, 'nas', 7890);
        return 'proxy_nas';
      } catch (err3) {
        return 'failed';
      }
    }
  }
}

async function runPool() {
  const CONCURRENCY = 16;
  let cursor = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  const total = entries.length;
  const startTime = Date.now();

  console.log(`[Start] Concurrency: ${CONCURRENCY}, Total targets: ${total}`);

  async function worker(id) {
    while (cursor < total) {
      const idx = cursor++;
      const item = entries[idx];
      const res = await fetchOneWithFallback(item.image);
      done++;
      if (res === 'skipped') skipped++;
      if (res === 'failed') failed++;

      if (done % 100 === 0 || done === total) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = (done / elapsed).toFixed(1);
        const eta = speed > 0 ? (((total - done) / speed) / 60).toFixed(1) : '?';
        console.log(`[Progress] ${done}/${total} (${((done/total)*100).toFixed(1)}%) | Skipped: ${skipped} | Failed: ${failed} | Speed: ${speed} img/s | ETA: ${eta}m`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Complete] All ${total} images processed in ${totalTime}s! Skipped: ${skipped}, Failed: ${failed}`);
}

runPool();
