import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../utils/db.js';
import { normalizeSceneCard } from '../utils/scene-structure.js';
import { estimateV45Tokens } from './prompt-builder.js';
import { composeComic, exportComic, digest } from './comic-composer.js';
import { ComicProduction } from './comic-production.js';

const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const hash = value => digest(canonical(value));
const now = () => new Date().toISOString();
const unresolvedRender = render => render && !['DONE', 'NOT_DISPATCHED', 'RESOLVED'].includes(render.status);
function check(ok, status, code, message) {
  if (!ok) throw Object.assign(new Error(message), { status, code, publicMessage: true });
}
function id(value) {
  check(typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), 400, 'INVALID_COMIC_ID', '漫画 ID 需以英文字母开头，仅含英文、数字、下划线和连字符');
  return value;
}
const artwork = plan => {
  const { dialogue, sfx, gapBefore, gapAfter, ...visual } = plan;
  return visual;
};

// The old illustration editor can reindex a chapter after deletion. Keep comic links stable.
export function createComicLegacyGuard(getPipeline) {
  return async (req, res, next) => {
    const sceneMatch = /^\/chapters\/([^/]+)\/scenes\/([^/]+)(?:\/(redraw|redraw-nai|regenerate))?$/.exec(req.path);
    const chapterMatch = /^\/chapters\/([^/]+)\/(generate|selected-scenes)$/.exec(req.path);
    const allChapters = req.method === 'POST' && req.path === '/pipeline/start';
    const sceneMutation = sceneMatch && (['PUT', 'DELETE'].includes(req.method) || req.method === 'POST' && sceneMatch[3]);
    if (!allChapters && !(chapterMatch && req.method === 'POST') && !sceneMutation) return next();
    try {
      const pipeline = await getPipeline(req.params.projectName);
      if (pipeline.comicProductionJob) return res.status(409).json({ error: '漫画创作任务正在运行，请等待或停止任务', code: 'BUSY' });
      const chapters = pipeline.projectProgress.getCompletedChapters();
      const chapterKey = (sceneMatch || chapterMatch)?.[1];
      const key = chapterKey && pipeline.projectProgress.getEffectiveChapKeyByRaw(decodeURIComponent(chapterKey));
      const scenes = allChapters ? Object.values(chapters).flatMap(ch => ch.scenes || []) : chapters[key]?.scenes || [];
      const affected = sceneMutation && req.method !== 'DELETE'
        ? scenes.filter(s => Number(s.scene_idx) === Number(sceneMatch[2])) : scenes;
      if (affected.some(s => s.comic_panel_id)) return res.status(409).json({
        error: '此操作会影响漫画分镜，请在漫画工作台或通过 comics 接口处理', code: 'COMIC_ROUTE_REQUIRED'
      });
      next();
    } catch (error) { next(error); }
  };
}

export class ComicService {
  constructor({ projectPath, resolve, imageInfo, queueState, dispatch, notify, actionState, locked, finish, submit, validate, generator }) {
    Object.assign(this, { projectPath, resolve, imageInfo, queueState, dispatch, notify, actionState });
    this.production = new ComicProduction(this, { locked, finish, submit, validate, generator });
  }
  async location(args) {
    const dir = await this.projectPath(args.projectName);
    const comicDir = path.join(dir, 'comic');
    return { dir, comicDir, episodePath: args.episodeId ? path.join(comicDir, 'episodes', `${id(args.episodeId)}.json`) : null };
  }
  async load(args) {
    const loc = await this.location(args);
    const episode = await readJson(loc.episodePath, null);
    check(episode, 404, 'EP_NOT_FOUND', '漫画 EP 不存在');
    return { ...loc, episode };
  }
  async save(loc) {
    loc.episode.updatedAt = now();
    await writeJsonAtomic(loc.episodePath, loc.episode);
    this.notify('comic_updated', { episodeId: loc.episode.episodeId });
  }
  panel(episode, panelId) {
    id(panelId);
    const panel = Object.hasOwn(episode.panels, panelId) ? episode.panels[panelId] : null;
    check(panel, 404, 'PANEL_NOT_FOUND', '画格不存在');
    return panel;
  }
  editable(episode, args, pipeline, owner = null) {
    check(hash(episode) === args.expectedEpisodeHash, 409, 'STALE_EPISODE', 'EP 版本已变化，请重新读取');
    check(!pipeline.isRunning && !this.queueState(args.projectName).busy, 409, 'BUSY', '等待项目队列完成后修改漫画计划');
    check(!pipeline.comicProductionJob || pipeline.comicProductionJob === owner, 409, 'BUSY', '漫画创作任务正在运行，等待完成或先停止');
  }
  entryState(episode, panelId) {
    const state = { ...episode.initialState };
    for (const pid of episode.panelOrder) {
      if (pid === panelId) return state;
      Object.assign(state, episode.panels[pid].plan.stateDelta);
    }
    check(false, 409, 'INVALID_ORDER', '画格不在阅读顺序中');
  }
  async planHash(loc, panel) {
    return hash({ plan: artwork(panel.plan), entryState: this.entryState(loc.episode, panel.panelId),
      bookSha256: digest(await fs.readFile(path.join(loc.dir, 'book.txt'))) });
  }
  async validatePlan(args, raw) {
    const plan = { characterNames: [], mustShow: [], mustNotShow: [], styleMode: 'main', styleReason: '',
      dialogue: [], sfx: [], stateDelta: {}, gapBefore: 0, gapAfter: 64, ...raw };
    const ctx = await this.resolve({ projectName: args.projectName, chapterKey: plan.chapterKey });
    id(plan.sceneId); id(plan.shotId);
    check(plan.styleMode !== 'chibi' || plan.styleReason.trim(), 400, 'STYLE_REASON_REQUIRED', 'Q 版切换需要明确叙事理由');
    check(ctx.chap.content.includes(plan.sourceExcerpt), 400, 'INVALID_SOURCE', 'sourceExcerpt 必须忠实匹配对应章节原文');
    check(plan.width % 64 === 0 && plan.height % 64 === 0 && plan.width * plan.height <= 1048576, 400, 'INVALID_CANVAS', '画幅需 64 对齐，总像素不超过 1048576');
    check(plan.characterNames.length <= 4 && new Set(plan.characterNames).size === plan.characterNames.length, 400, 'INVALID_CHARACTERS', '每格最多四名可见角色，角色名不可重复');
    check(new Set(plan.dialogue.map(d => d.dialogueId)).size === plan.dialogue.length, 400, 'INVALID_DIALOGUE', '对白 ID 不可重复');
    for (const dialogue of plan.dialogue) {
      id(dialogue.dialogueId);
      check(dialogue.type === 'narration' || plan.characterNames.includes(dialogue.speakerId), 400, 'INVALID_SPEAKER', '对白说话角色必须出现在本格');
    }
    plan.chapterKey = ctx.chapterKey;
    return { plan, ctx };
  }
  async scene(args, panel) {
    const ctx = await this.resolve({ projectName: args.projectName, ...panel.sceneRef }, true);
    check(ctx.target.comic_panel_id === panel.panelId && ctx.target.comic_episode_id === args.episodeId,
      409, 'SCENE_LINK_CHANGED', '生图场景关联已变化，请核查漫画与插图场景');
    return ctx;
  }
  sceneCard(plan) {
    return normalizeSceneCard({ trigger_sentence: plan.sourceExcerpt, visual_description: plan.storyboardDescription,
      core_action: plan.storyBeat, character_names: plan.characterNames,
      cinematography: `${plan.shotSize}; ${plan.cameraAngle}; ${plan.canvasReason}`,
      must_show: plan.mustShow, must_not_show: [...plan.mustNotShow, 'text', 'watermark', 'speech bubble'], text_elements: '' });
  }
  async capture(args, loc, panel, request = null) {
    const ctx = await this.scene(args, panel);
    check(ctx.target.status === 'SUCCESS' && ctx.target.image_path, 409, 'IMAGE_REQUIRED', '当前场景尚无生成完成的图片');
    const info = await this.imageInfo(loc.dir, ctx.target.image_path);
    check(info.format === 'png', 409, 'PNG_REQUIRED', '漫画候选必须是实际 PNG 文件');
    const planHash = await this.planHash(loc, panel);
    const existing = panel.candidates.find(c => c.imageSha256 === info.sha256 && c.planHash === planHash);
    if (existing) return existing;
    check(panel.candidates.length < 4, 409, 'ATTEMPTS_EXHAUSTED', '本格已收录四张候选，先人工核查范围与问题');
    check(info.width === panel.plan.width && info.height === panel.plan.height, 409, 'CANVAS_MISMATCH', '图片实际画幅与分镜计划不一致');
    const candidateId = `C_${randomUUID()}`;
    const relative = `comic/assets/${args.episodeId}/${panel.panelId}/${candidateId}.png`;
    const bytes = await fs.readFile(info.path);
    check(digest(bytes) === info.sha256, 409, 'IMAGE_CHANGED', '收录期间图片发生变化');
    await fs.mkdir(path.dirname(path.join(loc.dir, relative)), { recursive: true });
    await fs.writeFile(path.join(loc.dir, relative), bytes, { flag: 'wx' });
    const candidate = { candidateId, imagePath: relative, imageSha256: info.sha256,
      width: info.width, height: info.height, planHash, createdAt: now(),
      request: request || this.request(ctx.pipeline, ctx.target), qc: null, qcHistory: [] };
    panel.candidates.push(candidate);
    return candidate;
  }
  request(pipeline, target) {
    return { kind: 'saved-generation-input', backend: 'NovelAI-Illustrator',
      basePrompt: target.base_prompt, characterPrompts: target.character_prompts || [],
      negativePrompt: target.final_negative || '', negativeCharacterPrompts: target.negative_character_prompts || [],
      width: target.width, height: target.height, seed: target.render_seed ?? null,
      model: pipeline.config.nai_model || 'nai-diffusion-4-5-full', steps: Number(pipeline.config.steps) || 28,
      sampler: pipeline.config.sampler || 'k_euler_ancestral', scale: Number(pipeline.config.scale) || 5.5,
      actualAnlas: null, note: '保存的生成输入；底层客户端仍执行其载荷归一化，费用未知不填零。' };
  }
  async candidateContext(args, loc, panel, candidate) {
    const currentPlanHash = await this.planHash(loc, panel);
    const images = [await this.imageInfo(loc.dir, candidate.imagePath)];
    check(images[0].sha256 === candidate.imageSha256, 409, 'IMAGE_CHANGED', '候选图片校验值已变化');
    const index = loc.episode.panelOrder.indexOf(panel.panelId);
    const previous = index > 0 ? loc.episode.panels[loc.episode.panelOrder[index - 1]] : null;
    if (previous && previous.plan.sceneId === panel.plan.sceneId) {
      const reference = previous.candidates.find(c => c.candidateId === previous.approval?.candidateId) || previous.candidates.at(-1);
      if (reference) {
        const image = await this.imageInfo(loc.dir, reference.imagePath);
        check(image.sha256 === reference.imageSha256, 409, 'IMAGE_CHANGED', '前格参考图片发生变化');
        images.push(image);
      }
    }
    const ctx = await this.scene(args, panel);
    const dna = Object.fromEntries(panel.plan.characterNames.map(name => [name,
      ctx.pipeline.projectProgress.getCharacterDNAForChapter(name, ctx.pipeline.chapters.indexOf(ctx.chap))]));
    const plannedEntryState = this.entryState(loc.episode, panel.panelId);
    const contextHash = hash({ currentPlanHash, request: candidate.request, dna, plannedEntryState,
      previousPlan: previous && previous.plan.sceneId === panel.plan.sceneId ? artwork(previous.plan) : null,
      images: images.map(i => ({ sha256: i.sha256, width: i.width, height: i.height })) });
    const qc = candidate.planHash !== currentPlanHash ? 'PLAN_CHANGED' : !candidate.qc ? 'PENDING'
      : candidate.qc.contextHash !== contextHash ? 'STALE' : candidate.qc.verdict;
    return { projectName: args.projectName, episodeId: args.episodeId, panelId: panel.panelId,
      candidateId: candidate.candidateId, plan: panel.plan, request: candidate.request, dna,
      previousPlan: previous?.plan || null, plannedEntryState, images,
      imageSha256: candidate.imageSha256, contextHash, qcStatus: qc, humanApproved: false };
  }
  async approved(args, loc) {
    const accepted = [];
    check(loc.episode.panelOrder.length, 409, 'EMPTY_EPISODE', 'EP 尚无画格');
    for (const pid of loc.episode.panelOrder) {
      const panel = loc.episode.panels[pid];
      check(!unresolvedRender(panel.activeRender), 409, 'PENDING_RENDER', '仍有待处理或待核查的生图任务');
      const decision = panel.approval;
      const candidate = panel.candidates.find(c => c.candidateId === decision?.candidateId);
      check(candidate && decision.channel === 'human-browser-workbench' && decision.planContentHash === hash(panel.plan), 409, 'HUMAN_QC_REQUIRED', `${pid} 尚未人工批准或审批已过期`);
      const context = await this.candidateContext(args, loc, panel, candidate);
      check(context.qcStatus === 'PASS' && context.contextHash === decision.contextHash
        && candidate.imageSha256 === decision.imageSha256, 409, 'STALE_APPROVAL', `${pid} 预检或人工审批已过期`);
      accepted.push({ panel, candidate, decision, imagePath: context.images[0].path,
        entryState: context.plannedEntryState, exitState: { ...context.plannedEntryState, ...panel.plan.stateDelta } });
    }
    return accepted;
  }
  assemblyHash(episode, approved) {
    return hash({ title: episode.title, language: episode.language, layout: episode.layout, order: episode.panelOrder,
      items: approved.map(i => ({ plan: i.panel.plan, imageSha256: i.candidate.imageSha256, approval: i.decision,
        qc: i.candidate.qc, request: i.candidate.request, entryState: i.entryState, exitState: i.exitState })) });
  }
  async snapshot(args) {
    const loc = await this.load(args);
    const rows = [];
    for (const pid of loc.episode.panelOrder) {
      const panel = loc.episode.panels[pid];
      let activeRender = panel.activeRender;
      if (panel.activeRender && ['QUEUED', 'RUNNING'].includes(panel.activeRender.status)) {
        const state = this.actionState(panel.activeRender.actionId);
        if (state && !['ACCEPTED', 'QUEUED', 'RUNNING'].includes(state)) activeRender = { ...panel.activeRender, status: state };
      }
      const candidates = [];
      for (const candidate of panel.candidates) {
        try {
          const context = await this.candidateContext(args, loc, panel, candidate);
          const approval = panel.approval;
          candidates.push({ ...candidate, contextHash: context.contextHash, qcStatus: context.qcStatus,
            imageUrl: `/projects/${encodeURIComponent(args.projectName)}/${candidate.imagePath.split('/').map(encodeURIComponent).join('/')}`,
            humanApproved: context.qcStatus === 'PASS' && approval?.candidateId === candidate.candidateId
              && approval.contextHash === context.contextHash && approval.planContentHash === hash(panel.plan) });
        } catch (error) { candidates.push({ ...candidate, qcStatus: 'UNAVAILABLE', error: error.publicMessage ? error.message : '候选读取失败', humanApproved: false }); }
      }
      let generationInput = null;
      try { const ctx = await this.scene(args, panel); generationInput = { ...this.request(ctx.pipeline, ctx.target), promptReady: Boolean(ctx.target.final_prompt) }; } catch { /* show link error through candidates / next edit */ }
      rows.push({ ...panel, activeRender, candidates, generationInput, plannedEntryState: this.entryState(loc.episode, pid) });
    }
    let readyToAssemble = false; let assemblyStatus = 'BLOCKED'; let reason = '';
    try {
      const accepted = await this.approved(args, loc);
      const { pipeline } = await this.resolve(args);
      readyToAssemble = !this.queueState(args.projectName).busy && !pipeline.isRunning && !pipeline.comicProductionJob;
      assemblyStatus = loc.episode.assembly?.inputHash === this.assemblyHash(loc.episode, accepted)
        ? loc.episode.assembly.review?.verdict === 'PASS' ? 'SIGNED_OFF' : 'LAYOUT_REVIEW_REQUIRED' : 'READY_TO_ASSEMBLE';
    } catch (error) { reason = error.publicMessage ? error.message : '请检查画格状态'; }
    return { ...loc.episode, production: this.production.status(loc.episode), panels: rows, episodeHash: hash(loc.episode), readyToAssemble, assemblyStatus, reason,
      previewUrl: loc.episode.assembly ? `/projects/${encodeURIComponent(args.projectName)}/${loc.episode.assembly.directory}/preview.html` : null };
  }
  async execute(name, args, actionId, owner = null) {
    if (name === 'comics.sources.get') {
      const { pipeline, chap, chapterKey } = await this.resolve(args);
      return { chapters: pipeline.chapters.map(c => ({ chapterKey: pipeline.projectProgress.getEffectiveChapKey(c.volume, c.chapter),
        title: c.chapter, volume: c.volume, characterCount: c.content.length })), characters: pipeline.projectProgress.getGlobalCharacters(),
        ...(chap ? { chapterKey, content: chap.content } : {}) };
    }
    if (['comics.storyboard.generate', 'comics.prompts.generate', 'comics.images.generate'].includes(name)) return this.production.start(name, args, actionId);
    if (name === 'comics.production.stop') return this.production.stop(args);
    if (name === 'comics.episodes.list') {
      const loc = await this.location(args);
      const files = await fs.readdir(path.join(loc.comicDir, 'episodes')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      const result = [];
      for (const file of files.filter(f => /^[A-Za-z][A-Za-z0-9_-]*\.json$/.test(f))) {
        const ep = await readJson(path.join(loc.comicDir, 'episodes', file));
        result.push({ episodeId: ep.episodeId, title: ep.title, language: ep.language, panelCount: ep.panelOrder.length });
      }
      return result;
    }
    if (name === 'comics.episodes.create') {
      const loc = await this.location(args);
      check(!await readJson(loc.episodePath, null), 409, 'EP_EXISTS', 'EP 已存在');
      loc.episode = { schemaVersion: 'nai-comic-episode/1.0', episodeId: args.episodeId, title: args.title,
        language: args.language || 'zh-CN', initialState: args.initialState || {}, panelOrder: [], panels: {},
        layout: { width: 800, fontSize: 32, sliceHeight: 4096 }, humanActions: {}, assembly: null, createdAt: now() };
      await this.save(loc);
      return this.snapshot(args);
    }
    if (name === 'comics.episodes.get') return this.snapshot(args);
    const loc = await this.load(args);
    const { episode } = loc;
    const { pipeline } = await this.resolve({ projectName: args.projectName });
    if (['comics.episodes.update', 'comics.panels.add', 'comics.panels.update', 'comics.prompts.write',
      'comics.panels.render', 'comics.candidates.capture', 'comics.renders.resolve', 'comics.assemble', 'comics.export',
      'comics.storyboard.apply'].includes(name)) this.editable(episode, args, pipeline, owner);
    if (name === 'comics.storyboard.apply') {
      check(!episode.panelOrder.length, 409, 'EMPTY_EP_REQUIRED', '采用完整分镜草稿需要空白 EP，已有画格请逐格编辑');
      const validated = [];
      for (const raw of args.plans) validated.push(await this.validatePlan(args, raw));
      const added = new Map();
      for (const [i, { plan, ctx }] of validated.entries()) {
        const panelId = `P${String(i + 1).padStart(3, '0')}`;
        const scenes = added.get(ctx.chapterKey)?.scenes || ctx.scenes;
        const sceneIdx = Math.max(0, ...scenes.map(s => Number(s.scene_idx) || 0)) + 1;
        scenes.push({ ...this.sceneCard(plan), scene_idx: sceneIdx, status: 'PENDING', source: 'comic',
          comic_panel_id: panelId, comic_episode_id: args.episodeId, width: plan.width, height: plan.height });
        added.set(ctx.chapterKey, { scenes, pipeline: ctx.pipeline });
        episode.panels[panelId] = { panelId, sceneRef: { chapterKey: ctx.chapterKey, sceneIdx }, plan,
          candidates: [], renders: [], activeRender: null, approval: null };
        episode.panelOrder.push(panelId);
      }
      for (const [key, item] of added) item.pipeline.projectProgress.setChapterStatus(key, 'pending', item.scenes);
      await pipeline.projectProgress.save();
      if (episode.storyboardDraft) episode.storyboardDraft.appliedAt = now();
      if (episode.production?.type === 'comics.storyboard.generate' && episode.production.status === 'DONE') episode.production.message = '分镜已采用，可以准备提示词与生图';
      await this.save(loc); return this.snapshot(args);
    }
    if (name === 'comics.episodes.update') {
      if (args.panelOrder) check(args.panelOrder.length === episode.panelOrder.length
        && args.panelOrder.every(pid => Object.hasOwn(episode.panels, pid)), 400, 'INVALID_ORDER', '阅读顺序必须包含本话每一格且不可重复');
      for (const key of ['title', 'initialState', 'panelOrder']) if (args[key] !== undefined) episode[key] = args[key];
      if (args.layout) {
        const next = { ...episode.layout, ...args.layout };
        check(next.fontSize * 360 / next.width >= 12, 400, 'SMALL_FONT', '手机宽度下字号至少 12px');
        episode.layout = next;
      }
      await this.save(loc); return this.snapshot(args);
    }
    if (name === 'comics.panels.add' || name === 'comics.panels.update') {
      id(args.panelId);
      const { plan, ctx } = await this.validatePlan(args, args.plan);
      if (name.endsWith('.add')) {
        check(!Object.hasOwn(episode.panels, args.panelId), 409, 'PANEL_EXISTS', '画格 ID 已存在');
        const sceneIdx = Math.max(0, ...ctx.scenes.map(s => Number(s.scene_idx) || 0)) + 1;
        ctx.scenes.push({ ...this.sceneCard(plan), scene_idx: sceneIdx, status: 'PENDING',
          source: 'comic', comic_panel_id: args.panelId, comic_episode_id: args.episodeId,
          width: plan.width, height: plan.height });
        ctx.pipeline.projectProgress.setChapterStatus(ctx.chapterKey, 'pending', ctx.scenes);
        await ctx.pipeline.projectProgress.save();
        episode.panels[args.panelId] = { panelId: args.panelId, sceneRef: { chapterKey: ctx.chapterKey, sceneIdx },
          plan, candidates: [], renders: [], activeRender: null, approval: null };
        episode.panelOrder.push(args.panelId);
      } else {
        const panel = this.panel(episode, args.panelId);
        check(plan.chapterKey === panel.sceneRef.chapterKey, 400, 'CHAPTER_LOCKED', '已有画格不能改换原文章节，新增画格承接新章节');
        const linked = await this.scene(args, panel);
        if (hash(artwork(panel.plan)) !== hash(artwork(plan))) {
          Object.assign(linked.target, this.sceneCard(plan), { status: 'PENDING', width: plan.width, height: plan.height });
          for (const key of ['final_prompt', 'base_prompt', 'character_prompts', 'final_negative', 'negative_character_prompts', 'prepared_prompt']) delete linked.target[key];
          await linked.pipeline.projectProgress.save();
        }
        panel.plan = plan;
      }
      await this.save(loc); return this.snapshot(args);
    }
    if (name === 'comics.prompts.write') {
      const panel = this.panel(episode, args.panelId);
      const ctx = await this.scene(args, panel);
      check(args.characterPrompts.length === panel.plan.characterNames.length, 400, 'CHARACTER_SLOTS', '人物 Prompt 段应与分镜人物数量和顺序一致');
      const estimate = estimateV45Tokens([args.basePrompt, ...args.characterPrompts].join(', '));
      check(estimate <= 460, 400, 'PROMPT_BUDGET', `估算正向预算 ${estimate} 超过 460，请由 LLM 精简`);
      await this.dispatch('prompts.write', { projectName: args.projectName, ...panel.sceneRef,
        expectedSceneHash: hash(ctx.target), basePrompt: args.basePrompt, negativePrompt: args.negativePrompt,
        characterPrompts: args.characterPrompts, ...(args.negativeCharacterPrompts ? { negativeCharacterPrompts: args.negativeCharacterPrompts } : {}),
        width: panel.plan.width, height: panel.plan.height }, actionId);
      panel.promptBudget = { estimatedTokens: estimate, exact: false, target: 400, hardLimit: 460 };
      await this.save(loc); return this.snapshot(args);
    }
    if (name === 'comics.panels.render') {
      const panel = this.panel(episode, args.panelId);
      check(!unresolvedRender(panel.activeRender), 409, 'RENDER_REVIEW_REQUIRED', '先核查未完成的本格生成任务');
      check(panel.renders.filter(r => r.dispatched !== false).length < 4 && panel.candidates.length < 4, 409, 'ATTEMPTS_EXHAUSTED', '含首图最多四次生成，耗尽后交人工核查');
      const ctx = await this.scene(args, panel);
      check(ctx.target.final_prompt, 409, 'PROMPT_REQUIRED', '先保存本格 Prompt');
      ctx.target.render_seed = randomInt(0, 4294967296);
      await ctx.pipeline.projectProgress.save();
      const render = { actionId, status: 'QUEUED', request: this.request(ctx.pipeline, ctx.target), createdAt: now(), planHash: await this.planHash(loc, panel) };
      panel.renders.push(render); panel.activeRender = render;
      await this.save(loc);
      try {
        return await this.dispatch('scenes.render', { projectName: args.projectName, ...panel.sceneRef,
          expectedSceneHash: hash(ctx.target), confirmCosts: true }, actionId);
      } catch (error) {
        render.status = 'NOT_DISPATCHED'; render.dispatched = false;
        await this.save(loc); throw error;
      }
    }
    if (name === 'comics.candidates.capture' || name === 'comics.renders.resolve') {
      const panel = this.panel(episode, args.panelId);
      if (name === 'comics.renders.resolve') {
        check(panel.activeRender && !['DONE', 'NOT_DISPATCHED', 'RESOLVED'].includes(panel.activeRender.status), 409, 'NO_UNRESOLVED_RENDER', '本格没有待核查的生成任务');
        if (args.resolution === 'capture-current') {
          check(panel.activeRender.planHash === await this.planHash(loc, panel), 409, 'PLAN_CHANGED', '中断生成的计划已改变，不能收录为当前计划候选');
          await this.capture(args, loc, panel, panel.activeRender.request);
        }
        panel.activeRender.status = 'RESOLVED'; panel.activeRender.resolution = args.resolution; panel.activeRender.note = args.note;
      } else await this.capture(args, loc, panel);
      await this.save(loc); return this.snapshot(args);
    }
    if (name === 'comics.qc.tasks') {
      const tasks = [];
      for (const pid of episode.panelOrder) for (const candidate of episode.panels[pid].candidates) {
        const ctx = await this.candidateContext(args, loc, episode.panels[pid], candidate);
        if (['PENDING', 'STALE'].includes(ctx.qcStatus)) tasks.push(ctx);
        if (tasks.length >= (args.limit || 4)) return tasks;
      }
      return tasks;
    }
    if (name === 'comics.qc.submit') {
      const panel = this.panel(episode, args.panelId);
      const candidate = panel.candidates.find(c => c.candidateId === args.candidateId);
      check(candidate, 404, 'CANDIDATE_NOT_FOUND', '候选不存在');
      const ctx = await this.candidateContext(args, loc, panel, candidate);
      check(ctx.qcStatus !== 'PLAN_CHANGED' && ctx.contextHash === args.contextHash && ctx.imageSha256 === args.imageSha256,
        409, 'STALE_QC', '本格导演计划、图片或参考已变化，不能复用旧结论');
      check(args.examinedImages.length === ctx.images.length && ctx.images.every(i => args.examinedImages.some(e => e.path === i.path && e.sha256 === i.sha256)), 400, 'MISSING_EVIDENCE', '需实际查看任务内全部图片并记录路径/hash');
      for (const [axis, result] of Object.entries(args.criteria)) if (result.result === 'N_A') {
        check(axis === 'C3' || !panel.plan.characterNames.length && ['C1', 'C2', 'C8'].includes(axis), 400, 'INVALID_QC', `${axis} 不允许 N_A`);
      }
      const results = Object.values(args.criteria).map(c => c.result);
      const verdict = results.includes('FAIL') ? 'FAIL' : results.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS';
      const report = { ...args, reportId: `Q_${randomUUID()}`, verdict, reviewerType: 'agent', createdAt: now() };
      candidate.qc = report; candidate.qcHistory.push(report);
      await this.save(loc);
      return { reportId: report.reportId, verdict, humanApproved: false };
    }
    if (name === 'comics.assemble' || name === 'comics.export') {
      const accepted = await this.approved(args, loc);
      const inputHash = this.assemblyHash(episode, accepted);
      if (name === 'comics.assemble') {
        const assemblyId = `A_${randomUUID()}`;
        const directory = `comic/layout/${args.episodeId}/${assemblyId}`;
        const output = await composeComic({ episode, approved: accepted, outputDir: path.join(loc.dir, directory), inputHash });
        episode.assembly = { assemblyId, directory, inputHash, checksums: output.checksums, createdAt: now(), review: null };
        await this.save(loc); return this.snapshot(args);
      }
      check(episode.assembly?.inputHash === inputHash && episode.assembly.review?.verdict === 'PASS', 409, 'LAYOUT_REVIEW_REQUIRED', '先组装并完成人工排版终审');
      const exportId = `E_${randomUUID()}`;
      const relative = `comic/exports/${args.episodeId}/${exportId}.zip`;
      await fs.mkdir(path.dirname(path.join(loc.dir, relative)), { recursive: true });
      const output = await exportComic({ episode, approved: accepted, assembly: episode.assembly,
        assemblyDir: path.join(loc.dir, episode.assembly.directory), outputPath: path.join(loc.dir, relative) });
      episode.lastExport = { exportId, path: relative, sha256: output.imageSha256, bytes: output.bytes,
        url: `/projects/${encodeURIComponent(args.projectName)}/${relative}`, inputHash, createdAt: now() };
      await this.save(loc); return episode.lastExport;
    }
    check(false, 404, 'UNKNOWN_ACTION', '未知漫画操作');
  }
  async renderFinished(args, current, error) {
    if (!current?.comic_episode_id || !current.comic_panel_id) return;
    const linked = { projectName: args.projectName, episodeId: current.comic_episode_id, panelId: current.comic_panel_id };
    const loc = await this.load(linked);
    const panel = this.panel(loc.episode, linked.panelId);
    if (!panel.activeRender || panel.activeRender.actionId !== args.actionId) return;
    if (error || current.status !== 'SUCCESS') panel.activeRender.status = 'FAILED_REVIEW_REQUIRED';
    else {
      check(panel.activeRender.planHash === await this.planHash(loc, panel), 409, 'PLAN_CHANGED', '生成期间导演计划变化，请核查');
      const candidate = await this.capture(linked, loc, panel, panel.activeRender.request);
      panel.activeRender.status = 'DONE'; panel.activeRender.candidateId = candidate.candidateId;
    }
    await this.save(loc);
  }
  async human(args, payload) {
    const loc = await this.load(args);
    const { pipeline } = await this.resolve(args);
    check(!pipeline.comicProductionJob, 409, 'BUSY', '漫画创作任务正在运行，请等待完成后审批');
    const { episode } = loc;
    check(typeof payload.actionId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(payload.actionId)
      && !Object.hasOwn(Object.prototype, payload.actionId), 400, 'ACTION_ID_REQUIRED', '人工操作缺少 actionId');
    const fingerprint = hash(payload);
    if (Object.hasOwn(episode.humanActions, payload.actionId)) {
      const old = episode.humanActions[payload.actionId];
      check(old.fingerprint === fingerprint, 409, 'ACTION_ID_CONFLICT', '人工 actionId 请求冲突');
      return { replayed: true, action: old };
    }
    check(payload.expectedEpisodeHash === hash(episode), 409, 'STALE_EPISODE', '内容已变化，请刷新后再操作');
    check(['approve', 'reject', 'comment', 'layout-pass', 'layout-reject'].includes(payload.action), 400, 'INVALID_ACTION', '未知人工操作');
    const receipt = { actionId: payload.actionId, action: payload.action, fingerprint, channel: 'human-browser-workbench',
      createdAt: now(), comment: typeof payload.comment === 'string' ? payload.comment.slice(0, 5000) : '' };
    const points = payload.points || [];
    check(Array.isArray(points) && points.length <= 20 && points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)
      && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), 400, 'INVALID_POINTS', '批注坐标必须在画面内');
    receipt.points = points.map(p => ({ x: p.x, y: p.y, comment: typeof p.comment === 'string' ? p.comment.slice(0, 1000) : '' }));
    if (payload.action.startsWith('layout-')) {
      const accepted = await this.approved(args, loc);
      check(episode.assembly && episode.assembly.inputHash === this.assemblyHash(episode, accepted), 409, 'STALE_LAYOUT', '组装已过期，请重新组装');
      for (const [filename, checksum] of Object.entries(episode.assembly.checksums)) check(
        digest(await fs.readFile(path.join(loc.dir, episode.assembly.directory, filename))) === checksum, 409, 'STALE_LAYOUT', '排版文件已变化，请重新组装');
      episode.assembly.review = { ...receipt, verdict: payload.action === 'layout-pass' ? 'PASS' : 'FAIL', inputHash: episode.assembly.inputHash };
    } else {
      const panel = this.panel(episode, payload.panelId);
      const candidate = panel.candidates.find(c => c.candidateId === payload.candidateId);
      check(candidate && candidate.imageSha256 === payload.imageSha256, 409, 'STALE_IMAGE', '人工审稿候选已变化');
      const ctx = await this.candidateContext(args, loc, panel, candidate);
      Object.assign(receipt, { panelId: panel.panelId, candidateId: candidate.candidateId, imageSha256: candidate.imageSha256,
        contextHash: ctx.contextHash, planContentHash: hash(panel.plan) });
      if (payload.action === 'approve') {
        check(ctx.qcStatus === 'PASS' && payload.contextHash === ctx.contextHash, 409, 'AGENT_QC_REQUIRED', '该候选必须具有当前有效的 Agent 预检 PASS');
        const anchors = payload.speakerAnchors || {};
        for (const speaker of new Set(panel.plan.dialogue.filter(d => d.type !== 'narration').map(d => d.speakerId))) {
          const anchor = anchors[speaker];
          check(anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) && anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1,
            400, 'SPEAKER_ANCHOR_REQUIRED', `请在原图定位说话角色：${speaker}`);
        }
        receipt.speakerAnchors = anchors;
        panel.approval = receipt;
      } else if (payload.action === 'reject') {
        check(receipt.comment.trim(), 400, 'COMMENT_REQUIRED', '退修请填写具体问题');
        if (panel.approval?.candidateId === candidate.candidateId) panel.approval = null;
      }
    }
    episode.humanActions[payload.actionId] = receipt;
    await this.save(loc);
    return { replayed: false, action: receipt };
  }
}
