import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PipelineManager } from '../services/pipeline-manager.js';

test('清空重绘会删除旧图并把章节分镜重置为 pending', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-chapter-redraw-'));
  const imageDir = path.join(tempDir, 'images');
  await fs.mkdir(imageDir, { recursive: true });
  const imagePath = path.join(imageDir, 'scene_1.png');
  await fs.writeFile(imagePath, 'png');

  let captured = null;
  const pipeline = new PipelineManager({
    projectName: 'chapter-redraw-reset-test',
    cjk_scene_divisor: 6000
  });
  pipeline.projBase = tempDir;
  pipeline.writeLog = () => {};
  const events = [];
  pipeline.uiProgressCallback = (event) => events.push(event);
  pipeline.projectProgress = {
    getCompletedChapters: () => ({
      ch1: {
        scenes: [
          { image_path: 'images/scene_1.png' },
          { image_path: 'images/missing.png' }
        ]
      }
    }),
    setChapterStatus: (chapKey, status, scenes, extra) => {
      captured = { chapKey, status, scenes, extra };
    },
    save: async () => {}
  };

  await pipeline._resetChapterScenesForRedraw('ch1');

  assert.equal(captured.chapKey, 'ch1');
  assert.equal(captured.status, 'pending');
  assert.deepEqual(captured.scenes, []);
  assert.deepEqual(captured.extra.scene_extraction_failures, []);
  assert.equal(captured.extra.content_hash, '');
  assert.equal(existsSync(imagePath), false);
  assert.deepEqual(events, [{ type: 'chapter_scenes_reset', chapterKey: 'ch1' }]);
});

test('清空重绘在章节没有旧图时也能正常重置', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-chapter-redraw-empty-'));
  let captured = null;
  const pipeline = new PipelineManager({
    projectName: 'chapter-redraw-empty-test',
    cjk_scene_divisor: 6000
  });
  pipeline.projBase = tempDir;
  pipeline.writeLog = () => {};
  pipeline.projectProgress = {
    getCompletedChapters: () => ({}),
    setChapterStatus: (chapKey, status, scenes, extra) => {
      captured = { chapKey, status, scenes, extra };
    },
    save: async () => {}
  };

  await pipeline._resetChapterScenesForRedraw('ch2');

  assert.equal(captured.status, 'pending');
  assert.deepEqual(captured.scenes, []);
});
