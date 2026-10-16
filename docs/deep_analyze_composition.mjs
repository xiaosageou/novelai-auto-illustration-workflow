import fs from 'fs';

// 1. Analyze composition_style.json structure
const cs = JSON.parse(fs.readFileSync('docs/composition_style.json', 'utf8'));
const csEntries = Object.values(cs.entries);

console.log('=== 1. Composition Style Analysis (64 entries) ===');
const shotTypes = {};
const angleTypes = {};
const lightingTypes = {};
const formulas = [];

for (const e of csEntries) {
  const t = e.tags;
  // match shot types like close-up, medium shot, cowboy shot, wide shot
  const shots = t.match(/(?:close-up|medium shot|cowboy shot|wide shot|full body|extreme close-up)/gi) || [];
  shots.forEach(s => shotTypes[s.toLowerCase()] = (shotTypes[s.toLowerCase()] || 0) + 1);

  // match angles
  const angles = t.match(/(?:from above|from below|from the side|from behind|high angle|low angle|eye-level|three-quarter view|dutch angle|straight-on)/gi) || [];
  angles.forEach(a => angleTypes[a.toLowerCase()] = (angleTypes[a.toLowerCase()] || 0) + 1);

  // match lighting & depth keywords
  const lights = t.match(/(?:rim light|bokeh|light beams|sunlight|golden hour|backlit|dappled|illuminated|cinematic lighting)/gi) || [];
  lights.forEach(l => lightingTypes[l.toLowerCase()] = (lightingTypes[l.toLowerCase()] || 0) + 1);
}

console.log('Shot types in composition_style:', shotTypes);
console.log('Angle types in composition_style:', angleTypes);
console.log('Lighting/Depth keywords in composition_style:', lightingTypes);

// 2. Analyze suozhang-regular.json composition tags
const sz = JSON.parse(fs.readFileSync('docs/suozhang-regular.json', 'utf8'));
const szEntries = Object.values(sz.entries);

const viewEntries = szEntries.filter(e => e.path && e.path.join('/').includes('视角与打光'));
console.log('\n=== 2. Suozhang Perspective & Lighting entries count:', viewEntries.length);
viewEntries.forEach((e, i) => {
  if (i < 20) {
    console.log(`- [${e.title}]: ${e.tags}`);
  }
});

// 3. Search for multi-view suppression and framing tags across suozhang
let multiViewsCount = 0;
let outOfFrameCount = 0;
let dutchCount = 0;
let fisheyeCount = 0;
let foreshorteningCount = 0;
let bokehCount = 0;
let rimLightCount = 0;

for (const e of szEntries) {
  const str = e.tags + ' ' + (e.negative || '');
  if (str.includes('multiple views')) multiViewsCount++;
  if (str.includes('out of frame')) outOfFrameCount++;
  if (str.includes('dutch angle')) dutchCount++;
  if (str.includes('fisheye')) fisheyeCount++;
  if (str.includes('foreshortening')) foreshorteningCount++;
  if (str.includes('bokeh')) bokehCount++;
  if (str.includes('rim light')) rimLightCount++;
}

console.log('\n=== 3. Key composition technique frequencies in Suozhang regular (5702 entries) ===');
console.log({
  multiViewsCount,
  outOfFrameCount,
  dutchCount,
  fisheyeCount,
  foreshorteningCount,
  bokehCount,
  rimLightCount
});
