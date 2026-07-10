import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import { ProjectProgress } from '../utils/db.js';

test('character dna tags can be overwritten without changing other dna fields', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-dna-'));
  const progress = new ProjectProgress(tempDir);
  await progress.load();
  progress.updateCharacterDNA('阿宾', {
    tags: 'blue_hair, long_hair',
    aliases: ['abin']
  });
  progress.setCharacterDNATags('阿宾', 'black_hair, twintails');
  await progress.save();

  const reloaded = new ProjectProgress(tempDir);
  await reloaded.load();
  const character = reloaded.getGlobalCharacters()['阿宾'];

  assert.equal(character.tags, 'black_hair, twintails');
  assert.deepEqual(character.aliases, ['abin']);
});

test('character appearance DNA versions resolve by chapter and retain global fallback', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-dna-versions-'));
  const progress = new ProjectProgress(tempDir);
  await progress.load();
  progress.updateCharacterDNA('小玉', {
    tags: 'black_hair, ponytail, blue_eyes',
    aliases: ['玉儿'],
    features: { 发型标签: ['ponytail'], 发色标签: ['black_hair'], 眼睛标签: ['blue_eyes'] }
  });

  progress.upsertCharacterDnaVersion('小玉', {
    startChapterIndex: 0,
    tags: 'black_hair, ponytail, blue_eyes',
    features: { 发型标签: ['ponytail'], 发色标签: ['black_hair'], 眼睛标签: ['blue_eyes'] },
    evidence: [{ quote: '她扎着马尾。', attribute: '发型', tags: ['ponytail'] }],
    confidence: 0.9,
    sourceSliceKey: 'slice_1'
  });
  progress.upsertCharacterDnaVersion('小玉', {
    startChapterIndex: 11,
    tags: 'black_hair, short_hair, blue_eyes',
    features: { 发型标签: ['short_hair'], 发色标签: ['black_hair'], 眼睛标签: ['blue_eyes'] },
    evidence: [{ quote: '她剪成了短发。', attribute: '发型', tags: ['short_hair'] }],
    confidence: 0.95,
    sourceSliceKey: 'slice_2'
  });

  assert.equal(progress.getCharacterDNAForChapter('小玉', 10).tags, 'black_hair, ponytail, blue_eyes');
  const changed = progress.getCharacterDNAForChapter('玉儿', 11);
  assert.equal(changed.tags, 'black_hair, short_hair, blue_eyes');
  assert.equal(changed.startChapterIndex, 11);
  assert.equal(progress.getCharacterDNAForChapter('不存在角色', 11), null);
  assert.equal(progress.getGlobalCharacters()['小玉'].tags, 'black_hair, ponytail, blue_eyes');
});
