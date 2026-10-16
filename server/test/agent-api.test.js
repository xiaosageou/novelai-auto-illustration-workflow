import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import express from 'express';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createAgentRouter } from '../services/agent-api.js';
import { PipelineManager } from '../services/pipeline-manager.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-agent-test-'));
  const pipelines = new Map();
  const jobs = [];
  const state = { busy: false };
  let calls = 0;
  const dependencies = {
    baseDir: root,
    async getPipeline(name) {
      if (!pipelines.has(name)) {
        const p = new PipelineManager({ projectName: name });
        p.baseDir = root;
        p.switchProject(name);
        await p.initialize();
        pipelines.set(name, p);
      }
      return pipelines.get(name);
    },
    enqueueRedraw(projectName, pipeline, chapterKey, effectiveKey, sceneIdx, mode, options) {
      calls++;
      state.busy = true;
      jobs.push({ projectName, pipeline, chapterKey, sceneIdx, options, mode });
      return { state: 'queued', position: 1, duplicate: false };
    },
    queueState: () => ({ busy: state.busy }),
    stopQueues: () => {
      const removed = jobs.splice(0);
      state.busy = false;
      return { removed: removed.length, actionIds: removed.map(j => j.options.agentActionId) };
    }
  };
  const servers = [];
  async function listen() {
    const app = express();
    app.use(express.json());
    app.use('/api/agent', createAgentRouter(dependencies));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  const base = await listen();
  t.after(async () => {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    // Only the verified test-owned temporary root is removed.
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'nai-agent-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function call(action, args = {}, actionId, origin) {
    const response = await fetch(`${base}/api/agent/call`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {})
    }, body: JSON.stringify({ action, arguments: args, ...(actionId ? { actionId } : {}) }) });
    return { status: response.status, ...(await response.json()) };
  }
  return { root, base, call, listen, pipelines, jobs, state, dependencies, get calls() { return calls; } };
}

async function seed(f) {
  const created = await f.call('projects.create', { projectName: 'fixture', bookText: '第一章\n她推开门，发现桌上的信不见了。' }, 'create-fixture-v1');
  assert.equal(created.ok, true);
  const info = await f.call('projects.get', { projectName: 'fixture' });
  const args = { projectName: 'fixture', chapterKey: info.data.chapters[0].chapterKey };
  const card = await f.call('scenes.create', { ...args, card: { trigger_sentence: '她推开门', visual_description: 'A woman opens a door.', character_names: ['女主'] } }, 'create-scene-v1');
  assert.equal(card.ok, true);
  return { ...args, sceneIdx: card.data.result.scene.scene_idx, expectedSceneHash: card.data.result.sceneHash };
}

test('HTTP agent workflow writes authored prompts, dispatches once, and binds QC to current images', async t => {
  const f = await fixture(t);
  const args = await seed(f);
  const chapter = await f.call('chapters.get', { projectName: args.projectName, chapterKey: args.chapterKey });
  assert.match(chapter.data.content, /桌上的信/);
  const authored = { ...args, basePrompt: '1girl, 1.7::artist:example::, opening a door', negativePrompt: 'text, watermark',
    characterPrompts: ['woman, black hair'], negativeCharacterPrompts: [''], width: 832, height: 1216 };
  const written = await f.call('prompts.write', authored, 'write-prompt-v1');
  assert.equal(written.ok, true);
  assert.equal(written.data.result.scene.base_prompt, authored.basePrompt);
  assert.deepEqual(written.data.result.scene.negative_character_prompts, ['']);
  const render = { ...args, expectedSceneHash: written.data.result.sceneHash, confirmCosts: true };
  const { confirmCosts, ...unconfirmed } = render;
  assert.equal((await f.call('scenes.render', unconfirmed, 'render-no-cost-flag')).status, 400);
  assert.equal(f.calls, 0);
  const accepted = await f.call('scenes.render', render, 'render-fixture-v1');
  assert.equal(accepted.data.status, 'QUEUED');
  const replay = await f.call('scenes.render', render, 'render-fixture-v1');
  assert.equal(replay.replayed, true);
  assert.equal(f.calls, 1);
  const conflict = await f.call('scenes.render', { ...render, sceneIdx: 2 }, 'render-fixture-v1');
  assert.equal(conflict.status, 409);
  const busy = await f.call('scenes.update', { ...args, card: { visual_description: 'Changed.' } }, 'update-busy-v1');
  assert.equal(busy.error.code, 'BUSY');

  // SIMULATED renderer only: real PNG decoding and storage, no remote calls or visual acceptance claim.
  const job = f.jobs.shift();
  const target = job.pipeline.projectProgress.getCompletedChapters()[job.chapterKey].scenes[0];
  await fs.mkdir(job.pipeline.illustrationsDir, { recursive: true });
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toFile(path.join(job.pipeline.illustrationsDir, 'SIMULATED.png'));
  target.image_path = 'illustrations/SIMULATED.png';
  target.status = 'SUCCESS';
  await job.pipeline.projectProgress.save();
  await job.options.onFinished(null);
  f.state.busy = false;
  const receipt = await fetch(`${f.base}/api/agent/jobs/render-fixture-v1`).then(r => r.json());
  assert.equal(receipt.data.status, 'DONE');
  assert.equal(receipt.data.result.imagePath, 'illustrations/SIMULATED.png');
  const pending = await f.call('qc.tasks', { projectName: 'fixture' });
  assert.equal(pending.data.length, 1);
  const task = pending.data[0];
  const criteria = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`C${i + 1}`, { result: 'PASS', evidence: 'SIMULATED contract evidence, not actual visual approval.' }]));
  const report = { projectName: args.projectName, chapterKey: args.chapterKey, sceneIdx: args.sceneIdx,
    imageSha256: task.images[0].sha256, contextHash: task.contextHash, summary: 'SIMULATED contract test',
    examinedImages: task.images.map(({ path: imagePath, sha256 }) => ({ path: imagePath, sha256 })), criteria };
  const stale = await f.call('qc.submit', { ...report, imageSha256: 'old-hash' }, 'qc-stale-fixture');
  assert.equal(stale.error.code, 'STALE_QC');
  const saved = await f.call('qc.submit', report, 'qc-pass-fixture');
  assert.equal(saved.data.result.verdict, 'PASS');
  assert.equal(saved.data.result.humanApproved, false);
  assert.equal(saved.data.result.assemblyReady, false);
  assert.equal((await f.call('qc.tasks', { projectName: 'fixture' })).data.length, 0);
  target.visual_description = 'Changed director instruction.';
  await job.pipeline.projectProgress.save();
  const changed = await f.call('scenes.get', { projectName: args.projectName, chapterKey: args.chapterKey, sceneIdx: args.sceneIdx });
  assert.equal(changed.data.qc.status, 'STALE');
  assert.equal(changed.data.humanApproved, false);
});

test('agent requests reject traversal, unknown fields, invalid versions and browser origins', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('projects.get', { projectName: '../escape' })).status, 400);
  assert.equal((await f.call('projects.create', { projectName: 'CON', bookText: 'x' }, 'create-invalid-v1')).status, 400);
  assert.equal((await f.call('constructor')).status, 404);
  assert.equal((await f.call('projects.list', { apiKey: 'should-not-be-accepted' })).status, 400);
  assert.equal((await f.call('projects.list', {}, undefined, 'https://example.test')).status, 403);
  const args = await seed(f);
  assert.equal((await f.call('scenes.update', { ...args, expectedSceneHash: 'old', card: {} }, 'update-old-version')).error.code, 'STALE_SCENE');
  assert.equal((await f.call('projects.create', { projectName: 'fixture', bookText: 'overwrite' }, 'create-fixture-v2')).status, 409);
  const invalidSize = await f.call('prompts.write', { ...args, basePrompt: 'landscape', negativePrompt: '', characterPrompts: [], width: 1024, height: 1216 }, 'write-large-canvas');
  assert.equal(invalidSize.error.code, 'INVALID_CANVAS');
  assert.equal(await fs.readFile(path.join(f.root, 'projects', 'fixture', 'book.txt'), 'utf8'), '第一章\n她推开门，发现桌上的信不见了。');
  const capabilities = await fetch(`${f.base}/api/agent/capabilities`).then(r => r.json());
  assert.equal(capabilities.data.humanApprovalSupported, true);
  assert.equal(capabilities.data.actions['scenes.render'].costs, true);
});

test('unfinished jobs survive restart as review-required and are never dispatched on replay', async t => {
  const f = await fixture(t);
  const args = await seed(f);
  const written = await f.call('prompts.write', { ...args, basePrompt: 'landscape', negativePrompt: '', characterPrompts: [], width: 1024, height: 1024 }, 'write-restart-prompt');
  const render = { ...args, expectedSceneHash: written.data.result.sceneHash, confirmCosts: true };
  await f.call('scenes.render', render, 'render-restart-test');
  assert.equal(f.calls, 1);
  const second = await f.listen();
  const replay = await fetch(`${second}/api/agent/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'scenes.render', arguments: render, actionId: 'render-restart-test' }) }).then(r => r.json());
  assert.equal(replay.data.status, 'INTERRUPTED_REVIEW_REQUIRED');
  assert.equal(replay.replayed, true);
  assert.equal(f.calls, 1);
});

test('stop cancels unstarted Agent jobs in the shared queue', async t => {
  const f = await fixture(t);
  const args = await seed(f);
  const written = await f.call('prompts.write', { ...args, basePrompt: 'landscape', negativePrompt: '', characterPrompts: [], width: 1024, height: 1024 }, 'write-stop-prompt');
  await f.call('scenes.render', { ...args, expectedSceneHash: written.data.result.sceneHash, confirmCosts: true }, 'render-stop-test');
  const stop = await f.call('pipeline.stop', { projectName: 'fixture' }, 'stop-fixture-test');
  assert.equal(stop.data.result.removed, 1);
  const receipt = await fetch(`${f.base}/api/agent/jobs/render-stop-test`).then(r => r.json());
  assert.equal(receipt.data.status, 'CANCELLED');
});

test('bundled CLI calls the real HTTP API using UTF-8 JSON stdin', async t => {
  const f = await fixture(t);
  await seed(f);
  const script = fileURLToPath(new URL('../../.agents/skills/nai-project-agent/scripts/nai-agent.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'call', 'projects.list', '--args', '-', '--base-url', f.base], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.end('{}');
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).data, [{ projectName: 'fixture' }]);
});

test('production server mounts Agent routes and persists an Agent-authored project without model calls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-agent-server-test-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const entry = fileURLToPath(new URL('../index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'nai-agent-server-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let capabilities;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { capabilities = await fetch(`${base}/api/agent/capabilities`).then(r => r.json()); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(capabilities?.ok, true, 'Production server did not expose the Agent routes');
  const call = async (action, args, actionId) => fetch(`${base}/api/agent/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, arguments: args, ...(actionId ? { actionId } : {}) })
  }).then(r => r.json());
  const created = await call('projects.create', { projectName: 'integration', bookText: '第一章\n测试人物走进书房。' }, 'create-live-integration');
  assert.equal(created.ok, true);
  const project = await call('projects.get', { projectName: 'integration' });
  const chapterKey = project.data.chapters[0].chapterKey;
  const card = await call('scenes.create', { projectName: 'integration', chapterKey,
    card: { trigger_sentence: '走进书房', visual_description: 'A person enters a study.' } }, 'create-live-scene');
  assert.equal(card.ok, true);
  const status = await call('pipeline.status', { projectName: 'integration' });
  assert.equal(status.data.isRunning, false);
  assert.equal(status.data.busy, false);
  assert.equal(status.data.chapters[0].scenes[0].status, 'PENDING');
  const disk = JSON.parse(await fs.readFile(path.join(root, 'projects', 'integration', 'pipeline_progress.json'), 'utf8'));
  assert.equal(disk.completed_chapters[chapterKey].scenes[0].visual_description, 'A person enters a study.');
  const ledger = JSON.parse(await fs.readFile(path.join(root, 'projects', '.agent', 'ledger.json'), 'utf8'));
  assert.equal(ledger.actions['create-live-scene'].status, 'DONE');
});
