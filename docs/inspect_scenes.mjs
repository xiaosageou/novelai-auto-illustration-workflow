import fs from 'fs';
import path from 'path';

const base = path.join(process.cwd(), 'projects');
const dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory() && !d.startsWith('.'));

for (const d of dirs) {
  const p = path.join(base, d);
  const files = fs.readdirSync(p).filter(f => f.endsWith('.json') && f !== 'project.json');
  console.log(`\n================ Book: [${d}] ================`);
  for (const f of files) {
    try {
      const chapter = JSON.parse(fs.readFileSync(path.join(p, f), 'utf8'));
      const scenes = chapter.scenes || [];
      console.log(`Chapter: ${f}, Title: ${chapter.title || 'Untitled'}, Scenes count: ${scenes.length}`);
      if (scenes.length > 0) {
        for (let i = 0; i < Math.min(3, scenes.length); i++) {
          const s = scenes[i];
          console.log(`  Scene ${i+1}: ID=${s.id}, Text snippet: ${(s.text || s.description || s.content || '').slice(0, 60)}...`);
          if (s.prompt || s.nai_prompt || s.prompts) {
            console.log(`    Existing prompt: ${(s.prompt || s.nai_prompt || JSON.stringify(s.prompts)).slice(0, 80)}`);
          }
        }
      }
    } catch (e) {
      console.error(`Error reading ${f}:`, e.message);
    }
  }
}
