import fs from 'fs';
import path from 'path';

const base = path.join(process.cwd(), 'projects');
const dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory() && !d.startsWith('.'));

for (const d of dirs) {
  const p = path.join(base, d, 'pipeline_progress.json');
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const chapters = data.completed_chapters || {};
      let totalScenes = 0;
      const scenesList = [];
      for (const [cName, cData] of Object.entries(chapters)) {
        const scenes = cData.scenes || [];
        totalScenes += scenes.length;
        for (const s of scenes) {
          scenesList.push({
            chapter: cName,
            idx: s.scene_idx,
            trigger: s.trigger_sentence,
            desc: s.visual_description,
            chars: s.characters?.map(c => c.name).join(', ')
          });
        }
      }
      console.log(`\nBook: [${d}] -> Total scenes in progress: ${totalScenes}`);
      if (scenesList.length > 0) {
        scenesList.slice(0, 4).forEach((s, i) => {
          console.log(`  Scene ${i+1}: [${s.chapter}] ${s.trigger?.slice(0, 35)} | Desc: ${s.desc?.slice(0, 50)}... | Chars: ${s.chars}`);
        });
      } else {
        // check book.txt size
        const txtPath = path.join(base, d, 'book.txt');
        if (fs.existsSync(txtPath)) {
          console.log(`  (No scenes in pipeline_progress.json, book.txt size: ${fs.statSync(txtPath).size} bytes)`);
        }
      }
    } catch (e) {
      console.log(`Error reading ${d}:`, e.message);
    }
  }
}
