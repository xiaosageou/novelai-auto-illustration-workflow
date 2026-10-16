import fs from 'fs';
import path from 'path';

const base = path.join(process.cwd(), 'projects');
const dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory() && !d.startsWith('.'));

for (const d of dirs) {
  const p = path.join(base, d);
  const items = fs.readdirSync(p);
  console.log(`[${d}]:`, items);
}
