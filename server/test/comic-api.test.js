import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import express from 'express';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createAgentRouter } from '../services/agent-api.js';
import { PipelineManager } from '../services/pipeline-manager.js';
import { createComicLegacyGuard } from '../services/comic-service.js';
import { ComicTextGenerator } from '../services/comic-text-generator.js';

const evidence = () => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`C${i + 1}`, {
  result: 'PASS', evidence: 'SIMULATED integration fixture, no real visual acceptance.'
}]));
async function fixture(t, existingRoot, options = {}) {
  const root = existingRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'nai-comic-test-'));
  const pipelines = new Map(); const jobs = []; const state = { busy: false }; let color = 0;
  const router = createAgentRouter({ baseDir: root, comicGenerator: options.generator,
    async getPipeline(name) {
      if (!pipelines.has(name)) {
        const p = new PipelineManager({ projectName: name }); p.baseDir = root; p.switchProject(name); await p.initialize(); pipelines.set(name, p);
      }
      return pipelines.get(name);
    },
    enqueueRedraw(projectName, pipeline, chapterKey, effectiveKey, sceneIdx, mode, options) {
      state.busy = true; jobs.push({ pipeline, chapterKey, sceneIdx, options }); return { state: 'queued', duplicate: false, position: 1 };
    }, queueState: () => ({ busy: state.busy }), stopQueues: () => ({ actionIds: [], removed: 0 })
  });
  const app = express(); app.use(express.json()); app.use('/api/agent', router); app.use('/api/comic', router.humanRouter);
  app.use('/api/projects/:projectName', createComicLegacyGuard(async name => pipelines.get(name)));
  app.use('/api/projects/:projectName', (req, res) => res.json({ simulatedLegacyRoute: true }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const name of pipelines.keys()) router.stopComicProduction(name);
    while (jobs.length) await finishImage();
    await new Promise(resolve => setTimeout(resolve, 300));
    await new Promise(resolve => server.close(resolve)); assert.ok(root.startsWith(path.join(os.tmpdir(), 'nai-comic-test-'))); await fs.rm(root, { recursive: true, force: true });
  });
  async function call(action, args, actionId) {
    const res = await fetch(`${base}/api/agent/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, arguments: args, ...(actionId ? { actionId } : {}) }) });
    return { httpStatus: res.status, ...(await res.json()) };
  }
  let token;
  const browserHeaders = { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty', Origin: base };
  async function browser(action, args, actionId) {
    if (!token) token = await fetch(`${base}/api/comic/session`, { headers: browserHeaders }).then(r => r.json()).then(r => r.data.token);
    const res = await fetch(`${base}/api/comic/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...browserHeaders, 'X-Comic-Session': token },
      body: JSON.stringify({ action, arguments: args, ...(actionId ? { actionId } : {}) }) });
    return { httpStatus: res.status, ...(await res.json()) };
  }
  async function finishImage() {
    const job = jobs.shift();
    const target = job.pipeline.projectProgress.getCompletedChapters()[job.chapterKey].scenes.find(s => s.scene_idx === job.sceneIdx);
    const file = `SIMULATED-${++color}.png`;
    await fs.mkdir(job.pipeline.illustrationsDir, { recursive: true });
    const svg = `<svg width="${target.width}" height="${target.height}"><rect width="100%" height="100%" fill="${color % 2 ? '#dae5d5' : '#ede0cb'}"/><text x="80" y="180" font-size="36">SIMULATED CANDIDATE ${color}</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(job.pipeline.illustrationsDir, file));
    target.status = 'SUCCESS'; target.image_path = `illustrations/${file}`;
    await job.pipeline.projectProgress.save();
    await job.options.onFinished(null); state.busy = false;
  }
  return { root, base, call, browser, human: (args, actionId) => browser('human.review', args, actionId), finishImage, pipelines, jobs, state };
}

async function seed(f, count = 1) {
  await f.call('projects.create', { projectName: 'comic-fixture', bookText: '第一章\n她推开门。她发现桌上的信不见了。' }, 'create-comic-project');
  const project = await f.call('projects.get', { projectName: 'comic-fixture' });
  const args = { projectName: 'comic-fixture', episodeId: 'EP001' };
  let ep = (await f.call('comics.episodes.create', { ...args, title: '消失的信', language: 'zh-CN', initialState: { door: 'closed' } }, 'create-comic-episode')).data.result;
  for (let i = 1; i <= count; i++) {
    const plan = { chapterKey: project.data.chapters[0].chapterKey, sourceExcerpt: i === 1 ? '她推开门。' : '她发现桌上的信不见了。',
      sourceLocator: `第一章 · 句${i}`, sceneId: 'SC001', shotId: `SHOT${i}`, storyBeat: i === 1 ? '打开门' : '发现信不见了',
      storyboardDescription: i === 1 ? '女主伸手推开门。' : '女主看向空桌面。', shotSize: '中景', cameraAngle: '侧面',
      canvasReason: '竖幅表现人物与门的关系', width: 832, height: 1216, characterNames: ['女主'],
      stateDelta: i === 1 ? { door: 'open' } : { letter: 'missing' }, mustShow: ['动作清楚'], mustNotShow: ['提前泄露'],
      dialogue: [{ dialogueId: `D${i}`, speakerId: '女主', type: 'speech', text: i === 1 ? '有人吗？' : '信呢？' }], sfx: i === 1 ? ['吱呀'] : [] };
    ep = (await f.call('comics.panels.add', { ...args, panelId: `P${i}`, expectedEpisodeHash: ep.episodeHash, plan }, `add-comic-panel-${i}`)).data.result;
  }
  return { args, episode: ep };
}
async function read(f, args) { const result = await f.call('comics.episodes.get', args); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
async function renderAndQC(f, args, panelId, suffix) {
  let ep = await read(f, args);
  const prompt = await f.call('comics.prompts.write', { ...args, panelId, expectedEpisodeHash: ep.episodeHash,
    basePrompt: '1girl, single image, opening door, anime illustration', negativePrompt: 'text, watermark', characterPrompts: ['woman, black hair, white coat'] }, `prompt-${suffix}`);
  assert.equal(prompt.ok, true, JSON.stringify(prompt)); ep = prompt.data.result;
  const result = await f.call('comics.panels.render', { ...args, panelId, expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, `render-${suffix}`);
  assert.equal(result.ok, true, JSON.stringify(result));
  await f.finishImage();
  const tasks = (await f.call('comics.qc.tasks', args)).data;
  const task = tasks.find(task => task.panelId === panelId);
  assert.ok(task);
  const report = await f.call('comics.qc.submit', { ...args, panelId, candidateId: task.candidateId,
    contextHash: task.contextHash, imageSha256: task.imageSha256, summary: 'SIMULATED QA protocol fixture',
    examinedImages: task.images.map(i => ({ path: i.path, sha256: i.sha256 })), criteria: evidence() }, `qc-${suffix}`);
  assert.equal(report.ok, true, JSON.stringify(report));
  return task;
}

test('comic EP workflow preserves source, candidates, human gates, lettering, slices and handoff evidence', async t => {
  const f = await fixture(t); const { args } = await seed(f, 2);
  const first = await renderAndQC(f, args, 'P1', 'first-candidate');
  const second = await renderAndQC(f, args, 'P2', 'second-candidate');
  let ep = await read(f, args);
  assert.deepEqual(ep.panels[1].plannedEntryState, { door: 'open' });
  assert.equal(second.images.length, 2);
  assert.equal(ep.readyToAssemble, false);
  const forbidden = await f.call('comics.assemble', { ...args, expectedEpisodeHash: ep.episodeHash }, 'assemble-before-human');
  assert.equal(forbidden.error.code, 'HUMAN_QC_REQUIRED');
  assert.equal((await f.call('human.review', {})).httpStatus, 404);
  assert.equal((await fetch(`${f.base}/api/comic/session`)).status, 403);
  for (const [panelId, task] of [['P1', first], ['P2', second]]) {
    ep = await read(f, args);
    const vote = await f.human({ ...args, expectedEpisodeHash: ep.episodeHash, action: 'approve', panelId,
      candidateId: task.candidateId, imageSha256: task.imageSha256, contextHash: task.contextHash,
      speakerAnchors: { 女主: { x: 0.4, y: 0.3 } }, comment: 'SIMULATED browser approval only' }, `human-approve-${panelId}`);
    assert.equal(vote.ok, true, JSON.stringify(vote));
  }
  ep = await read(f, args); assert.equal(ep.readyToAssemble, true);
  const composition = await f.call('comics.assemble', { ...args, expectedEpisodeHash: ep.episodeHash }, 'assemble-after-human');
  assert.equal(composition.ok, true, JSON.stringify(composition)); ep = composition.data.result;
  assert.equal(ep.assemblyStatus, 'LAYOUT_REVIEW_REQUIRED');
  const deniedExport = await f.call('comics.export', { ...args, expectedEpisodeHash: ep.episodeHash }, 'export-before-layout');
  assert.equal(deniedExport.error.code, 'LAYOUT_REVIEW_REQUIRED');
  const assemblyDir = path.join(f.root, 'projects', args.projectName, ep.assembly.directory);
  const svg = await fs.readFile(path.join(assemblyDir, 'master.svg'), 'utf8');
  assert.match(svg, /有人吗？/); assert.match(svg, /吱呀/);
  const layout = JSON.parse(await fs.readFile(path.join(assemblyDir, 'layout.json'), 'utf8'));
  assert.equal(layout.blocks.filter(b => b.type === 'panel').length, 2);
  for (const slice of layout.slices) {
    const meta = await sharp(path.join(assemblyDir, slice.path)).metadata();
    assert.equal(meta.width, 800); assert.equal(meta.height, slice.height);
  }
  const signoff = await f.human({ ...args, expectedEpisodeHash: ep.episodeHash, action: 'layout-pass', comment: 'SIMULATED layout review' }, 'human-layout-approve');
  assert.equal(signoff.ok, true, JSON.stringify(signoff));
  ep = await read(f, args); assert.equal(ep.assemblyStatus, 'SIGNED_OFF');
  const exported = await f.call('comics.export', { ...args, expectedEpisodeHash: ep.episodeHash }, 'export-signed-off');
  assert.equal(exported.ok, true, JSON.stringify(exported));
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(f.root, 'projects', args.projectName, exported.data.result.path)));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.schemaVersion, 'nai-comic-handoff/1.0');
  assert.ok(manifest.files['panels/P1/evidence.json']);
  const record = JSON.parse(await zip.file('panels/P1/evidence.json').async('string'));
  assert.equal(record.qc.verdict, 'PASS');
  assert.equal(record.humanApproval.channel, 'human-browser-workbench');
  assert.equal(record.approvedExitState.door, 'open');
  const firstSlice = path.join(assemblyDir, layout.slices[0].path);
  await fs.writeFile(firstSlice, Buffer.from('SIMULATED tampered layout'));
  ep = await read(f, args);
  const tampered = await f.call('comics.export', { ...args, expectedEpisodeHash: ep.episodeHash }, 'export-tampered-layout');
  assert.equal(tampered.ok, false);
});

test('comic edits invalidate approvals, older candidates remain, and raw scene routes cannot bypass comic control', async t => {
  const f = await fixture(t); const { args } = await seed(f);
  const original = await renderAndQC(f, args, 'P1', 'original-candidate');
  let ep = await read(f, args);
  const vote = await f.human({ ...args, expectedEpisodeHash: ep.episodeHash, action: 'approve', panelId: 'P1',
    candidateId: original.candidateId, imageSha256: original.imageSha256, contextHash: original.contextHash,
    speakerAnchors: { 女主: { x: 0.5, y: 0.3 } } }, 'human-first-approval');
  assert.equal(vote.ok, true);
  ep = await read(f, args);
  const firstFile = ep.panels[0].candidates[0].imagePath;
  const linked = ep.panels[0].sceneRef;
  const scene = await f.call('scenes.get', { projectName: args.projectName, ...linked });
  const bypass = await f.call('scenes.render', { projectName: args.projectName, ...linked, expectedSceneHash: scene.data.sceneHash, confirmCosts: true }, 'attempt-scene-bypass');
  assert.equal(bypass.error.code, 'COMIC_ROUTE_REQUIRED');
  const legacy = `/api/projects/${args.projectName}/chapters/${encodeURIComponent(linked.chapterKey)}`;
  for (const [route, method] of [[`${legacy}/scenes/${linked.sceneIdx}/redraw-nai`, 'POST'],
    [`${legacy}/scenes/999`, 'DELETE'], [`${legacy}/generate`, 'POST'],
    [`/api/projects/${args.projectName}/pipeline/start`, 'POST']]) {
    const result = await fetch(`${f.base}${route}`, { method });
    assert.equal(result.status, 409); assert.equal((await result.json()).code, 'COMIC_ROUTE_REQUIRED');
  }
  const rerun = await f.call('comics.panels.render', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'render-second-candidate');
  assert.equal(rerun.ok, true); await f.finishImage();
  ep = await read(f, args);
  assert.equal(ep.panels[0].candidates.length, 2);
  assert.equal(ep.panels[0].candidates[0].humanApproved, true);
  await fs.access(path.join(f.root, 'projects', args.projectName, firstFile));
  const changedDialogue = { ...ep.panels[0].plan, dialogue: [{ ...ep.panels[0].plan.dialogue[0], text: '门外有人吗？' }] };
  const lettering = await f.call('comics.panels.update', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, plan: changedDialogue }, 'change-comic-dialogue');
  assert.equal(lettering.ok, true, JSON.stringify(lettering));
  assert.equal(lettering.data.result.panels[0].candidates[0].qcStatus, 'PASS');
  assert.equal(lettering.data.result.panels[0].candidates[0].humanApproved, false);
  ep = lettering.data.result;
  const changedPlan = { ...ep.panels[0].plan, storyboardDescription: '女主已经把门完全打开，站在门内。' };
  const changed = await f.call('comics.panels.update', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, plan: changedPlan }, 'change-comic-director');
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.data.result.panels[0].candidates[0].qcStatus, 'PLAN_CHANGED');
  assert.equal(changed.data.result.panels[0].candidates[0].humanApproved, false);
  assert.equal(changed.data.result.readyToAssemble, false);
});

test('comic generation limit counts dispatches and survives restart without silently retrying', async t => {
  const f = await fixture(t); const { args } = await seed(f);
  await renderAndQC(f, args, 'P1', 'limit-first');
  for (let i = 2; i <= 4; i++) {
    const ep = await read(f, args);
    const render = await f.call('comics.panels.render', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, `limit-render-${i}`);
    assert.equal(render.ok, true); await f.finishImage();
  }
  const restored = await fixture(t, f.root);
  const ep = await read(restored, args);
  assert.equal(ep.panels[0].candidates.length, 4);
  const fifth = await restored.call('comics.panels.render', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'limit-render-fifth');
  assert.equal(fifth.error.code, 'ATTEMPTS_EXHAUSTED'); assert.equal(restored.jobs.length, 0);
});

test('interrupted comic render requires explicit resolution before any new dispatch', async t => {
  const f = await fixture(t); const { args } = await seed(f);
  await renderAndQC(f, args, 'P1', 'recover-first');
  let ep = await read(f, args);
  await f.call('comics.panels.render', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'recover-interrupted');
  const restored = await fixture(t, f.root);
  ep = await read(restored, args);
  assert.equal(ep.panels[0].activeRender.status, 'INTERRUPTED_REVIEW_REQUIRED');
  const denied = await restored.call('comics.panels.render', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'recover-unsafe-repeat');
  assert.equal(denied.error.code, 'RENDER_REVIEW_REQUIRED'); assert.equal(restored.jobs.length, 0);
  const resolved = await restored.call('comics.renders.resolve', { ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash,
    resolution: 'no-image', note: 'SIMULATED restart fixture: no second remote request was made.' }, 'recover-resolution');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.data.result.panels[0].candidates.length, 1);
  const retry = await restored.call('comics.panels.render', { ...args, panelId: 'P1', expectedEpisodeHash: resolved.data.result.episodeHash, confirmCosts: true }, 'recover-explicit-retry');
  assert.equal(retry.ok, true); assert.equal(restored.jobs.length, 1);
});

test('human approval rejects non-PASS candidates, missing speaker anchors, and cross-origin sessions', async t => {
  const f = await fixture(t); const { args } = await seed(f);
  const task = await renderAndQC(f, args, 'P1', 'approval-check');
  let ep = await read(f, args);
  const missingAnchor = await f.human({ ...args, expectedEpisodeHash: ep.episodeHash, action: 'approve', panelId: 'P1',
    candidateId: task.candidateId, imageSha256: task.imageSha256, contextHash: task.contextHash }, 'human-missing-anchor');
  assert.equal(missingAnchor.error.code, 'SPEAKER_ANCHOR_REQUIRED');
  const criteria = evidence(); criteria.C5 = { result: 'UNKNOWN', evidence: 'SIMULATED ambiguous action' };
  await f.call('comics.qc.submit', { ...args, panelId: 'P1', candidateId: task.candidateId, imageSha256: task.imageSha256,
    contextHash: task.contextHash, summary: 'SIMULATED uncertain report', examinedImages: task.images.map(i => ({ path: i.path, sha256: i.sha256 })), criteria }, 'qc-unknown-candidate');
  ep = await read(f, args);
  const notPass = await f.human({ ...args, expectedEpisodeHash: ep.episodeHash, action: 'approve', panelId: 'P1',
    candidateId: task.candidateId, imageSha256: task.imageSha256, contextHash: task.contextHash }, 'human-unknown-reject');
  assert.equal(notPass.error.code, 'AGENT_QC_REQUIRED');
  const evil = await fetch(`${f.base}/api/comic/session`, { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'empty', Origin: 'http://evil.test' } });
  assert.equal(evil.status, 403);
  const devBrowser = await fetch(`${f.base}/api/comic/session`, { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'empty', Origin: 'http://localhost:5173' } });
  assert.equal(devBrowser.status, 200);
  const altered = await f.call('comics.panels.add', { ...args, expectedEpisodeHash: ep.episodeHash, panelId: 'INVALID',
    plan: { ...ep.panels[0].plan, sourceExcerpt: '小说里没有这一句话' } }, 'wrong-source-locator');
  assert.equal(altered.error.code, 'INVALID_SOURCE');
});

test('choosing a different approved reference invalidates the following panel QC and human approval', async t => {
  const f = await fixture(t); const { args } = await seed(f, 2);
  const first = await renderAndQC(f, args, 'P1', 'continuity-first');
  const second = await renderAndQC(f, args, 'P2', 'continuity-second');
  for (const [panelId, task] of [['P1', first], ['P2', second]]) {
    const ep = await read(f, args);
    const vote = await f.human({ ...args, panelId, expectedEpisodeHash: ep.episodeHash, action: 'approve',
      candidateId: task.candidateId, imageSha256: task.imageSha256, contextHash: task.contextHash,
      speakerAnchors: { 女主: { x: 0.5, y: 0.3 } } }, `continuity-approve-${panelId}`);
    assert.equal(vote.ok, true, JSON.stringify(vote));
  }
  const replacement = await renderAndQC(f, args, 'P1', 'continuity-replacement');
  let ep = await read(f, args);
  assert.equal(ep.panels[1].candidates[0].humanApproved, true);
  await f.human({ ...args, panelId: 'P1', expectedEpisodeHash: ep.episodeHash, action: 'approve',
    candidateId: replacement.candidateId, imageSha256: replacement.imageSha256, contextHash: replacement.contextHash,
    speakerAnchors: { 女主: { x: 0.5, y: 0.3 } } }, 'continuity-change-reference');
  ep = await read(f, args);
  assert.equal(ep.panels[1].candidates[0].qcStatus, 'STALE');
  assert.equal(ep.panels[1].candidates[0].humanApproved, false);
  assert.equal(ep.readyToAssemble, false);
  const tasks = (await f.call('comics.qc.tasks', args)).data;
  assert.equal(tasks.find(t => t.panelId === 'P2').images[1].sha256, replacement.imageSha256);
});

async function waitFor(f, args, predicate) {
  for (let i = 0; i < 100; i++) {
    const ep = await read(f, args);
    if (predicate(ep)) return ep;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('SIMULATED production timeout');
}
const simulatedPrompt = plan => ({ basePrompt: 'single image, anime style, opening door', negativePrompt: 'text, speech bubble, watermark',
  characterPrompts: plan.characterNames.map(() => 'woman, black hair, white coat'), negativeCharacterPrompts: plan.characterNames.map(() => '') });

test('browser authors a staged storyboard, edits it, generates prompts and sequential candidates with durable jobs', async t => {
  let storyboardCalls = 0; let promptCalls = 0;
  const generator = { async storyboard({ pipeline, chapterKey, count }) {
    storyboardCalls++;
    const sourcePlan = (await seedSource()).plan;
    return Array.from({ length: count }, (_, i) => ({ ...sourcePlan, chapterKey, shotId: `SHOT${i + 1}`, dialogue: [] }));
    async function seedSource() {
      assert.ok(pipeline);
      return { plan: { sourceExcerpt: '她推开门。', sourceLocator: 'SIMULATED 原文', sceneId: 'SC001', storyBeat: '推门',
        storyboardDescription: '女主推门', shotSize: '中景', cameraAngle: '平视', canvasReason: '容纳人物和门', width: 832, height: 1216,
        characterNames: ['女主'], mustShow: [], mustNotShow: [], stateDelta: { door: 'open' }, sfx: [], styleMode: 'main', styleReason: '', gapBefore: 0, gapAfter: 40 } };
    }
  }, async prompt({ plan, entryState }) { promptCalls++; assert.ok(entryState); return simulatedPrompt(plan); } };
  const f = await fixture(t, undefined, { generator }); const { args } = await seed(f, 0);
  const source = await f.browser('comics.sources.get', { projectName: args.projectName }); assert.equal(source.ok, true);
  assert.equal(source.data.chapters.length, 1);
  let ep = await read(f, args);
  const generateArgs = { ...args, expectedEpisodeHash: ep.episodeHash, chapterKey: source.data.chapters[0].chapterKey, panelCount: 2, confirmCosts: true };
  const started = await f.browser('comics.storyboard.generate', generateArgs, 'browser-storyboard-simulated');
  assert.equal(started.ok, true, JSON.stringify(started)); assert.equal(started.data.status, 'RUNNING');
  ep = await waitFor(f, args, ep => ep.production?.status === 'DONE');
  assert.equal(ep.panels.length, 0); assert.equal(ep.storyboardDraft.plans.length, 2);
  const replay = await f.browser('comics.storyboard.generate', generateArgs, 'browser-storyboard-simulated');
  assert.equal(replay.ok, true); assert.equal(storyboardCalls, 1);
  const edited = structuredClone(ep.storyboardDraft.plans); edited[1].storyBeat = 'SIMULATED edited beat';
  let adopted = await f.browser('comics.storyboard.apply', { ...args, expectedEpisodeHash: ep.episodeHash, plans: edited }, 'browser-adopt-simulated');
  assert.equal(adopted.ok, true, JSON.stringify(adopted)); ep = adopted.data;
  assert.deepEqual(ep.panelOrder, ['P001', 'P002']); assert.equal(ep.panels[1].plan.storyBeat, 'SIMULATED edited beat');
  assert.notEqual(ep.panels[0].sceneRef.sceneIdx, ep.panels[1].sceneRef.sceneIdx);
  const promptStarted = await f.browser('comics.prompts.generate', { ...args, expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'browser-prompts-simulated');
  assert.equal(promptStarted.ok, true, JSON.stringify(promptStarted));
  ep = await waitFor(f, args, ep => ep.production.status === 'DONE'); assert.equal(promptCalls, 2);
  assert.equal(ep.panels.every(p => p.generationInput.promptReady), true);
  const imageStarted = await f.browser('comics.images.generate', { ...args, expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'browser-images-simulated');
  assert.equal(imageStarted.ok, true, JSON.stringify(imageStarted));
  await waitFor(f, args, () => f.jobs.length > 0); assert.equal(f.jobs.length, 1);
  const jobArgs = f.jobs[0].options;
  await f.finishImage();
  await waitFor(f, args, () => f.jobs.length > 0); await f.finishImage();
  ep = await waitFor(f, args, ep => ep.production.status === 'DONE');
  assert.equal(ep.production.completed, 2); assert.equal(promptCalls, 2);
  for (const panel of ep.panels) { assert.equal(panel.candidates.length, 1); assert.equal(panel.candidates[0].qcStatus, 'PENDING'); assert.equal(panel.candidates[0].humanApproved, false); }
  assert.equal(ep.readyToAssemble, false);
  const child = await fetch(`${f.base}/api/agent/jobs/${jobArgs.agentActionId}`).then(r => r.json());
  assert.equal(child.data.parentActionId, 'browser-images-simulated'); assert.equal(child.data.status, 'DONE');
  const skipped = await f.browser('comics.images.generate', { ...args, expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'browser-images-skip-simulated');
  assert.equal(skipped.ok, true);
  await waitFor(f, args, ep => ep.production.status === 'DONE'); assert.equal(f.jobs.length, 0); assert.equal(promptCalls, 2);
  const forbidden = await f.browser('comics.qc.tasks', args); assert.equal(forbidden.ok, false);
});

test('stopping comic batch waits for in-flight image, preserves it, and submits no next panel', async t => {
  const f = await fixture(t, undefined, { generator: { async prompt({ plan }) { return simulatedPrompt(plan); } } });
  const { args } = await seed(f, 2); let ep = await read(f, args);
  const started = await f.browser('comics.images.generate', { ...args, expectedEpisodeHash: ep.episodeHash, confirmCosts: true }, 'browser-stop-batch-simulated');
  assert.equal(started.ok, true);
  ep = await waitFor(f, args, () => f.jobs.length > 0);
  const blocked = await f.browser('comics.panels.update', { ...args, panelId: 'P2', expectedEpisodeHash: ep.episodeHash, plan: ep.panels[1].plan }, 'browser-edit-busy-simulated');
  assert.ok(['BUSY', 'STALE_EPISODE'].includes(blocked.error.code), JSON.stringify(blocked));
  ep = await read(f, args);
  const stopped = await f.browser('comics.production.stop', { ...args, expectedEpisodeHash: ep.episodeHash, expectedProductionActionId: ep.production.actionId }, 'browser-stop-simulated');
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  await f.finishImage();
  ep = await waitFor(f, args, ep => ep.production.status === 'STOPPED_REVIEW_REQUIRED');
  assert.equal(ep.panels[0].candidates.length, 1); assert.equal(ep.panels[1].candidates.length, 0); assert.equal(f.jobs.length, 0);
  const ledger = await fetch(`${f.base}/api/agent/jobs/browser-stop-batch-simulated`).then(r => r.json());
  assert.equal(ledger.data.status, 'STOPPED_REVIEW_REQUIRED');
});

test('invalid draft adoption is atomic at validation, and failed LLM task does not queue images', async t => {
  const f = await fixture(t, undefined, { generator: { async storyboard() { throw new Error('SIMULATED LLM failed'); } } });
  const { args } = await seed(f, 1); let ep = await read(f, args); const plan = ep.panels[0].plan;
  let fresh = await f.browser('comics.episodes.create', { ...args, episodeId: 'EP002', title: 'SIMULATED Empty' }, 'browser-empty-simulated');
  assert.equal(fresh.ok, true); const emptyArgs = { ...args, episodeId: 'EP002' };
  const invalid = await f.browser('comics.storyboard.apply', { ...emptyArgs, expectedEpisodeHash: fresh.data.episodeHash, plans: [plan, { ...plan, sourceExcerpt: '原文不存在的句子' }] }, 'browser-invalid-adopt-simulated');
  assert.equal(invalid.ok, false);
  fresh = await read(f, emptyArgs); assert.equal(fresh.panels.length, 0);
  const started = await f.browser('comics.storyboard.generate', { ...emptyArgs, expectedEpisodeHash: fresh.episodeHash, chapterKey: plan.chapterKey, panelCount: 1, confirmCosts: true }, 'browser-failed-draft-simulated');
  assert.equal(started.ok, true);
  ep = await waitFor(f, emptyArgs, ep => ep.production.status === 'FAILED_REVIEW_REQUIRED');
  assert.equal(ep.panels.length, 0); assert.equal(f.jobs.length, 0); assert.equal(ep.storyboardDraft, undefined);
});

test('comic text generator uses task-specific HTTP models, SSE content and current continuity context', async t => {
  const app = express(); app.use(express.json()); const seen = [];
  app.post('/v1/chat/completions', (req, res) => {
    seen.push(req.body); const input = JSON.parse(req.body.messages[1].content);
    assert.equal(req.body.stream, true);
    const value = req.body.model === 'SIMULATED-director' ? { plans: [{ sourceExcerpt: '她推开门。', shotId: 'SHOT001' }] } : simulatedPrompt(input.plan);
    res.type('text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const pipeline = { config: { llm_scene_url: url, llm_scene_model: 'SIMULATED-director', llm_nai_tags_url: url,
    llm_nai_tags_model: 'SIMULATED-prompts', llm_stream_enabled: true, llm_rate_limit_enabled: false,
    artistStylePrompt: 'color anime', extra_prompt: 'clean lineart' }, projectProgress: { getGlobalCharacters: () => ({ 女主: { hair: 'black' } }) } };
  const generator = new ComicTextGenerator();
  const plans = await generator.storyboard({ pipeline, chapterKey: 'CH001', source: '她推开门。', title: 'SIMULATED EP',
    language: 'en', initialState: { door: 'closed' }, count: 1, previous: [], instructions: 'one panel', validate: async plan => { assert.equal(plan.chapterKey, 'CH001'); } });
  assert.equal(plans.length, 1);
  const prompt = await generator.prompt({ pipeline, plan: { characterNames: ['女主'], mustShow: ['hand on door'], mustNotShow: [] },
    dna: { 女主: { hair: 'black' } }, entryState: { door: 'closed' }, validate: value => assert.ok(value.basePrompt) });
  assert.equal(prompt.characterPrompts.length, 1); assert.equal(seen.length, 2);
  const first = JSON.parse(seen[0].messages[1].content); const second = JSON.parse(seen[1].messages[1].content);
  assert.equal(first.language, 'en'); assert.equal(first.source, '她推开门。'); assert.equal(first.batchPosition, '1-1');
  assert.deepEqual(second.entryState, { door: 'closed' }); assert.equal(second.artistStylePrompt, 'color anime');
});

test('comic text generator recognizes truncated SSE without retrying remote request', async t => {
  const app = express(); app.use(express.json()); let calls = 0;
  app.post('/v1/chat/completions', (req, res) => {
    calls++; res.type('text/event-stream').end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{}' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`);
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const pipeline = { config: { llm_url: `http://127.0.0.1:${server.address().port}/v1`, llm_rate_limit_enabled: false }, projectProgress: { getGlobalCharacters: () => ({}) } };
  await assert.rejects(new ComicTextGenerator().storyboard({ pipeline, chapterKey: 'CH001', source: 'test', count: 1, previous: [], validate: () => {} }), { code: 'COMIC_LLM_TRUNCATED' });
  assert.equal(calls, 1);
});
