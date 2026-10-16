import fs from 'fs';
import path from 'path';

const base = path.join(process.cwd(), 'projects');
const dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory() && !d.startsWith('.'));

for (const d of dirs) {
  const p = path.join(base, d);
  const files = fs.readdirSync(p);
  const meta = files.includes('project.json') ? JSON.parse(fs.readFileSync(path.join(p, 'project.json'), 'utf8')) : null;
  const chapters = files.filter(f => f.endsWith('.json') && f !== 'project.json');
  console.log(`[${d}] Title: ${meta?.title || d}, Chapters: ${chapters.length}`);
}
