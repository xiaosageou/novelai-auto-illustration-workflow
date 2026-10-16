import fs from 'fs';

function analyzeComposition() {
  const cs = JSON.parse(fs.readFileSync('docs/composition_style.json', 'utf8'));
  console.log('=== composition_style (构图风格) ===');
  const entries = Object.values(cs.entries);
  console.log('Total entries:', entries.length);
  for (const e of entries.slice(0, 15)) {
    console.log(`- [${e.title}] Tags: ${e.tags}`);
  }

  const raven = JSON.parse(fs.readFileSync('docs/raven_composition.json', 'utf8'));
  console.log('\n=== raven_composition (渡鸦的构图鉴) ===');
  const rEntries = Object.values(raven.entries);
  console.log('Total entries:', rEntries.length);
  const rPaths = {};
  for (const e of rEntries) {
    const p = e.path ? e.path.slice(0, 2).join(' / ') : '未分类';
    rPaths[p] = (rPaths[p] || 0) + 1;
  }
  console.log('Top categories in raven_composition:');
  for (const [k, v] of Object.entries(rPaths).sort((a,b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${k}: ${v}`);
  }
}

analyzeComposition();
