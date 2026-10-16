import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const escapeXml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
export function wrapText(text, fontSize, maxWidth) {
  const result = [];
  for (const paragraph of text.split('\n')) {
    let line = ''; let width = 0;
    for (const character of paragraph) {
      const unit = /[\u2e80-\uffef]/u.test(character) ? fontSize : fontSize * 0.65;
      if (line && width + unit > maxWidth) {
        if (/^[，。！？；：、）》】」』]$/.test(character) && [...line].length > 1) {
          const last = [...line].at(-1);
          result.push([...line].slice(0, -1).join(''));
          line = last + character; width = unit * 2;
        } else { result.push(line); line = character; width = unit; }
      } else { line += character; width += unit; }
    }
    result.push(line);
  }
  return result;
}

// Gutter lettering deliberately keeps the artwork unobscured. Speaker anchors remain in the manifest.
export async function composeComic({ episode, approved, outputDir, inputHash }) {
  const { width, fontSize, sliceHeight } = episode.layout;
  if (fontSize * 360 / width < 12) throw new Error('字号在手机宽度下小于 12px，请增大字号');
  await fs.mkdir(outputDir, { recursive: true });
  const fragments = [];
  const blocks = [];
  let y = 36;
  for (const item of approved) {
    const { panel, candidate, imagePath, decision } = item;
    const plan = panel.plan;
    y += plan.gapBefore;
    for (const dialogue of plan.dialogue) {
      const label = dialogue.type === 'narration' ? '' : `${dialogue.speakerId}：`;
      const lines = wrapText(label + dialogue.text, fontSize, width - 128);
      const height = Math.ceil(lines.length * fontSize * 1.45 + 56);
      const shape = `<rect x="32" y="${y}" width="${width - 64}" height="${height}" rx="${dialogue.type === 'narration' ? 4 : 28}" fill="${dialogue.type === 'narration' ? '#f0ebe2' : '#fff'}" stroke="#292723" stroke-width="2"/>`;
      const letters = lines.map((line, i) => `<text x="64" y="${y + 32 + fontSize + i * fontSize * 1.45}" font-size="${fontSize}" font-family="Microsoft YaHei,Noto Sans CJK SC,sans-serif" fill="#181713">${escapeXml(line)}</text>`).join('');
      fragments.push(shape + letters);
      blocks.push({ type: 'dialogue', panelId: panel.panelId, dialogueId: dialogue.dialogueId, text: dialogue.text,
        speakerId: dialogue.speakerId || '', speakerAnchor: decision.speakerAnchors[dialogue.speakerId] || null,
        bounds: [32, y, width - 64, height], placement: 'gutter-before-panel' });
      y += height + 24;
    }
    const bytes = await fs.readFile(imagePath);
    if (digest(bytes) !== candidate.imageSha256) throw new Error('批准图片的校验值已变化');
    const resized = await sharp(bytes).resize({ width: width - 64 }).png().toBuffer();
    const meta = await sharp(resized).metadata();
    fragments.push(`<image x="32" y="${y}" width="${meta.width}" height="${meta.height}" href="data:image/png;base64,${resized.toString('base64')}"/>`);
    fragments.push(`<rect x="32" y="${y}" width="${meta.width}" height="${meta.height}" fill="none" stroke="#292723" stroke-width="2"/>`);
    blocks.push({ type: 'panel', panelId: panel.panelId, candidateId: candidate.candidateId,
      imageSha256: candidate.imageSha256, bounds: [32, y, meta.width, meta.height] });
    y += meta.height + plan.gapAfter;
    for (const sfx of plan.sfx) {
      const lines = wrapText(sfx, fontSize, width - 128);
      const sfxTop = y;
      for (const line of lines) {
        fragments.push(`<text x="64" y="${y + fontSize}" font-size="${fontSize}" font-family="Microsoft YaHei,Noto Sans CJK SC,sans-serif" font-weight="bold">${escapeXml(line)}</text>`);
        y += Math.ceil(fontSize * 1.45);
      }
      blocks.push({ type: 'sfx', panelId: panel.panelId, text: sfx, bounds: [64, sfxTop, width - 128, y - sfxTop] });
      y += 24;
    }
  }
  const totalHeight = Math.ceil(y + 36);
  if (totalHeight > 300000) throw new Error('EP 超过 300000px，请拆分成多话');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}"><rect width="100%" height="100%" fill="#fffdf8"/>${fragments.join('')}</svg>`;
  await fs.writeFile(path.join(outputDir, 'master.svg'), svg, 'utf8');
  const slices = [];
  // Render each viewport, rather than allocate the entire episode as one unbounded bitmap.
  for (let top = 0, i = 1; top < totalHeight; i++) {
    let bottom = Math.min(top + sliceHeight, totalHeight);
    const crossing = blocks.find(b => b.type !== 'panel' && b.bounds[1] < bottom && b.bounds[1] + b.bounds[3] > bottom);
    if (crossing) {
      if (crossing.bounds[3] > sliceHeight) throw new Error('对白或拟声超过单张切片高度，请缩短文字或增大切片高度');
      bottom = crossing.bounds[1] > top ? crossing.bounds[1] : crossing.bounds[1] + crossing.bounds[3];
    }
    const height = Math.ceil(bottom - top);
    const sliceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 ${top} ${width} ${height}"><rect x="0" y="${top}" width="${width}" height="${height}" fill="#fffdf8"/>${fragments.join('')}</svg>`;
    const filename = `slice-${String(i).padStart(3, '0')}.png`;
    const bytes = await sharp(Buffer.from(sliceSvg), { limitInputPixels: width * sliceHeight + 1 }).png().toBuffer();
    await fs.writeFile(path.join(outputDir, filename), bytes);
    slices.push({ path: filename, sha256: digest(bytes), top, width, height });
    top += height;
  }
  const title = escapeXml(episode.title);
  await fs.writeFile(path.join(outputDir, 'preview.html'), `<!doctype html><html lang="${escapeXml(episode.language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#e9e5dd;color:#24221e;font-family:serif}header{padding:24px;text-align:center}main{max-width:${width}px;margin:auto;background:#fffdf8}img{display:block;width:100%;height:auto}</style><header><h1>${title}</h1><p>排版预览 · 待人工终审</p></header><main>${slices.map(s => `<img src="${s.path}" alt="${title} 条漫切片 ${s.path}">`).join('')}</main></html>`, 'utf8');
  const layout = { schemaVersion: 'nai-comic-layout/1.0', inputHash, width, height: totalHeight, fontSize, blocks, slices, status: 'LAYOUT_REVIEW_REQUIRED' };
  await fs.writeFile(path.join(outputDir, 'layout.json'), JSON.stringify(layout, null, 2));
  const files = ['master.svg', 'preview.html', 'layout.json', ...slices.map(s => s.path)];
  const checksums = {};
  for (const file of files) checksums[file] = digest(await fs.readFile(path.join(outputDir, file)));
  return { layout, checksums };
}

export async function exportComic({ episode, approved, assembly, assemblyDir, outputPath }) {
  const zip = new JSZip();
  const manifest = { schemaVersion: 'nai-comic-handoff/1.0', episodeId: episode.episodeId,
    title: episode.title, language: episode.language, panelOrder: episode.panelOrder,
    inputHash: assembly.inputHash, layoutReview: assembly.review, files: {},
    productionBackend: 'NovelAI-Illustrator', externalSkillImportRequired: true };
  const add = (name, bytes) => { zip.file(name, bytes); manifest.files[name] = digest(bytes); };
  add('episode.json', Buffer.from(JSON.stringify(episode, null, 2)));
  for (const item of approved) {
    const bytes = await fs.readFile(item.imagePath);
    if (digest(bytes) !== item.candidate.imageSha256) throw new Error('批准图片发生变化');
    add(`panels/${item.panel.panelId}/${item.candidate.candidateId}.png`, bytes);
    add(`panels/${item.panel.panelId}/evidence.json`, Buffer.from(JSON.stringify({
      candidate: item.candidate, qc: item.candidate.qc, humanApproval: item.decision,
      plannedEntryState: item.entryState, approvedExitState: item.exitState
    }, null, 2)));
  }
  for (const [filename, checksum] of Object.entries(assembly.checksums)) {
    const bytes = await fs.readFile(path.join(assemblyDir, filename));
    if (digest(bytes) !== checksum) throw new Error('排版文件发生变化，请重新组装和终审');
    add(`layout/${filename}`, bytes);
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(outputPath, bytes, { flag: 'wx' });
  return { imageSha256: digest(bytes), bytes: bytes.length, manifest };
}
