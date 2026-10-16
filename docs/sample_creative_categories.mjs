import fs from 'fs';

const data = JSON.parse(fs.readFileSync('docs/suozhang-regular.json', 'utf8'));
const entries = Object.values(data.entries);

function sampleSubcat(prefix, title, max = 3) {
  console.log(`\n==================== ${title} ====================`);
  const matched = entries.filter(e => e.path && e.path.join('/').startsWith(prefix));
  console.log(`Count: ${matched.length}`);
  for (let i = 0; i < Math.min(max, matched.length); i++) {
    const e = matched[i];
    console.log(`- [${e.title}] (${e.path.join('/')})`);
    console.log(`  Tags: ${e.tags.slice(0, 200)}...`);
    if (e.characterPrompts && e.characterPrompts.length > 0) {
      console.log(`  Chars: ${e.characterPrompts.map(c => `[${c.label}]: ${c.prompt.slice(0, 100)}`).join(' | ')}`);
    }
  }
}

sampleSubcat('各式服装/幻想人物服饰', '幻想人物服饰 (科幻/奇幻/魔法)');
sampleSubcat('各式服装/民族特色服饰', '民族特色服饰 (国风/和风/中东)');
sampleSubcat('人外种族/人工造物', '人外种族 - 人工造物 (机娘/人偶/仿生)');
sampleSubcat('人外种族/西幻魔物', '人外种族 - 西幻魔物 (恶魔/龙娘/史莱姆/拉米亚)');
sampleSubcat('各式场景/场景/战斗华丽', '各式场景 - 战斗华丽 (特效/光影/动态)');
sampleSubcat('各式场景/场景/日常生活', '各式场景 - 日常生活 (生活氛围/室内环境)');
sampleSubcat('各式场景/场景/多人互动', '各式场景 - 多人互动 (双人/群像构图)');
