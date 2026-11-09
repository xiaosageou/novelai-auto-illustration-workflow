import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { EPUBBuilder, insertIllustrationsAfterParagraphs, readEpubImage } from '../services/epub-builder.js';

test('old PNG paths resolve to matching WebP only when PNG is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-epub-path-'));
  try {
    await fs.writeFile(path.join(dir, 'scene.webp'), 'webp');
    let image = await readEpubImage(dir, 'scene.png');
    assert.equal(image.name, 'scene.webp');
    assert.equal(image.data.toString(), 'webp');
    await fs.writeFile(path.join(dir, 'scene.png'), 'png');
    image = await readEpubImage(dir, 'scene.png');
    assert.equal(image.name, 'scene.png');
    assert.equal(image.data.toString(), 'png');
    await assert.rejects(readEpubImage(dir, 'missing.png'), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

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

test('EPUB preserves WebP image bytes and references the correct media type', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-epub-webp-'));
  try {
    const outputPath = path.join(tempDir, 'book.epub');
    const webp = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).webp().toBuffer();
    const builder = new EPUBBuilder('测试书', '测试作者', outputPath);
    const imageName = await builder.addImage('original.webp', webp);
    builder.addChapter('', '第一章', `[插图：${imageName}]`);
    await builder.build();
    const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
    assert.equal(imageName, 'original.webp');
    assert.deepEqual(await zip.file('OEBPS/images/original.webp').async('nodebuffer'), webp);
    assert.match(await zip.file('OEBPS/content.opf').async('string'), /href="images\/original\.webp" media-type="image\/webp"/);
    assert.match(await zip.file('OEBPS/chap_1.xhtml').async('string'), /src="images\/original\.webp"/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
