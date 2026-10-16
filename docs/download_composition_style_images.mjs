import fs from 'fs';
import path from 'path';
import https from 'https';

const outDir = path.join(process.cwd(), 'docs', 'composition_style_images');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const cs = JSON.parse(fs.readFileSync('docs/composition_style.json', 'utf8'));
const entries = Object.values(cs.entries).filter(e => e.image);
console.log(`Downloading ${entries.length} images for composition_style...`);

const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

async function downloadOne(e) {
  const filePath = path.join(outDir, e.image);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) return 'exists';
  return new Promise(resolve => {
    https.get({
      hostname: 'assets.quicktagcloud.com',
      port: 443,
      path: `/images/composition_style/${e.image}`,
      agent,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    }, res => {
      if (res.statusCode !== 200) return resolve(`http_${res.statusCode}`);
      const ws = fs.createWriteStream(filePath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve('ok'); });
      ws.on('error', () => resolve('write_err'));
    }).on('error', () => resolve('net_err'));
  });
}

async function run() {
  const res = await Promise.all(entries.map(downloadOne));
  console.log(`Finished composition_style: ${res.filter(x => x === 'ok' || x === 'exists').length}/${entries.length}`);
}

run();
