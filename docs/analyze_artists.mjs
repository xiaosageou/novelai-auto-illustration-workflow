import fs from 'fs';

const artists = JSON.parse(fs.readFileSync('docs/artist_nai45_personal.json', 'utf8'));
const entries = Object.values(artists.entries);
console.log('Total artists:', entries.length);

const pathMap = {};
for (const e of entries) {
  const p = e.path ? e.path.slice(0, 2).join(' / ') : '未分类';
  pathMap[p] = (pathMap[p] || 0) + 1;
}

console.log('Top artist categories:');
for (const [k, v] of Object.entries(pathMap).sort((a,b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${k}: ${v}`);
}

console.log('\nSample artists:');
for (const e of entries.slice(0, 10)) {
  console.log(`- [${e.title}] Tags: ${e.tags} (Path: ${e.path ? e.path.join('/') : ''})`);
}
