import fs from 'fs';

const data = JSON.parse(fs.readFileSync('docs/suozhang-regular.json', 'utf8'));
const entries = Object.values(data.entries);

function printSamples(filterFn, title, max = 5) {
  console.log(`\n==================== ${title} ====================`);
  const matched = entries.filter(filterFn);
  console.log(`Total matched: ${matched.length}`);
  for (let i = 0; i < Math.min(max, matched.length); i++) {
    const e = matched[i];
    console.log(`\n--- [${e.title}] (${e.path ? e.path.join(' / ') : ''}) ---`);
    console.log(`Tags: ${e.tags}`);
    if (e.characterPrompts && e.characterPrompts.length > 0) {
      console.log('Character Prompts:');
      for (const cp of e.characterPrompts) {
        console.log(`  [${cp.label}]: ${cp.prompt}`);
      }
    }
  }
}

printSamples(e => e.path && e.path.includes('质量词'), '质量词与起手式', 6);
printSamples(e => e.path && e.path.includes('视角与打光'), '视角与打光', 6);
printSamples(e => e.path && e.path.includes('编纂者常用画师组'), '常用画师组', 6);
printSamples(e => e.path && e.path[0] === '各种风格', '各种画风与艺术风格', 6);
