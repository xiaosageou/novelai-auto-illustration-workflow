import { useEffect, useState } from 'react';
import { Plus, Sparkles, Play, Square, Pencil, X } from 'lucide-react';

const productionRunning = episode => ['ACCEPTED', 'QUEUED', 'RUNNING', 'STOPPING'].includes(episode?.production?.status);
const lines = value => value.split('\n').map(s => s.trim()).filter(Boolean);
const stateText = value => Object.entries(value || {}).map(([key, entry]) => `${key}=${entry}`).join('\n');
function parseState(value) {
  return Object.fromEntries(lines(value).map(line => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error('状态每行填写“名称=状态”，例如：门=打开');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

export function ComicAuthoring({ call, episode, episodes, busy, error, onRun, onAdd }) {
  const [sources, setSources] = useState({ chapters: [] });
  const [chapterKey, setChapterKey] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [count, setCount] = useState(12);
  const [selection, setSelection] = useState('');
  const [instructions, setInstructions] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('zh-CN');
  const [initialState, setInitialState] = useState('');
  const [formError, setFormError] = useState('');
  const projectName = episode?.projectName; // call is already scoped to the active project by the parent.
  useEffect(() => {
    let alive = true;
    void call('comics.sources.get', {}).then(data => { if (alive) setSources(data); }).catch(err => { if (alive) setSourceError(err.message); });
    return () => { alive = false; };
  }, [call, projectName]);
  const selected = chapterKey || episode?.panels[0]?.plan.chapterKey || sources.chapters[0]?.chapterKey || '';
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void call('comics.sources.get', { chapterKey: selected }).then(data => { if (alive) { setSourceContent(data.content || ''); setSourceError(''); } })
      .catch(err => { if (alive) setSourceError(err.message); });
    return () => { alive = false; };
  }, [call, selected]);
  const nextId = `EP${String(Math.max(0, ...episodes.map(ep => Number(/^EP(\d+)$/.exec(ep.episodeId)?.[1]) || 0)) + 1).padStart(3, '0')}`;
  const chapter = sources.chapters.find(ch => ch.chapterKey === selected);
  async function create() {
    try {
      const ok = await onRun('comics.episodes.create', { episodeId: newId || nextId,
        title: title.trim() || chapter?.title || '新的一话', language, initialState: parseState(initialState) }, true);
      if (ok) { setCreateOpen(false); setTitle(''); setNewId(''); }
    } catch (err) { setFormError(err.message); }
  }
  return <section className="comic-authoring" aria-label="漫画创作">
    <div className="comic-authoring-title"><div><strong>创作与生成</strong><span>先确认分镜，再生成画面</span></div>
      <button disabled={busy} onClick={() => setCreateOpen(true)}><Plus size={15}/>新建漫画话</button></div>
    <p className="comic-editor-hint">生成按钮会调用已配置的 LLM / NAI，使用相应额度；编辑和采用分镜不调用模型。</p>
    {sourceError && <p role="alert" className="comic-form-error">{sourceError}</p>}
    <div className="comic-authoring-row">
      <label>小说章节<select value={selected} onChange={e => { setChapterKey(e.target.value); setSelection(''); }}>{sources.chapters.map(ch => <option key={ch.chapterKey} value={ch.chapterKey}>{ch.volume} · {ch.title}</option>)}</select></label>
      <label>分镜格数<input type="number" min="1" max="80" value={count} onChange={e => setCount(Number(e.target.value))}/></label>
      <button disabled={busy || !episode || episode.panels.length > 0 || !selected || !Number.isInteger(count) || count < 1 || count > 80}
        onClick={() => onRun('comics.storyboard.generate', { chapterKey: selected, panelCount: count, sourceSelection: selection, instructions, confirmCosts: true })}><Sparkles size={15}/>生成分镜草稿</button>
      <button disabled={busy || !episode || !selected} onClick={() => onAdd(selected, selection || sourceContent.split(/\r?\n/).find(s => s.trim()) || '')}><Plus size={15}/>手动加格</button>
    </div>
    <details className="comic-source-options"><summary>原文范围与创作要求</summary><div className="comic-form-grid">
      <label>选用原文<textarea value={selection} onChange={e => setSelection(e.target.value)} placeholder="留空使用全章；也可从原文复制连续的一段" rows={3}/></label>
      <label>分镜要求<textarea value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="画风、叙事节奏、重点镜头，以及不能提前出现的情节" rows={3}/></label>
    </div><details><summary>查看章节原文</summary><pre className="comic-source-text">{sourceContent || '原文加载中…'}</pre></details></details>
    {episode?.panels.length > 0 && <div className="comic-authoring-row comic-generate-row">
      <button disabled={busy} onClick={() => onRun('comics.prompts.generate', { confirmCosts: true })}><Sparkles size={15}/>补齐提示词</button>
      <button disabled={busy} onClick={() => onRun('comics.images.generate', { mode: 'missing', confirmCosts: true })}><Play size={15}/>生成缺失画格</button>
      <span>已有当前候选会跳过；生图后等待 Agent 看图预检。</span>
    </div>}
    {episode?.production && <div className={`comic-production ${episode.production.status === 'FAILED_REVIEW_REQUIRED' ? 'failed' : ''}`} role="status">
      <div><strong>{episode.production.status === 'RUNNING' ? '正在创作' : episode.production.status === 'STOPPING' ? '正在停止' : episode.production.status === 'DONE' ? '创作任务完成' : '创作任务需核查'}</strong>
        <span>{episode.production.message} · {episode.production.completed}/{episode.production.total}</span></div>
      <progress value={episode.production.completed} max={episode.production.total || 1}/>
      {productionRunning(episode) || episode.production.status === 'INTERRUPTED_REVIEW_REQUIRED' ? <button disabled={episode.production.status === 'STOPPING'} onClick={() => onRun('comics.production.stop', { expectedProductionActionId: episode.production.actionId })}><Square size={12}/>停止任务</button> : null}
    </div>}
    {createOpen && <div className="comic-editor-backdrop"><section className="comic-editor" role="dialog" aria-modal="true" aria-label="新建漫画话">
      <header><h3>新建漫画话</h3><button onClick={() => setCreateOpen(false)} aria-label="关闭新建漫画话"><X size={18}/></button></header>
      <div className="comic-form-grid"><label>话编号<input value={newId} placeholder={nextId} onChange={e => setNewId(e.target.value)}/></label>
        <label>标题<input value={title} placeholder={chapter?.title || '新的一话'} onChange={e => setTitle(e.target.value)}/></label>
        <label>对白语言<select value={language} onChange={e => setLanguage(e.target.value)}><option value="zh-CN">简体中文</option><option value="zh-TW">繁体中文</option><option value="en">English</option></select></label>
        <label>起始状态<textarea value={initialState} onChange={e => setInitialState(e.target.value)} placeholder="可留空；每行名称=状态，如：门=关闭" rows={3}/></label></div>
      {(formError || error) && <p role="alert" className="comic-form-error">{formError || error}</p>}<footer><button disabled={busy} onClick={create}>创建漫画话</button></footer>
    </section></div>}
    {episode?.panels.length > 0 && <div className="comic-editor-hint">选中画格后可<Pencil size={12}/>编辑分镜与对白，或调整生图输入。</div>}
    {/* Editor callbacks belong to the selected panel controls in the desk. */}
  </section>;
}

function normalizePlan(plan) {
  const { stateInput, ...clean } = plan;
  return { ...clean, stateDelta: stateInput === undefined ? plan.stateDelta : parseState(stateInput),
    ...Object.fromEntries(['characterNames', 'mustShow', 'mustNotShow', 'sfx'].map(key => [key, plan[key].map(s => s.trim()).filter(Boolean)])) };
}

function PlanFields({ plan, onChange }) {
  const [changes, setChanges] = useState(stateText(plan.stateDelta));
  const patch = (field, value) => onChange({ ...plan, [field]: value });
  return <div className="comic-form-grid comic-plan-fields">
    <label>剧情节点<input value={plan.storyBeat} onChange={e => patch('storyBeat', e.target.value)}/></label>
    <label>原文位置<input value={plan.sourceLocator} onChange={e => patch('sourceLocator', e.target.value)}/></label>
    <label className="wide">对应原文<textarea value={plan.sourceExcerpt} onChange={e => patch('sourceExcerpt', e.target.value)} rows={2}/></label>
    <label className="wide">画面描述<textarea value={plan.storyboardDescription} onChange={e => patch('storyboardDescription', e.target.value)} rows={3}/></label>
    <label>景别<input value={plan.shotSize} onChange={e => patch('shotSize', e.target.value)}/></label>
    <label>机位<input value={plan.cameraAngle} onChange={e => patch('cameraAngle', e.target.value)}/></label>
    <label>连续场景编号<input value={plan.sceneId} onChange={e => patch('sceneId', e.target.value)}/></label>
    <label>镜头编号<input value={plan.shotId} onChange={e => patch('shotId', e.target.value)}/></label>
    <label>画幅宽度<input type="number" step="64" min="64" value={plan.width} onChange={e => patch('width', Number(e.target.value))}/></label>
    <label>画幅高度<input type="number" step="64" min="64" value={plan.height} onChange={e => patch('height', Number(e.target.value))}/></label>
    <label className="wide">画幅理由<input value={plan.canvasReason} onChange={e => patch('canvasReason', e.target.value)}/></label>
    <label>可见角色<textarea value={plan.characterNames.join('\n')} onChange={e => patch('characterNames', e.target.value.split('\n'))} placeholder="每行一名角色，最多四名" rows={3}/></label>
    <label>本格状态变化<textarea value={changes} onChange={e => { setChanges(e.target.value); patch('stateInput', e.target.value); }} placeholder="每行名称=状态" rows={3}/><small>状态按阅读顺序传入下一格</small></label>
    <label>必须呈现<textarea value={plan.mustShow.join('\n')} onChange={e => patch('mustShow', e.target.value.split('\n'))} rows={3}/></label>
    <label>不能呈现<textarea value={plan.mustNotShow.join('\n')} onChange={e => patch('mustNotShow', e.target.value.split('\n'))} rows={3}/></label>
    <label>画风模式<select value={plan.styleMode} onChange={e => patch('styleMode', e.target.value)}><option value="main">主画风</option><option value="chibi">Q 版</option></select></label>
    <label>切换理由<input value={plan.styleReason} onChange={e => patch('styleReason', e.target.value)}/></label>
    <div className="wide comic-dialogue-editor"><strong>对白与旁白</strong>{plan.dialogue.map((entry, i) => <div key={entry.dialogueId} className="comic-dialogue-row">
      <select aria-label={`对白${i + 1}类型`} value={entry.type} onChange={e => patch('dialogue', plan.dialogue.map((d, n) => n === i ? { ...d, type: e.target.value } : d))}><option value="speech">对白</option><option value="shout">喊话</option><option value="narration">旁白</option></select>
      <input aria-label={`对白${i + 1}说话人`} value={entry.speakerId || ''} placeholder="说话角色" onChange={e => patch('dialogue', plan.dialogue.map((d, n) => n === i ? { ...d, speakerId: e.target.value } : d))}/>
      <textarea aria-label={`对白${i + 1}文字`} value={entry.text} onChange={e => patch('dialogue', plan.dialogue.map((d, n) => n === i ? { ...d, text: e.target.value } : d))} rows={2}/>
      <button aria-label={`删除对白${i + 1}`} onClick={() => patch('dialogue', plan.dialogue.filter((_, n) => n !== i))}><X size={14}/></button>
    </div>)}<button onClick={() => patch('dialogue', [...plan.dialogue, { dialogueId: `D_${crypto.randomUUID()}`, type: 'speech', speakerId: plan.characterNames[0] || '', text: '' }])}>添加对白 / 旁白</button></div>
    <label>拟声<textarea value={plan.sfx.join('\n')} onChange={e => patch('sfx', e.target.value.split('\n'))} rows={2}/></label>
    <div className="comic-gap-fields"><label>格前留白<input type="number" min="0" max="2000" value={plan.gapBefore} onChange={e => patch('gapBefore', Number(e.target.value))}/></label><label>格后留白<input type="number" min="0" max="2000" value={plan.gapAfter} onChange={e => patch('gapAfter', Number(e.target.value))}/></label></div>
  </div>;
}

export function ComicPlanEditor({ initialPlan, title, onSave, onClose, busy, error }) {
  const [plan, setPlan] = useState(initialPlan);
  const [localError, setLocalError] = useState('');
  function save() { try { setLocalError(''); void onSave(normalizePlan(plan)); } catch (err) { setLocalError(err.message); } }
  return <div className="comic-editor-backdrop"><section className="comic-editor" role="dialog" aria-modal="true" aria-label={title}>
    <header><h3>{title}</h3><button onClick={onClose} aria-label="关闭分镜编辑"><X size={18}/></button></header>
    <PlanFields plan={plan} onChange={setPlan}/><footer>{(localError || error) && <p role="alert" className="comic-form-error">{localError || error}</p>}<button disabled={busy} onClick={save}>保存分镜</button></footer>
  </section></div>;
}

export function ComicDraftEditor({ draft, onApply, busy, error }) {
  const [plans, setPlans] = useState(draft.plans);
  const [localError, setLocalError] = useState('');
  function apply() { try { setLocalError(''); void onApply(plans.map(normalizePlan)); } catch (err) { setLocalError(err.message); } }
  return <section className="comic-draft" aria-label="分镜草稿">
    <header><div><strong>分镜草稿 · {plans.length} 格</strong><p>检查原文、镜头与对白，采用后进入画格生产。</p></div><button disabled={busy} onClick={apply}>采用这些分镜</button></header>
    <div className="comic-draft-list">{plans.map((plan, i) => <details key={i}><summary>{String(i + 1).padStart(2, '0')} · {plan.storyBeat} · {plan.shotSize}</summary>
      <PlanFields plan={plan} onChange={next => setPlans(old => old.map((p, n) => n === i ? next : p))}/></details>)}</div>
    {(localError || error) && <p role="alert" className="comic-form-error">{localError || error}</p>}
  </section>;
}

export function ComicPromptEditor({ panel, onSave, onClose, busy, error }) {
  const [input, setInput] = useState({ basePrompt: panel.generationInput?.basePrompt || '', negativePrompt: panel.generationInput?.negativePrompt || 'text, speech bubble, watermark, signature, panel layout',
    characterPrompts: panel.plan.characterNames.map((_, i) => panel.generationInput?.characterPrompts[i] || ''),
    negativeCharacterPrompts: panel.plan.characterNames.map((_, i) => panel.generationInput?.negativeCharacterPrompts[i] || '') });
  return <div className="comic-editor-backdrop"><section className="comic-editor" role="dialog" aria-modal="true" aria-label="编辑生图输入">
    <header><h3>{panel.panelId} · 生图输入</h3><button onClick={onClose} aria-label="关闭生图输入"><X size={18}/></button></header>
    <label>全局正向提示词<textarea value={input.basePrompt} rows={5} onChange={e => setInput(old => ({ ...old, basePrompt: e.target.value }))}/></label>
    <label>全局负向提示词<textarea value={input.negativePrompt} rows={3} onChange={e => setInput(old => ({ ...old, negativePrompt: e.target.value }))}/></label>
    {panel.plan.characterNames.map((name, i) => <div className="comic-form-grid" key={name}><label>{name} · 正向<textarea value={input.characterPrompts[i]} rows={3} onChange={e => setInput(old => ({ ...old, characterPrompts: old.characterPrompts.map((p, n) => n === i ? e.target.value : p) }))}/></label>
      <label>{name} · 负向<textarea value={input.negativeCharacterPrompts[i]} rows={3} onChange={e => setInput(old => ({ ...old, negativeCharacterPrompts: old.negativeCharacterPrompts.map((p, n) => n === i ? e.target.value : p) }))}/></label></div>)}
    <footer>{error && <p role="alert" className="comic-form-error">{error}</p>}<button disabled={busy} onClick={() => onSave(input)}>保存生图输入</button></footer>
  </section></div>;
}
