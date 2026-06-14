import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { EPUBBuilder, insertIllustrationsAfterParagraphs } from '../services/epub-builder.js';

test('illustrations are inserted after complete paragraphs and support multiple images', () => {
  const content = '第一段正文。\n\n第二段包含触发句，仍然属于完整段落。\n\n第三段正文。';
  const result = insertIllustrationsAfterParagraphs(content, [
    { imageName: 'one.jpg', paragraph: '第二段包含触发句，仍然属于完整段落。' },
    { imageName: 'two.jpg', trigger: '触发句' }
  ]);

  assert.match(
    result,
    /第二段包含触发句，仍然属于完整段落。\n\n\[插图：one\.jpg\]\n\n\n\[插图：two\.jpg\]/
  );
  assert.doesNotMatch(result, /触发句\n.*仍然属于完整段落/);
});

test('EPUB image compression uses high-quality JPEG and emits no filename caption', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-epub-'));
  const outputPath = path.join(tempDir, 'book.epub');
  const png = await sharp({
    create: {
      width: 2200,
      height: 1400,
      channels: 3,
      background: { r: 80, g: 120, b: 190 }
    }
  }).png().toBuffer();

  const builder = new EPUBBuilder('测试书', '测试作者', outputPath);
  const imageName = await builder.addImage('original.png', png);
  builder.addChapter('第一卷', '第一章', `正文段落。\n\n[插图：${imageName}]`);
  await builder.build();

  const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const chapter = await zip.file('OEBPS/chap_1.xhtml').async('string');
  const compressed = await zip.file(`OEBPS/images/${imageName}`).async('nodebuffer');
  const metadata = await sharp(compressed).metadata();

  assert.equal(imageName, 'original.jpg');
  assert.equal(metadata.format, 'jpeg');
  assert.ok(metadata.width <= 1600);
  assert.ok(metadata.height <= 2400);
  assert.match(chapter, /<img src="images\/original\.jpg" alt="" \/>/);
  assert.doesNotMatch(chapter, /original\.jpg<\/div>|章节精美插图|illustration-caption/);
});
