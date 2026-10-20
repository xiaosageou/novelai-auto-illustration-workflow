import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { ProjectProgress } from '../utils/db.js';

async function createProgress(prefix) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const progress = new ProjectProgress(tempDir);
  await progress.load();
  return { tempDir, progress };
}

test('前端修改基础 DNA 后会同步到未定制的外观版本', async () => {
  const { tempDir, progress } = await createProgress('nai-dna-sync-');
  progress.updateCharacterDNA('光太', {
    tags: 'black_hair, blue_eyes, childlike_build',
    features: { 发色标签: ['black_hair'], 眼睛标签: ['blue_eyes'], 年龄标签: ['7yo'] },
    proxy_character: { danbooru_tag: 'old_tag' }
  });
  progress.upsertCharacterDnaVersion('光太', {
    startChapterIndex: 0,
    tags: 'black_hair, blue_eyes, childlike_build',
    features: { 发色标签: ['black_hair'], 眼睛标签: ['blue_eyes'], 年龄标签: ['7yo'] }
  });

  assert.deepEqual(progress.getCharacterDNAForChapter('光太', 0).features['年龄标签'], ['7yo']);

  progress.setCharacterDNAFeatures('光太', {
    发色标签: ['black_hair'],
    眼睛标签: ['dark_eyes'],
    年龄标签: ['adult']
  });
  progress.setCharacterDNAProxy('光太', { danbooru_tag: 'new_tag' });
  await progress.save();

  const effective = progress.getCharacterDNAForChapter('光太', 0);
  assert.deepEqual(effective.features['年龄标签'], ['adult']);
  assert.deepEqual(effective.features['眼睛标签'], ['dark_eyes']);
  assert.equal(effective.proxy_character.danbooru_tag, 'new_tag');

  const reloaded = new ProjectProgress(tempDir);
  await reloaded.load();
  assert.deepEqual(reloaded.getCharacterDNAForChapter('光太', 0).features['年龄标签'], ['adult']);
});

test('章节定制的发型版本不会被基础 DNA 编辑覆盖', async () => {
  const { progress } = await createProgress('nai-dna-sync-custom-');
  progress.updateCharacterDNA('小玉', {
    tags: 'black_hair, long_hair',
    features: { 发型标签: ['long_hair'], 发色标签: ['black_hair'] }
  });
  progress.upsertCharacterDnaVersion('小玉', {
    startChapterIndex: 0,
    tags: 'black_hair, long_hair',
    features: { 发型标签: ['long_hair'], 发色标签: ['black_hair'] }
  });
  progress.upsertCharacterDnaVersion('小玉', {
    startChapterIndex: 11,
    tags: 'black_hair, short_hair',
    features: { 发型标签: ['short_hair'], 发色标签: ['black_hair'] }
  });

  progress.setCharacterDNAFeatures('小玉', {
    发型标签: ['twintails'],
    发色标签: ['black_hair']
  });

  assert.deepEqual(progress.getCharacterDNAForChapter('小玉', 0).features['发型标签'], ['twintails']);
  assert.deepEqual(progress.getCharacterDNAForChapter('小玉', 11).features['发型标签'], ['short_hair']);
});

test('直接改 tags 只同步仍与旧基础值一致的版本', async () => {
  const { progress } = await createProgress('nai-dna-sync-tags-');
  progress.updateCharacterDNA('阿宾', {
    tags: 'black_hair, long_hair',
    features: { 发型标签: ['long_hair'], 发色标签: ['black_hair'] }
  });
  progress.upsertCharacterDnaVersion('阿宾', {
    startChapterIndex: 0,
    tags: 'black_hair, long_hair',
    features: { 发型标签: ['long_hair'], 发色标签: ['black_hair'] }
  });
  progress.upsertCharacterDnaVersion('阿宾', {
    startChapterIndex: 5,
    tags: 'black_hair, short_hair',
    features: { 发型标签: ['short_hair'], 发色标签: ['black_hair'] }
  });

  progress.setCharacterDNATags('阿宾', 'black_hair, ponytail');

  assert.equal(progress.getCharacterDNAForChapter('阿宾', 0).tags, 'black_hair, ponytail');
  assert.equal(progress.getCharacterDNAForChapter('阿宾', 5).tags, 'black_hair, short_hair');
});
