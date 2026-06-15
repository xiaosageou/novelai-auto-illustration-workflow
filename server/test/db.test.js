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
