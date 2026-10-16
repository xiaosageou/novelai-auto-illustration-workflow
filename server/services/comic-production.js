import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from './comic-composer.js';
import { COMIC_PLAN_SCHEMA } from './comic-contract.js';
import { ComicTextGenerator } from './comic-text-generator.js';

const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const hash = value => digest(canonical(value));
const running = status => ['ACCEPTED', 'QUEUED', 'RUNNING', 'STOPPING'].includes(status);
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409, publicMessage: true }); };
const promptSchema = { type: 'object', properties: {
  basePrompt: { type: 'string', minLength: 1 }, negativePrompt: { type: 'string' },
  characterPrompts: { type: 'array', items: { type: 'string', minLength: 1 } },
  negativeCharacterPrompts: { type: 'array', items: { type: 'string' } }
}, required: ['basePrompt', 'negativePrompt', 'characterPrompts', 'negativeCharacterPrompts'], additionalProperties: false };

export class ComicProduction {
  constructor(comic, { locked, finish, submit, validate, generator }) {
    Object.assign(this, { comic, locked, finish, submit, validate });
    this.generator = generator || new ComicTextGenerator();
    this.jobs = new Map();
  }
  async contextFingerprint(loc, pipeline) {
    return hash({ book: digest(await fs.readFile(path.join(loc.dir, 'book.txt'))),
      dna: pipeline.projectProgress.getGlobalCharacters(), style: pipeline.config.artistStylePrompt,
      extra: pipeline.config.extra_prompt, negative: pipeline.config.negative_prompt });
  }
  status(episode) {
    const item = episode.production;
    if (!item) return null;
    const state = this.comic.actionState(item.actionId);
    return running(item.status) && state && !running(state) ? { ...item, status: state } : item;
  }
  requestStop(projectName) {
    const job = this.jobs.get(projectName);
    if (job) job.stopRequested = true;
  }
  async stop(args) {
    const loc = await this.comic.load(args);
    if (args.expectedProductionActionId ? loc.episode.production?.actionId !== args.expectedProductionActionId
      : hash(loc.episode) !== args.expectedEpisodeHash) fail('STALE_EPISODE', '任务或内容已变化，请刷新后停止');
    const job = this.jobs.get(args.projectName);
    if (job?.args.episodeId === args.episodeId) {
      job.stopRequested = true;
      loc.episode.production.status = 'STOPPING';
      loc.episode.production.message = '已请求停止，等待当前远程调用结束';
    } else {
      if (!loc.episode.production || !running(loc.episode.production.status)) fail('NO_ACTIVE_PRODUCTION', '本话没有待处理或中断的创作任务');
      loc.episode.production.status = 'RESOLVED';
      loc.episode.production.message = '中断任务已记录，不会自动重投；生图结果仍需逐格核查';
    }
    await this.comic.save(loc);
    return this.comic.snapshot(args);
  }
  async start(name, args, actionId) {
    const loc = await this.comic.load(args);
    const { pipeline } = await this.comic.resolve(args);
    this.comic.editable(loc.episode, args, pipeline);
    if (loc.episode.production && running(loc.episode.production.status)) fail('PRODUCTION_REVIEW_REQUIRED', '先停止或核查上次中断的创作任务');
    const ids = args.panelIds || loc.episode.panelOrder;
    for (const pid of ids) this.comic.panel(loc.episode, pid);
    let source;
    if (name === 'comics.storyboard.generate') {
      if (loc.episode.panelOrder.length) fail('EMPTY_EP_REQUIRED', '自动分镜草稿用于空白 EP，请新建一话；已有画格可逐格编辑');
      const ctx = await this.comic.resolve({ projectName: args.projectName, chapterKey: args.chapterKey });
      source = args.sourceSelection?.trim() || ctx.chap.content;
      if (!ctx.chap.content.includes(source)) fail('INVALID_SOURCE', '所选原文必须完整匹配章节内容');
      if (source.length > 40000) fail('SOURCE_TOO_LONG', '本次原文超过40000字，请选择章节中的一段或拆为多话');
    } else if (!ids.length) fail('EMPTY_EPISODE', '请先生成或添加画格');
    const job = { args, actionId, name, pipeline, ids, source, stopRequested: false,
      fingerprint: await this.contextFingerprint(loc, pipeline) };
    this.jobs.set(args.projectName, job); pipeline.comicProductionJob = actionId;
    loc.episode.production = { actionId, type: name, status: 'RUNNING', completed: 0,
      total: name === 'comics.storyboard.generate' ? args.panelCount : ids.length, message: '任务已启动', startedAt: new Date().toISOString() };
    try { await this.comic.save(loc); }
    catch (error) { this.jobs.delete(args.projectName); pipeline.comicProductionJob = null; throw error; }
    setImmediate(() => { void this.run(job); });
    return { jobId: actionId, status: 'RUNNING', generated: false };
  }
  assertRunning(job) {
    if (job.stopRequested) fail('PRODUCTION_STOPPED', '创作任务已停止');
  }
  async current(job) {
    this.assertRunning(job);
    const loc = await this.comic.load(job.args);
    if (loc.episode.production?.actionId !== job.actionId) fail('PRODUCTION_CHANGED', '创作任务已变化');
    if (await this.contextFingerprint(loc, job.pipeline) !== job.fingerprint) fail('PRODUCTION_CONTEXT_CHANGED', '原文、角色或画风配置已改变，请重新检查生成内容');
    return loc;
  }
  async progress(job, completed, message) {
    await this.locked(async () => {
      const loc = await this.current(job);
      Object.assign(loc.episode.production, { completed, message });
      await this.comic.save(loc);
    });
  }
  async preparePrompt(job, pid, rewrite = false) {
    const input = await this.locked(async () => {
      const loc = await this.current(job); const panel = this.comic.panel(loc.episode, pid);
      const ctx = await this.comic.scene(job.args, panel);
      if (ctx.target.final_prompt && !rewrite) return null;
      return { pipeline: job.pipeline, plan: structuredClone(panel.plan),
        dna: Object.fromEntries(panel.plan.characterNames.map(name => [name,
          job.pipeline.projectProgress.getCharacterDNAForChapter(name, job.pipeline.chapters.indexOf(ctx.chap))])),
        entryState: this.comic.entryState(loc.episode, pid), validate: value => this.validate(promptSchema, value) };
    });
    if (!input) return;
    const prompt = await this.generator.prompt(input);
    this.validate(promptSchema, prompt);
    await this.locked(async () => {
      const loc = await this.current(job);
      await this.comic.execute('comics.prompts.write', { ...job.args, panelId: pid,
        expectedEpisodeHash: hash(loc.episode), ...prompt }, job.actionId, job.actionId);
    });
  }
  async work(job) {
    if (job.name === 'comics.storyboard.generate') {
      const original = await this.locked(() => this.current(job));
      const plans = [];
      // 单批过大时模型会截断；这里把一批拆成两半递归重试，直到单格粒度。
      const runBatch = async (count) => {
        this.assertRunning(job);
        try {
          return await this.generator.storyboard({ pipeline: job.pipeline, chapterKey: job.args.chapterKey,
            source: job.source, title: original.episode.title, language: original.episode.language,
            initialState: original.episode.initialState, count, previous: plans,
            instructions: `全话总计 ${job.args.panelCount} 格。${job.args.instructions || ''}`,
            validate: async plan => { this.validate(COMIC_PLAN_SCHEMA, plan); await this.comic.validatePlan(job.args, plan); } });
        } catch (error) {
          if (error.code === 'COMIC_LLM_TRUNCATED' && count > 1) {
            const half = Math.floor(count / 2);
            await this.progress(job, plans.length, `分镜批次截断，拆为 ${half}+${count - half} 格重试`);
            return [...await runBatch(half), ...await runBatch(count - half)];
          }
          throw error;
        }
      };
      while (plans.length < job.args.panelCount) {
        this.assertRunning(job);
        const count = Math.min(4, job.args.panelCount - plans.length);
        const batch = await runBatch(count);
        // 模型可能少给几格：接受已给出的部分，循环会继续补齐剩余格数。
        if (!Array.isArray(batch) || !batch.length) fail('INVALID_STORYBOARD', '分镜数量与计划不一致');
        for (const plan of batch) {
          this.validate(COMIC_PLAN_SCHEMA, plan); const normalized = await this.comic.validatePlan(job.args, plan);
          if (!job.source.includes(normalized.plan.sourceExcerpt)) fail('INVALID_SOURCE', '模型分镜引用了所选原文范围之外的内容');
          plans.push(normalized.plan);
        }
        await this.progress(job, plans.length, `分镜草稿 ${plans.length}/${job.args.panelCount} 格，尚未采用`);
      }
      await this.locked(async () => {
        const loc = await this.current(job);
        loc.episode.storyboardDraft = { plans, chapterKey: job.args.chapterKey, sourceSelection: job.source,
          instructions: job.args.instructions || '', actionId: job.actionId, createdAt: new Date().toISOString(), sourceHash: job.fingerprint };
        await this.comic.save(loc);
      });
      return { panelCount: plans.length, reviewDraft: true };
    }
    let completed = 0;
    const failed = [];
    // 提示词阶段只有 LLM 调用是瓶颈（单格约 40s），端点实测可承受 8 并发；
    // 生图阶段必须串行（渲染队列 + 冷却），所以只对 prompts 走并发。
    const runPanel = async (pid) => {
      this.assertRunning(job);
      // 单格失败不再中断整批：记录后继续，避免一格把 18 格的活全废掉。
      try {
        if (job.name === 'comics.images.generate' && job.args.mode !== 'reroll') {
          const skip = await this.locked(async () => {
            const loc = await this.current(job); const panel = this.comic.panel(loc.episode, pid);
            const planHash = await this.comic.planHash(loc, panel);
            return panel.candidates.some(c => c.planHash === planHash);
          });
          if (skip) { await this.progress(job, ++completed, `${pid} 已有当前候选，已跳过`); return; }
        }
        await this.progress(job, completed, `${pid} · 正在准备提示词`);
        await this.preparePrompt(job, pid, job.args.rewrite || job.args.rebuildPrompts);
        if (job.name === 'comics.images.generate') {
          const childId = `comic-render-${hash([job.actionId, pid]).slice(0, 32)}`;
          const args = await this.locked(async () => {
            const loc = await this.current(job);
            return { projectName: job.args.projectName, episodeId: job.args.episodeId, panelId: pid,
              expectedEpisodeHash: hash(loc.episode), confirmCosts: true };
          });
          await this.submit('comics.panels.render', args, childId, job.actionId);
          await this.progress(job, completed, `${pid} · 正在生图 / 等待冷却`);
          while (['ACCEPTED', 'QUEUED', 'RUNNING'].includes(this.comic.actionState(childId))) await delay(250);
          if (this.comic.actionState(childId) !== 'DONE') fail('COMIC_RENDER_REVIEW_REQUIRED', `${pid} 生图结果需核查，已停止后续生成`);
          while (this.comic.queueState(job.args.projectName).busy) await delay(100);
        }
        await this.progress(job, ++completed, `${pid} · ${job.name === 'comics.images.generate' ? '候选已收录，等待视觉预检' : '提示词已保存'}`);
      } catch (error) {
        failed.push({ panelId: pid, code: error.code || 'COMIC_PANEL_FAILED', message: error.publicMessage ? error.message : String(error.message || error) });
        await this.progress(job, completed, `${pid} 失败已跳过：${error.code || ''} ${error.publicMessage ? error.message : ''}`.slice(0, 160));
      }
    };
    if (job.name === 'comics.prompts.generate') {
      const CONCURRENCY = 6;
      const queue = [...job.ids];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const pid = queue.shift();
          if (pid === undefined) break;
          await runPanel(pid);
        }
      });
      await Promise.all(workers);
    } else {
      for (const pid of job.ids) await runPanel(pid);
    }
    return { completed, failed, inspectCandidates: job.name === 'comics.images.generate' };
  }
  async run(job) {
    let status = 'DONE'; let result;
    try { result = await this.work(job); }
    catch (error) {
      status = job.stopRequested ? 'STOPPED_REVIEW_REQUIRED' : 'FAILED_REVIEW_REQUIRED';
      result = { code: error.code || 'COMIC_PRODUCTION_FAILED', message: error.publicMessage ? error.message : '漫画创作失败，请检查模型配置和任务记录' };
    }
    try {
      await this.locked(async () => {
        const loc = await this.comic.load(job.args);
        if (loc.episode.production?.actionId === job.actionId) {
          Object.assign(loc.episode.production, { status, finishedAt: new Date().toISOString(),
            message: status === 'DONE' ? job.name === 'comics.storyboard.generate' ? '草稿已生成，请检查并采用' : '任务完成' : result.message });
          await this.comic.save(loc);
        }
      });
      await this.finish(job.actionId, status, result);
    } catch { this.comic.notify('comic_production_error', { projectName: job.args.projectName, message: '任务落盘失败，请核查' }); }
    finally { job.pipeline.comicProductionJob = null; this.jobs.delete(job.args.projectName); }
  }
}
