import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { readJson, writeJsonAtomic } from '../utils/db.js';
import { normalizeSceneCard } from '../utils/scene-structure.js';
import { randomBytes } from 'node:crypto';
import { ComicService } from './comic-service.js';
import { COMIC_ACTIONS } from './comic-contract.js';

const VERSION = '1.2';
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const text = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const strings = { type: 'array', items: { type: 'string' } };
const project = { projectName: text };
const chapter = { ...project, chapterKey: text };
const scene = { ...chapter, sceneIdx: integer };
const criteria = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`C${i + 1}`, object({
  result: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN', 'N_A'] }, evidence: text
})]));
const cardFields = {
  trigger_sentence: text, visual_description: text, core_action: { type: 'string' }, sex_position: { type: 'string' },
  environment: { type: 'string' }, cinematography: { type: 'string' }, interactions: { type: 'string' },
  plot_traces: { type: 'string' }, text_elements: { type: 'string' },
  character_names: strings, must_show: strings, must_not_show: strings,
  nsfw_rating: { type: 'string', enum: ['sfw', 'nsfw_mild', 'nsfw_moderate', 'nsfw_explicit'] },
  characters: { type: 'array', maxItems: 4, items: object(Object.fromEntries(
    ['name', 'gender', 'appearance', 'clothing', 'expression', 'pose', 'position'].map(k => [k, { type: 'string' }])
  ), ['name']) },
  interaction_actions: { type: 'array', items: object({ action: text, source: text, target: text, mutual: { type: 'boolean' } }, ['action', 'source', 'target']) },
  visual_entities: { type: 'array', items: object({ type: text, description: text, count: integer, position: { type: 'string' }, must_show: { type: 'boolean' } }, ['type', 'description']) }
};

const action = (description, properties, required, mutation = false, costs = false) => ({
  description, inputSchema: object(properties, required), mutation, costs
});
export const AGENT_ACTIONS = {
  ...COMIC_ACTIONS,
  'projects.list': action('列出小说项目', {}, []),
  'projects.create': action('新建项目并保存原文；已有项目不可覆盖', { ...project, bookText: text }, undefined, true),
  'projects.get': action('章节目录、角色 DNA 和进度概要；不返回全局配置或凭据', project),
  'chapters.get': action('读取单章原文、段落和场景卡', chapter),
  'scenes.get': action('读取场景、实际图片及绑定图片/上下文的 QC 状态', scene),
  'scenes.create': action('Agent 写入场景卡，不调用 LLM 或 NAI', { ...chapter, card: object(cardFields, ['trigger_sentence', 'visual_description']) }, undefined, true),
  'scenes.update': action('更新场景卡；需提供当前版本以避免覆盖并发编辑', { ...scene, expectedSceneHash: text, card: object(cardFields, []) }, undefined, true),
  'prompts.write': action('原样保存 Agent 创作的最终 Prompt，不自动拼接/裁剪', {
    ...scene, expectedSceneHash: text, basePrompt: text, negativePrompt: { type: 'string' },
    characterPrompts: strings, negativeCharacterPrompts: strings,
    width: { ...integer, maximum: 2048 }, height: { ...integer, maximum: 2048 }
  }, [...Object.keys(scene), 'expectedSceneHash', 'basePrompt', 'negativePrompt', 'characterPrompts', 'width', 'height'], true),
  'scenes.render': action('使用当前已保存 Prompt 生成一张候选图；复用网页 NAI 重绘队列', {
    ...scene, expectedSceneHash: text, confirmCosts: { type: 'boolean', const: true }
  }, undefined, true, true),
  'scenes.redraw': action('调用项目配置的 LLM 重写 Prompt 后生图；复用网页重绘队列', {
    ...scene, expectedSceneHash: text, confirmCosts: { type: 'boolean', const: true }
  }, undefined, true, true),
  'pipeline.start': action('从已有进度续跑全书或指定章节；可能调用 LLM/NAI', {
    ...project, chapterKey: text, confirmCosts: { type: 'boolean', const: true }
  }, ['projectName', 'confirmCosts'], true, true),
  'pipeline.status': action('项目运行状态与网页共享队列', project),
  'pipeline.stop': action('停止续跑并移除尚未执行的项目队列任务；当前远程请求仍需核查', project, undefined, true),
  'qc.tasks': action('获取当前真实图片的待预检任务；不调用模型、不代表人工批准', {
    ...project, limit: { ...integer, maximum: 20 }
  }, ['projectName']),
  'qc.submit': action('保存 Agent 看图后的 C1–C12 报告；不批准图片、不组装漫画', {
    ...scene, imageSha256: text, contextHash: text, summary: text,
    examinedImages: { type: 'array', minItems: 1, items: object({ path: text, sha256: text }) },
    criteria: object(criteria)
  }, undefined, true)
};

class AgentError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function requireValue(condition, status, code, message) {
  if (!condition) throw new AgentError(status, code, message);
}
function validate(schema, value, at = 'arguments') {
  const types = { object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
    string: v => typeof v === 'string', boolean: v => typeof v === 'boolean',
    integer: Number.isInteger, array: Array.isArray, number: Number.isFinite };
  requireValue(types[schema.type]?.(value), 400, 'INVALID_ARGUMENTS', `${at}: expected ${schema.type}`);
  if (schema.const !== undefined) requireValue(value === schema.const, 400, 'INVALID_ARGUMENTS', `${at}: invalid value`);
  if (schema.enum) requireValue(schema.enum.includes(value), 400, 'INVALID_ARGUMENTS', `${at}: invalid value`);
  if (schema.minLength) requireValue(value.trim().length >= schema.minLength, 400, 'INVALID_ARGUMENTS', `${at}: empty string`);
  if (schema.minimum !== undefined) requireValue(value >= schema.minimum, 400, 'INVALID_ARGUMENTS', `${at}: too small`);
  if (schema.maximum !== undefined) requireValue(value <= schema.maximum, 400, 'INVALID_ARGUMENTS', `${at}: too large`);
  if (schema.type === 'object') {
    for (const key of schema.required || []) requireValue(Object.hasOwn(value, key), 400, 'INVALID_ARGUMENTS', `${at}.${key}: required`);
    for (const key of Object.keys(value)) {
      requireValue(!Object.hasOwn(Object.prototype, key), 400, 'INVALID_ARGUMENTS', `${at}: reserved field`);
      const known = Object.hasOwn(schema.properties, key);
      requireValue(known || schema.additionalProperties && typeof schema.additionalProperties === 'object', 400, 'INVALID_ARGUMENTS', `${at}.${key}: unknown field`);
      validate(known ? schema.properties[key] : schema.additionalProperties, value[key], `${at}.${key}`);
    }
  }
  if (schema.type === 'array') {
    requireValue(value.length >= (schema.minItems || 0) && value.length <= (schema.maxItems ?? Infinity), 400, 'INVALID_ARGUMENTS', `${at}: invalid length`);
    value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`));
    if (schema.uniqueItems) requireValue(new Set(value.map(canonical)).size === value.length, 400, 'INVALID_ARGUMENTS', `${at}: repeated item`);
  }
}

export function createAgentRouter({ baseDir, getPipeline, enqueueRedraw, queueState, stopQueues, notify = () => {}, comicGenerator }) {
  const router = express.Router();
  const ledgerPath = path.join(baseDir, 'projects', '.agent', 'ledger.json');
  let ledger;
  let serial = Promise.resolve();
  const locked = fn => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  const save = () => writeJsonAtomic(ledgerPath, ledger);
  async function load() {
    if (ledger) return;
    ledger = await readJson(ledgerPath, { actions: {}, reports: {} });
    for (const item of Object.values(ledger.actions)) {
      if (['ACCEPTED', 'QUEUED', 'RUNNING'].includes(item.status)) {
        item.status = 'INTERRUPTED_REVIEW_REQUIRED';
        item.message = '服务已重启；核查项目进度和远程结果后使用新的 actionId，不能自动重投。';
      }
    }
    await save();
  }
  async function projectPath(name, mustExist = true) {
    requireValue(!/[\\/:*?"<>|\x00-\x1f]/.test(name) && !name.startsWith('.') && name === name.trim()
      && !/[. ]$/.test(name) && !Object.hasOwn(Object.prototype, name)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name), 400, 'INVALID_PROJECT', '无效的项目名称');
    const root = path.join(baseDir, 'projects');
    const candidate = path.join(root, name);
    if (mustExist) {
      let real;
      try { real = await fs.realpath(candidate); } catch { throw new AgentError(404, 'NOT_FOUND', '项目不存在'); }
      const realRoot = await fs.realpath(root);
      requireValue(path.relative(realRoot, real) === name, 400, 'INVALID_PROJECT', '项目路径超出项目目录');
    }
    return candidate;
  }
  async function resolve(args, withScene = false) {
    const dir = await projectPath(args.projectName);
    const pipeline = await getPipeline(args.projectName);
    if (!args.chapterKey) return { pipeline, dir };
    const chap = pipeline.chapters.find(c => pipeline.projectProgress.normalizeKey(
      pipeline.projectProgress.getEffectiveChapKey(c.volume, c.chapter)
    ) === pipeline.projectProgress.normalizeKey(args.chapterKey));
    requireValue(chap, 404, 'NOT_FOUND', '章节不存在；使用 projects.get 返回的 chapterKey');
    const chapterKey = pipeline.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const scenes = pipeline.projectProgress.getCompletedChapters()[chapterKey]?.scenes || [];
    const target = scenes.find(s => Number(s.scene_idx) === args.sceneIdx);
    if (withScene) requireValue(target, 404, 'NOT_FOUND', '场景不存在');
    return { pipeline, dir, chap, chapterKey, scenes, target };
  }
  const sceneHash = target => hash(canonical(target));
  function editable(ctx, args, comicInternal = false) {
    const queues = queueState(args.projectName);
    requireValue(!ctx.pipeline.isRunning && !queues.busy, 409, 'BUSY', '项目或队列正在运行，等待完成后编辑');
    requireValue(comicInternal || !ctx.pipeline.comicProductionJob, 409, 'BUSY', '漫画创作任务正在运行');
    if (ctx.target) requireValue(sceneHash(ctx.target) === args.expectedSceneHash, 409, 'STALE_SCENE', '场景版本已变化，请重新读取');
  }
  const decodedImages = new Map();
  async function imageInfo(dir, relative) {
    const root = await fs.realpath(dir);
    let real;
    try { real = await fs.realpath(path.resolve(dir, relative)); } catch { throw new AgentError(409, 'IMAGE_UNAVAILABLE', '图片不存在'); }
    const rel = path.relative(root, real);
    requireValue(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 400, 'INVALID_IMAGE', '图片路径超出项目目录');
    const bytes = await fs.readFile(real);
    const sha256 = hash(bytes);
    let metadata = decodedImages.get(sha256);
    try {
      if (!metadata) {
        metadata = await sharp(bytes).metadata(); await sharp(bytes).raw().toBuffer();
        if (decodedImages.size >= 256) decodedImages.delete(decodedImages.keys().next().value);
        decodedImages.set(sha256, { width: metadata.width, height: metadata.height, format: metadata.format });
      }
    }
    catch { throw new AgentError(409, 'IMAGE_UNAVAILABLE', '图片无法完整解码'); }
    return { path: real, sha256, width: metadata.width, height: metadata.height, format: metadata.format };
  }
  const reportKey = args => canonical([args.projectName, args.chapterKey, args.sceneIdx]);
  async function context(args, ctx) {
    const { pipeline, dir, chapterKey, scenes, chap } = ctx;
    const target = structuredClone(ctx.target);
    const index = scenes.indexOf(ctx.target);
    const previousScene = index > 0 ? structuredClone(scenes[index - 1]) : null;
    const source = { chapterKey, triggerSentence: target.trigger_sentence,
      excerpt: target.source_paragraph || target.source_selection || target.trigger_sentence };
    const characterDna = structuredClone(Object.fromEntries((target.character_names || []).map(name => [name,
      pipeline.projectProgress.getCharacterDNAForChapter(name, pipeline.chapters.indexOf(chap))])));
    const images = [];
    if (target.image_path) images.push(await imageInfo(dir, target.image_path));
    if (previousScene?.image_path) images.push(await imageInfo(dir, previousScene.image_path));
    const currentScenes = pipeline.projectProgress.getCompletedChapters()[chapterKey]?.scenes || [];
    const currentIndex = currentScenes.findIndex(s => Number(s.scene_idx) === args.sceneIdx);
    requireValue(currentIndex >= 0 && sceneHash(currentScenes[currentIndex]) === sceneHash(target)
      && canonical(currentIndex > 0 ? currentScenes[currentIndex - 1] : null) === canonical(previousScene),
    409, 'STALE_CONTEXT', '读取期间场景或前格已变化，请重新读取');
    const payload = { scene: target, source, characterDna, previousScene, images };
    const contextHash = hash(canonical(payload));
    const report = ledger.reports[reportKey({ ...args, chapterKey })];
    return { ...payload, sceneHash: sceneHash(target), contextHash,
      qc: !report ? { status: 'PENDING' } : report.contextHash !== contextHash || report.imageSha256 !== images[0]?.sha256
        ? { status: 'STALE', previousReport: report } : { status: report.verdict, report },
      humanApproved: false, assemblyReady: false };
  }
  async function finish(actionId, status, result) {
    await locked(async () => {
      const item = ledger.actions[actionId];
      item.status = item.stopRequested && item.action === 'pipeline.start' ? 'STOPPED_REVIEW_REQUIRED' : status;
      item.result = result;
      item.updatedAt = new Date().toISOString();
      await save();
      notify('agent_job', item);
    });
  }
  const comic = new ComicService({ projectPath, resolve, imageInfo, queueState, notify,
    dispatch: (name, args, actionId) => execute(name, args, actionId, true),
    actionState: actionId => ledger?.actions[actionId]?.status, locked, finish, validate, generator: comicGenerator,
    submit: (name, args, actionId, owner) => locked(() => submitAction(name, args, actionId, owner)) });
  async function execute(name, args, actionId, comicInternal = false, owner = null) {
    if (name.startsWith('comics.')) return comic.execute(name, args, actionId, owner);
    if (name === 'projects.list') {
      const entries = await fs.readdir(path.join(baseDir, 'projects'), { withFileTypes: true }).catch(e => {
        if (e.code === 'ENOENT') return []; throw e;
      });
      return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ projectName: e.name }));
    }
    if (name === 'projects.create') {
      const dir = await projectPath(args.projectName, false);
      try { await fs.mkdir(dir, { recursive: false }); }
      catch (e) { if (e.code === 'EEXIST') throw new AgentError(409, 'ALREADY_EXISTS', '项目已存在，不能覆盖原文'); throw e; }
      await fs.writeFile(path.join(dir, 'book.txt'), args.bookText, { encoding: 'utf8', flag: 'wx' });
      const pipeline = await getPipeline(args.projectName);
      return { projectName: args.projectName, chapterCount: pipeline.chapters.length };
    }
    const ctx = await resolve(args, name.startsWith('scenes.') && name !== 'scenes.create' || name === 'prompts.write' || name === 'qc.submit');
    const { pipeline, chapterKey, scenes, target } = ctx;
    if (!comicInternal && target?.comic_panel_id && ['scenes.update', 'prompts.write', 'scenes.render', 'scenes.redraw'].includes(name)) {
      throw new AgentError(409, 'COMIC_ROUTE_REQUIRED', '漫画画格请使用 comics.* 接口，保留候选与审核记录');
    }
    if (name === 'projects.get') return {
      projectName: args.projectName,
      chapters: pipeline.chapters.map(c => ({ chapterKey: pipeline.projectProgress.getEffectiveChapKey(c.volume, c.chapter),
        volume: c.volume, chapter: c.chapter, characterCount: c.content.length })),
      characters: pipeline.projectProgress.getGlobalCharacters(), progress: pipeline.projectProgress.data
    };
    if (name === 'chapters.get') return { chapterKey, content: ctx.chap.content,
      paragraphs: ctx.chap.content.split(/\r?\n/).map(t => t.trim()).filter(Boolean), scenes };
    if (name === 'scenes.get') return context(args, ctx);
    if (name === 'pipeline.status') return { projectName: args.projectName, isRunning: pipeline.isRunning,
      ...queueState(args.projectName), pause: pipeline.projectProgress.data.pipeline_pause,
      chapters: Object.entries(pipeline.projectProgress.getCompletedChapters()).map(([key, c]) => ({
        chapterKey: key, status: c.status, scenes: (c.scenes || []).map(s => ({ sceneIdx: s.scene_idx, status: s.status, imagePath: s.image_path }))
      })) };
    if (name === 'pipeline.stop') {
      comic.production.requestStop(args.projectName);
      const removed = stopQueues(args.projectName);
      pipeline.isRunning = false;
      for (const item of Object.values(ledger.actions)) {
        if (item.projectName === args.projectName && ['RUNNING', 'QUEUED'].includes(item.status)) item.stopRequested = true;
      }
      for (const id of removed.actionIds) if (ledger.actions[id]) {
        ledger.actions[id].status = 'CANCELLED';
        ledger.actions[id].updatedAt = new Date().toISOString();
      }
      return { stopRequested: true, ...removed, currentRequestMayFinish: true };
    }
    if (name === 'scenes.create' || name === 'scenes.update' || name === 'prompts.write') {
      editable(ctx, args, comicInternal);
      if (name === 'scenes.create') {
        const sceneIdx = Math.max(0, ...scenes.map(s => Number(s.scene_idx) || 0)) + 1;
        const card = normalizeSceneCard({ ...args.card, scene_idx: sceneIdx });
        scenes.push({ ...card, source: 'agent', status: 'PENDING' });
      } else if (name === 'scenes.update') {
        Object.assign(target, normalizeSceneCard({ ...target, ...args.card, scene_idx: target.scene_idx }));
        delete target.prepared_prompt;
        for (const field of ['final_prompt', 'base_prompt', 'character_prompts', 'final_negative', 'negative_character_prompts']) delete target[field];
        target.status = 'PENDING';
      } else {
        requireValue(args.width % 64 === 0 && args.height % 64 === 0 && args.width * args.height <= 1048576,
          400, 'INVALID_CANVAS', '画幅需 64 对齐，总像素不超过 1048576');
        requireValue(args.negativeCharacterPrompts === undefined || args.negativeCharacterPrompts.length === args.characterPrompts.length,
          400, 'INVALID_PROMPT', '人物正负段数量必须一致');
        Object.assign(target, { base_prompt: args.basePrompt, final_prompt: [args.basePrompt, ...args.characterPrompts].join(' | '),
          final_negative: args.negativePrompt, character_prompts: args.characterPrompts,
          negative_character_prompts: args.negativeCharacterPrompts || args.characterPrompts.map(() => ''),
          character_centers: [], width: args.width, height: args.height, status: 'PROMPT_READY' });
        target.prepared_prompt = { finalPositive: target.final_prompt, finalNegative: target.final_negative,
          basePrompt: target.base_prompt, characterPrompts: target.character_prompts,
          negativeCharacterPrompts: target.negative_character_prompts, characterCenters: [], width: args.width, height: args.height };
      }
      pipeline.projectProgress.setChapterStatus(chapterKey, 'pending', scenes);
      await pipeline.projectProgress.save();
      notify('progress', { projectName: args.projectName, fullProgress: pipeline.projectProgress.data });
      const saved = name === 'scenes.create' ? scenes.at(-1) : target;
      return { chapterKey, scene: saved, sceneHash: sceneHash(saved) };
    }
    if (name === 'scenes.render' || name === 'scenes.redraw') {
      requireValue(comicInternal || !pipeline.comicProductionJob, 409, 'BUSY', '漫画创作任务正在运行');
      requireValue(sceneHash(target) === args.expectedSceneHash, 409, 'STALE_SCENE', '场景版本已变化，请重新读取');
      const queues = queueState(args.projectName);
      requireValue(!queues.busy && !pipeline.isSceneQueued(chapterKey, args.sceneIdx), 409, 'BUSY', '队列已有任务，待完成后提交');
      if (name === 'scenes.render') requireValue(target.final_prompt, 409, 'PROMPT_REQUIRED', '先用 prompts.write 保存最终 Prompt');
      const queued = enqueueRedraw(args.projectName, pipeline, chapterKey, chapterKey, args.sceneIdx,
        name === 'scenes.render' ? 'nai_only' : 'refresh_prompt', {
          agentActionId: actionId,
          onFinished: async error => {
            const current = pipeline.projectProgress.getCompletedChapters()[chapterKey]?.scenes?.find(s => Number(s.scene_idx) === args.sceneIdx);
            let failed = error || current?.status !== 'SUCCESS' || !current?.image_path;
            try { await locked(() => comic.renderFinished({ ...args, actionId }, current, failed)); }
            catch { failed = true; }
            return finish(actionId, failed ? 'FAILED_REVIEW_REQUIRED' : 'DONE', failed
              ? { code: 'GENERATION_FAILED', message: '生成未完成；核查项目状态与日志，不要自动重投。' }
              : { chapterKey, sceneIdx: args.sceneIdx, imagePath: current.image_path });
          }
        });
      return { ...queued, jobId: actionId, status: 'QUEUED', generated: false };
    }
    if (name === 'pipeline.start') {
      const affected = chapterKey ? [pipeline.projectProgress.getCompletedChapters()[chapterKey]] : Object.values(pipeline.projectProgress.getCompletedChapters());
      requireValue(!affected.some(c => c?.scenes?.some(s => s.comic_panel_id)), 409, 'COMIC_ROUTE_REQUIRED', '目标包含漫画画格，请逐格使用 comics.panels.render');
      requireValue(!pipeline.isRunning && !queueState(args.projectName).busy && !pipeline.comicProductionJob, 409, 'BUSY', '项目正在运行或队列非空');
      // Start through the same PipelineManager, without the force-regenerate chapter route.
      void pipeline.processPipeline(chapterKey || null, { autoUpdateCharacterDna: !chapterKey }).then(result => {
        const failures = Object.values(pipeline.projectProgress.getCompletedChapters()).some(c => c.status === 'failed' || c.scenes?.some(s => s.status === 'FAILED'));
        return finish(actionId, result?.paused ? 'PAUSED' : failures ? 'FAILED_REVIEW_REQUIRED' : 'DONE',
          { paused: Boolean(result?.paused), inspectProjectStatus: true });
      }).catch(() => { pipeline.isRunning = false; return finish(actionId, 'FAILED_REVIEW_REQUIRED', { code: 'PIPELINE_FAILED', inspectProjectStatus: true }); });
      return { jobId: actionId, status: 'RUNNING', generated: false };
    }
    if (name === 'qc.tasks') {
      const tasks = [];
      for (const [key, c] of Object.entries(pipeline.projectProgress.getCompletedChapters())) {
        for (const s of c.scenes || []) {
          if (s.status !== 'SUCCESS' || !s.image_path) continue;
          const taskArgs = { projectName: args.projectName, chapterKey: key, sceneIdx: Number(s.scene_idx) };
          const task = await context(taskArgs, await resolve(taskArgs, true));
          if (['PENDING', 'STALE'].includes(task.qc.status)) tasks.push({ ...taskArgs, ...task });
          if (tasks.length >= (args.limit || 4)) return tasks;
        }
      }
      return tasks;
    }
    if (name === 'qc.submit') {
      requireValue(target.status === 'SUCCESS' && target.image_path, 409, 'IMAGE_REQUIRED', '需要当前已生成的图片');
      const task = await context(args, ctx);
      requireValue(task.contextHash === args.contextHash && task.images[0].sha256 === args.imageSha256,
        409, 'STALE_QC', '图片或上下文已变化，请重新看图');
      requireValue(args.examinedImages.length === task.images.length && task.images.every(img => args.examinedImages.some(e => e.path === img.path && e.sha256 === img.sha256)),
        400, 'MISSING_EVIDENCE', '需记录当前原图和任务中全部对照图的实际查看路径与校验值');
      for (const [axis, item] of Object.entries(args.criteria)) {
        if (item.result !== 'N_A') continue;
        const empty = !(target.character_names || []).length && !(target.characters || []).length;
        requireValue(axis === 'C3' || empty && ['C1', 'C2', 'C8'].includes(axis), 400, 'INVALID_QC', `${axis} 不允许 N_A`);
      }
      const values = Object.values(args.criteria).map(c => c.result);
      const verdict = values.includes('FAIL') ? 'FAIL' : values.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS';
      const report = { ...args, chapterKey, reportId: randomUUID(), verdict, reviewerType: 'agent', createdAt: new Date().toISOString(), humanApproved: false };
      const reportPath = path.join(ctx.dir, '.agent', 'qc', `${report.reportId}.json`);
      await writeJsonAtomic(reportPath, report);
      ledger.reports[reportKey({ ...args, chapterKey })] = report;
      return { reportId: report.reportId, reportPath, verdict, humanApproved: false, assemblyReady: false };
    }
    throw new AgentError(404, 'UNKNOWN_ACTION', '未知操作');
  }

  // Shared durable receipts for Agent calls, browser production calls, and batch render children.
  async function submitAction(name, args, actionId, owner = null) {
    const spec = Object.hasOwn(AGENT_ACTIONS, name) ? AGENT_ACTIONS[name] : null;
    requireValue(spec, 404, 'UNKNOWN_ACTION', '未知操作；读取 capabilities');
    validate(spec.inputSchema, args); await load();
    if (!spec.mutation) return { data: await execute(name, args) };
    requireValue(typeof actionId === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(actionId)
      && !Object.hasOwn(Object.prototype, actionId), 400, 'ACTION_ID_REQUIRED', '写操作必须提供 8–100 位非保留字 actionId');
    const fingerprint = hash(canonical([name, args]));
    if (Object.hasOwn(ledger.actions, actionId)) {
      const old = ledger.actions[actionId];
      requireValue(old.fingerprint === fingerprint, 409, 'ACTION_ID_CONFLICT', '同一 actionId 不可用于不同请求');
      return { data: old, replayed: true };
    }
    const item = { actionId, action: name, projectName: args.projectName, fingerprint,
      status: 'ACCEPTED', createdAt: new Date().toISOString(), ...(owner ? { parentActionId: owner } : {}) };
    ledger.actions[actionId] = item; await save();
    try {
      item.result = await execute(name, args, actionId, false, owner);
      item.status = spec.costs ? item.result.status : 'DONE';
      item.updatedAt = new Date().toISOString(); await save();
      return { data: item, replayed: false };
    } catch (error) {
      item.status = 'FAILED_REVIEW_REQUIRED';
      item.result = { code: error.code || 'OPERATION_FAILED', message: error instanceof AgentError || error.publicMessage ? error.message : '操作失败，核查项目状态与服务日志。' };
      await save(); throw error;
    }
  }

  router.use((req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) || req.headers.origin) {
      return res.status(403).json({ ok: false, apiVersion: VERSION, error: { code: 'LOCAL_AGENT_ONLY', message: 'Agent 接口仅供本机非浏览器客户端调用' } });
    }
    next();
  });
  router.get('/capabilities', (req, res) => res.json({ ok: true, apiVersion: VERSION,
    data: { actions: AGENT_ACTIONS, jobStates: ['ACCEPTED', 'QUEUED', 'RUNNING', 'DONE', 'PAUSED', 'CANCELLED', 'STOPPED_REVIEW_REQUIRED', 'FAILED_REVIEW_REQUIRED', 'INTERRUPTED_REVIEW_REQUIRED'],
      humanApprovalSupported: true, humanApprovalChannel: '/api/comic (browser session only)', comicAssemblySupported: true,
      externalComicSkillImportSupported: false, qcExecution: 'external-agent-visual-inspection' } }));
  router.post('/call', async (req, res) => {
    try {
      const result = await locked(async () => {
        validate(object({ action: text, arguments: { type: 'object', properties: {}, additionalProperties: false }, actionId: text }, ['action', 'arguments']),
          { ...req.body, arguments: {} });
        return submitAction(req.body.action, req.body.arguments, req.body.actionId);
      });
      res.json({ ok: true, apiVersion: VERSION, ...result });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, apiVersion: VERSION, error: {
        code: error.code || 'OPERATION_FAILED', message: error instanceof AgentError || error.publicMessage ? error.message : '操作失败，核查项目状态与服务日志。'
      } });
    }
  });
  router.get('/jobs/:actionId', async (req, res) => {
    try {
      const data = await locked(async () => { await load(); return Object.hasOwn(ledger.actions, req.params.actionId) ? ledger.actions[req.params.actionId] : null; });
      if (!data) return res.status(404).json({ ok: false, apiVersion: VERSION, error: { code: 'NOT_FOUND', message: '任务不存在' } });
      res.json({ ok: true, apiVersion: VERSION, data });
    } catch { res.status(500).json({ ok: false, apiVersion: VERSION, error: { code: 'READ_FAILED', message: '任务记录读取失败' } }); }
  });
  // Separate browser channel: there is intentionally no Agent action for human approval or layout signoff.
  const humanRouter = express.Router();
  const sessionToken = randomBytes(32).toString('hex');
  humanRouter.use((req, res, next) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    let allowedOrigin = !req.headers.origin;
    try {
      const origin = new URL(req.headers.origin);
      allowedOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        && [String(req.socket.localPort), '5173'].includes(origin.port) && origin.protocol === 'http:';
    } catch { /* same-origin browser GET has no Origin */ }
    const fetchSite = req.headers['sec-fetch-site'];
    const browserSite = ['same-origin', 'same-site'].includes(fetchSite)
      || fetchSite === 'cross-site' && Boolean(req.headers.origin) && allowedOrigin;
    if (!local || !allowedOrigin || !['cors', 'same-origin'].includes(req.headers['sec-fetch-mode'])
      || !browserSite
      || req.headers['sec-fetch-dest'] !== 'empty') {
      return res.status(403).json({ ok: false, error: { code: 'BROWSER_ONLY', message: '人工审稿入口仅供本机浏览器工作台' } });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  humanRouter.get('/session', (req, res) => res.json({ ok: true, data: { token: sessionToken } }));
  humanRouter.post('/call', async (req, res) => {
    if (req.headers['x-comic-session'] !== sessionToken) return res.status(403).json({ ok: false, error: { code: 'SESSION_REQUIRED', message: '请刷新人工工作台会话' } });
    try {
      const data = await locked(async () => {
        await load();
        const { action, arguments: args, actionId } = req.body || {};
        if (action === 'human.review') {
          requireValue(args && typeof args.projectName === 'string' && typeof args.episodeId === 'string', 400, 'INVALID_ARGUMENTS', '缺少项目/EP');
          return comic.human(args, { ...args, actionId });
        }
        requireValue(Object.hasOwn(COMIC_ACTIONS, action) && !action.startsWith('comics.qc.'), 400, 'INVALID_ACTION', '漫画工作台操作不支持');
        const result = await submitAction(action, args, actionId);
        if (!AGENT_ACTIONS[action].mutation) return result.data;
        requireValue(!['FAILED_REVIEW_REQUIRED', 'INTERRUPTED_REVIEW_REQUIRED', 'STOPPED_REVIEW_REQUIRED'].includes(result.data.status), 409, 'REVIEW_REQUIRED', '前次操作未完成，请核查原任务');
        return result.data.result;
      });
      res.json({ ok: true, data });
    } catch (error) { res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'COMIC_FAILED', message: error.publicMessage || error instanceof AgentError ? error.message : '漫画操作失败，请核查状态' } }); }
  });
  router.humanRouter = humanRouter;
  router.stopComicProduction = projectName => comic.production.requestStop(projectName);
  return router;
}
