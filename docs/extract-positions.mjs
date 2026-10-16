import https from 'https';
import fs from 'fs';

const url = 'https://assets.quicktagcloud.com/data/releases/r-329366c201e6e0b083e1/suozhang_r18.json';
console.log('Downloading suozhang_r18.json...');

https.get(url, (res) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => {
    console.log('Download complete. Parsing JSON...');
    const buffer = Buffer.concat(chunks);
    const parsed = JSON.parse(buffer.toString('utf8'));
    const entries = parsed.entries || {};
    console.log('Total entries in file:', Object.keys(entries).length);

    const results = [];

    for (const [id, e] of Object.entries(entries)) {
      const p = e.path ? e.path.join(' / ') : (e.description || '');
      
      const isTiwei = p.includes('各种体位');
      const isSexScene = p.includes('性交场景');

      if (isTiwei || isSexScene) {
        let category = '各种体位';
        if (isSexScene) {
          category = '性交场景';
        } else if (p.includes('正身位')) {
          category = '正身位';
        } else if (p.includes('站立位')) {
          category = '站立位';
        } else if (p.includes('坐身位')) {
          category = '坐身位';
        } else if (p.includes('后入/背后位') || p.includes('后入') || p.includes('背后位')) {
          category = '后入/背后位';
        } else if (p.includes('火车便当')) {
          category = '正/逆火车便当';
        } else if (p.includes('种付位')) {
          category = '种付位';
        } else if (p.includes('骑乘位')) {
          category = '骑乘位';
        } else if (p.includes('睡奸')) {
          category = '睡奸';
        } else if (p.includes('催眠')) {
          category = '催眠';
        } else {
          category = '体位杂项';
        }

        let fullPrompt = e.tags || '';
        let characterPrompts = [];
        if (Array.isArray(e.characterPrompts) && e.characterPrompts.length > 0) {
          characterPrompts = e.characterPrompts.map(cp => ({
            label: cp.label || '',
            prompt: cp.prompt || ''
          }));
          const cpText = characterPrompts.map(cp => `[${cp.label}]: ${cp.prompt}`).join('\n');
          fullPrompt = fullPrompt ? `${fullPrompt}\n${cpText}` : cpText;
        }

        results.push({
          id: e.id || id,
          title: e.title || '',
          category,
          fullPath: p,
          basePrompt: e.tags || '',
          characterPrompts,
          fullPrompt: fullPrompt.trim(),
          negative: e.negative || '',
          image: e.image ? `https://assets.quicktagcloud.com/images/suozhang_r18/${e.image}` : null,
          imageWidth: e.imageWidth || null,
          imageHeight: e.imageHeight || null
        });
      }
    }

    console.log('Total position entries found:', results.length);

    const grouped = {};
    for (const r of results) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r);
    }

    for (const cat of Object.keys(grouped)) {
      console.log(`- ${cat}: ${grouped[cat].length} entries`);
    }

    // Save full JSON
    const outJsonPath = 'd:/antigravity/nai/docs/suozhang-sex-positions-all.json';
    fs.writeFileSync(outJsonPath, JSON.stringify(results, null, 2), 'utf8');
    console.log('Saved full JSON to:', outJsonPath);

    // Save markdown summary
    let md = '# 所长N4.5色色法典 · 各种体位与性交场景全量提取库\n\n';
    md += `> 数据源: https://novelai.quicktagcloud.com/?c=suozhang (关联法典: suozhang_r18)\n`;
    md += `> 提取时间: ${new Date().toISOString()}\n`;
    md += `> 总词条数: ${results.length} 条\n\n`;

    md += '## 目录概览\n\n';
    for (const cat of Object.keys(grouped)) {
      md += `- [${cat} (${grouped[cat].length}条)](#${encodeURIComponent(cat)})\n`;
    }
    md += '\n---\n\n';

    for (const cat of Object.keys(grouped)) {
      md += `## ${cat} (${grouped[cat].length}条)\n\n`;
      for (const item of grouped[cat]) {
        md += `### ${item.title || item.id}\n`;
        md += `- **ID**: \`${item.id}\`\n`;
        md += `- **路径**: \`${item.fullPath}\`\n`;
        if (item.basePrompt) {
          md += `- **Base Prompt**: \`${item.basePrompt}\`\n`;
        }
        if (item.characterPrompts.length > 0) {
          md += `- **Character Prompts**:\n`;
          for (const cp of item.characterPrompts) {
            md += `  - **${cp.label}**: \`${cp.prompt}\`\n`;
          }
        }
        if (item.negative) {
          md += `- **Negative**: \`${item.negative}\`\n`;
        }
        if (item.image) {
          md += `- **配图**: [查看原图](${item.image})\n`;
        }
        md += '\n';
      }
    }

    const outMdPath = 'd:/antigravity/nai/docs/suozhang-sex-positions-all.md';
    fs.writeFileSync(outMdPath, md, 'utf8');
    console.log('Saved Markdown reference to:', outMdPath);
  });
}).on('error', err => console.error('Download error:', err));
