const text = { type: 'string', minLength: 1 };
const string = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const list = items => ({ type: 'array', items });
const state = { type: 'object', properties: {}, additionalProperties: string };
const project = { projectName: text };
const episode = { ...project, episodeId: text };
const panel = { ...episode, panelId: text };
const version = { expectedEpisodeHash: text };
export const COMIC_PLAN_SCHEMA = obj({
  chapterKey: text, sourceExcerpt: text, sourceLocator: text,
  sceneId: text, shotId: text, storyBeat: text, storyboardDescription: text,
  shotSize: text, cameraAngle: text, canvasReason: text,
  width: { type: 'integer', minimum: 64, maximum: 2048 }, height: { type: 'integer', minimum: 64, maximum: 2048 },
  characterNames: list(text), mustShow: list(text), mustNotShow: list(text),
  styleMode: { type: 'string', enum: ['main', 'chibi'] }, styleReason: string,
  stateDelta: state, gapBefore: { ...integer, maximum: 2000 }, gapAfter: { ...integer, maximum: 2000 },
  dialogue: list(obj({ dialogueId: text, speakerId: string, type: { type: 'string', enum: ['speech', 'shout', 'narration'] }, text }, ['dialogueId', 'type', 'text'])),
  sfx: list(text)
}, ['chapterKey', 'sourceExcerpt', 'sourceLocator', 'sceneId', 'shotId', 'storyBeat', 'storyboardDescription', 'shotSize', 'cameraAngle', 'canvasReason', 'width', 'height']);
const layout = obj({ width: { type: 'integer', minimum: 640, maximum: 1600 },
  fontSize: { type: 'integer', minimum: 24, maximum: 80 }, sliceHeight: { type: 'integer', minimum: 512, maximum: 8192 } }, []);
const act = (description, properties, required, mutation = false, costs = false) => ({ description, inputSchema: obj(properties, required), mutation, costs });
const criteria = obj(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`C${i + 1}`, obj({
  result: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN', 'N_A'] }, evidence: text
})])));
export const COMIC_ACTIONS = {
  'comics.sources.get': act('漫画创作的章节目录、原文与角色资料', { ...project, chapterKey: text }, ['projectName']),
  'comics.episodes.list': act('列出漫画 EP', project),
  'comics.episodes.create': act('创建漫画 EP；语言默认简体中文', { ...episode, title: text,
    language: { type: 'string', enum: ['zh-CN', 'zh-TW', 'en'] }, initialState: state }, ['projectName', 'episodeId', 'title'], true),
  'comics.episodes.get': act('EP 分镜、候选、QC、人工批准和组装状态', episode),
  'comics.episodes.update': act('更新 EP 标题、初始状态、布局或阅读顺序', { ...episode, ...version, title: text,
    initialState: state, panelOrder: { ...list(text), uniqueItems: true }, layout }, [...Object.keys(episode), 'expectedEpisodeHash'], true),
  'comics.panels.add': act('创建稳定 panelId 与对应生图场景；一格一个主要时点', { ...panel, ...version, plan: COMIC_PLAN_SCHEMA }, undefined, true),
  'comics.panels.update': act('替换本格导演计划；影响画面时需重新生成和审核', { ...panel, ...version, plan: COMIC_PLAN_SCHEMA }, undefined, true),
  'comics.storyboard.generate': act('用项目 LLM 分批生成分镜草稿，等待采用；不生图', {
    ...episode, ...version, chapterKey: text, panelCount: { type: 'integer', minimum: 1, maximum: 80 },
    sourceSelection: string, instructions: string, confirmCosts: { type: 'boolean', const: true }
  }, [...Object.keys(episode), 'expectedEpisodeHash', 'chapterKey', 'panelCount', 'confirmCosts'], true, true),
  'comics.storyboard.apply': act('采用编辑后的完整分镜草稿；仅用于尚无画格的 EP', {
    ...episode, ...version, plans: { ...list(COMIC_PLAN_SCHEMA), minItems: 1, maxItems: 80 }
  }, undefined, true),
  'comics.prompts.generate': act('用项目 LLM 为指定画格生成提示词，不生图', {
    ...episode, ...version, panelIds: { ...list(text), minItems: 1, maxItems: 80, uniqueItems: true },
    rewrite: { type: 'boolean' }, confirmCosts: { type: 'boolean', const: true }
  }, [...Object.keys(episode), 'expectedEpisodeHash', 'confirmCosts'], true, true),
  'comics.images.generate': act('按顺序准备提示词并生图；missing 跳过已有当前候选，reroll 明确重抽', {
    ...episode, ...version, panelIds: { ...list(text), minItems: 1, maxItems: 80, uniqueItems: true },
    mode: { type: 'string', enum: ['missing', 'reroll'] }, rebuildPrompts: { type: 'boolean' },
    confirmCosts: { type: 'boolean', const: true }
  }, [...Object.keys(episode), 'expectedEpisodeHash', 'confirmCosts'], true, true),
  'comics.production.stop': act('停止本话创作任务；当前远程请求可能完成，中断任务不自动重投', {
    ...episode, ...version, expectedProductionActionId: text
  }, [...Object.keys(episode), 'expectedEpisodeHash'], true),
  'comics.prompts.write': act('保存画格的完整 Prompt；画幅使用分镜设定', { ...panel, ...version, basePrompt: text,
    negativePrompt: string, characterPrompts: list(text), negativeCharacterPrompts: list(string) },
  [...Object.keys(panel), 'expectedEpisodeHash', 'basePrompt', 'negativePrompt', 'characterPrompts'], true),
  'comics.panels.render': act('生成一张漫画候选，最多四次；沿用项目 NAI 队列', {
    ...panel, ...version, confirmCosts: { type: 'boolean', const: true } }, undefined, true, true),
  'comics.candidates.capture': act('收录对应场景当前图片为不可覆盖候选，不收费', { ...panel, ...version }, undefined, true),
  'comics.renders.resolve': act('核查中断生成后记录处理结果；不自动生图', { ...panel, ...version,
    resolution: { type: 'string', enum: ['capture-current', 'no-image'] }, note: text }, undefined, true),
  'comics.qc.tasks': act('逐张取得当前版本待视觉预检的漫画候选', { ...episode,
    limit: { type: 'integer', minimum: 1, maximum: 20 } }, Object.keys(episode)),
  'comics.qc.submit': act('提交候选的 C1–C12 视觉证据，不能人工批准', {
    ...panel, candidateId: text, imageSha256: text, contextHash: text, summary: text,
    examinedImages: { ...list(obj({ path: text, sha256: text })), minItems: 1 }, criteria
  }, undefined, true),
  'comics.assemble': act('全格人工批准后组装排字预览，等待排版终审', { ...episode, ...version }, undefined, true),
  'comics.export': act('排版终审通过后导出切片和带审核证据的交付 ZIP', { ...episode, ...version }, undefined, true)
};
