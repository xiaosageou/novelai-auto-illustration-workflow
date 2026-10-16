import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, RefreshCw, Layers, MessageSquare, ExternalLink } from 'lucide-react';
import './ComicWorkbench.css';
import { ComicAuthoring, ComicDraftEditor, ComicPlanEditor, ComicPromptEditor } from './ComicAuthoring.jsx';

const productionRunning = episode => ['ACCEPTED', 'QUEUED', 'RUNNING', 'STOPPING'].includes(episode?.production?.status);

const labels = { PENDING: '待预检', STALE: '预检过期', PASS: '预检通过', FAIL: '预检失败', UNKNOWN: '需核查',
  PLAN_CHANGED: '分镜已改变', UNAVAILABLE: '图片待核查', BLOCKED: '等待逐格批准', READY_TO_ASSEMBLE: '可以组装',
  LAYOUT_REVIEW_REQUIRED: '待排版终审', SIGNED_OFF: '排版已通过' };
const axes = ['人物身份', '当前服装', '道具', '空间连续性', '动作关系', '镜头与画幅', '剧情时点', '身体结构', '多余主体', '画风', '文件完整性', '图面洁净'];

export default function ComicWorkbench({ apiBase, projectName }) {
  const [episodes, setEpisodes] = useState([]);
  const [episodeId, setEpisodeId] = useState('');
  const [episode, setEpisode] = useState(null);
  const [panelId, setPanelId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);
  const [editor, setEditor] = useState(null);
  const [promptEditor, setPromptEditor] = useState(null);
  const session = useRef('');
  const generation = useRef(0);

  const call = useCallback(async (action, args, actionId) => {
    if (!session.current) {
      const response = await fetch(`${apiBase}/api/comic/session`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error?.message || '人工工作台连接失败');
      session.current = result.data.token;
    }
    const response = await fetch(`${apiBase}/api/comic/call`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Comic-Session': session.current },
      body: JSON.stringify({ action, arguments: args, ...(actionId ? { actionId } : {}) }) });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      if (result.error?.code === 'SESSION_REQUIRED') session.current = '';
      throw new Error(result.error?.message || '操作未完成，请刷新核查');
    }
    return result.data;
  }, [apiBase]);
  const scopedCall = useCallback((action, args) => call(action, { projectName, ...args }), [call, projectName]);
  const refresh = useCallback(async (override) => {
    if (!projectName) return;
    const epoch = generation.current;
    try {
      const list = await call('comics.episodes.list', { projectName });
      if (epoch !== generation.current) return;
      setEpisodes(list);
      const selected = typeof override === 'string' ? override : episodeId || list[0]?.episodeId;
      if (selected) {
        const data = await call('comics.episodes.get', { projectName, episodeId: selected });
        if (epoch !== generation.current) return;
        setEpisodeId(selected); setEpisode(data);
        setPanelId(current => data.panels.some(p => p.panelId === current) ? current : data.panels[0]?.panelId || '');
      }
      setError('');
    } catch (err) { if (epoch === generation.current) setError(err.message); }
  }, [projectName, episodeId, call]);
  useEffect(() => {
    const epoch = generation.current;
    void Promise.resolve().then(refresh);
    return () => { generation.current = epoch + 1; };
  }, [refresh]);
  const producing = productionRunning(episode);
  useEffect(() => {
    const interval = setInterval(() => { if (!busy && document.visibilityState === 'visible') void refresh(); }, producing ? 2000 : 15000);
    return () => clearInterval(interval);
  }, [refresh, busy, producing]);
  const working = busy || producing;
  const panel = episode?.panels.find(p => p.panelId === panelId);
  const candidate = panel?.candidates.find(c => c.candidateId === candidateId) || panel?.candidates.at(-1);
  const speakers = [...new Set((panel?.plan.dialogue || []).filter(d => d.type !== 'narration').map(d => d.speakerId))];
  const draftKey = `${episodeId}/${panelId}/${candidate?.candidateId || ''}`;
  const currentDraft = draft.key === draftKey ? draft : {};
  const comment = currentDraft.comment || '';
  const anchors = currentDraft.anchors || (candidate?.humanApproved ? panel.approval?.speakerAnchors : null) || {};
  const speaker = currentDraft.speaker || '';
  const point = currentDraft.point || null;
  function updateDraft(field, value) {
    setDraft(old => {
      const current = old.key === draftKey ? old : {};
      return { ...current, key: draftKey, [field]: typeof value === 'function' ? value(current[field] || {}) : value };
    });
  }
  const setComment = value => updateDraft('comment', value);
  const setAnchors = value => updateDraft('anchors', value);
  const setSpeaker = value => updateDraft('speaker', value);
  const setPoint = value => updateDraft('point', value);
  const currentImage = candidate ? `${apiBase}${candidate.imageUrl}` : '';
  const approvedCount = episode?.panels.filter(p => p.candidates.some(c => c.humanApproved)).length || 0;
  const waitingCount = episode?.panels.filter(p => p.candidates.some(c => c.qcStatus === 'PASS') && !p.candidates.some(c => c.humanApproved)).length || 0;
  const panels = (episode?.panels || []).filter(p => filter === 'all'
    || filter === 'approved' && p.candidates.some(c => c.humanApproved)
    || filter === 'waiting' && p.candidates.some(c => c.qcStatus === 'PASS') && !p.candidates.some(c => c.humanApproved)
    || filter === 'repair' && p.candidates.some(c => ['FAIL', 'UNKNOWN', 'STALE', 'PLAN_CHANGED', 'UNAVAILABLE'].includes(c.qcStatus)));

  async function run(action, extra = {}, absolute = false) {
    if ((!episode && !absolute) || busy) return false;
    setBusy(true); setError(''); setNotice('');
    const actionId = `human-${crypto.randomUUID()}`;
    try {
      const args = { projectName, ...(!absolute ? { episodeId, expectedEpisodeHash: episode.episodeHash } : {}), ...extra };
      const data = await call(action, args, actionId);
      if (action === 'comics.export') {
        const link = document.createElement('a'); link.href = `${apiBase}${data.url}`; link.download = `${episodeId}.zip`; link.click();
      }
      setNotice(data.jobId ? '任务已启动，进度会自动更新。LLM 与 NAI 使用当前项目配置和额度。' : action === 'comics.export' ? '交付包已生成，可在组装区再次下载。' : '已保存。');
      await refresh(action === 'comics.episodes.create' ? extra.episodeId : episodeId);
      return true;
    } catch (err) { setError(`${err.message}（操作 ${actionId}）`); }
    finally { setBusy(false); }
  }
  function addPanel(chapterKey, sourceExcerpt) {
    const number = episode.panels.length + 1;
    const last = episode.panels.at(-1)?.plan;
    setEditor({ mode: 'add', panelId: `P${String(number).padStart(3, '0')}`, plan: {
      chapterKey, sourceExcerpt, sourceLocator: '章节原文', sceneId: last?.sceneId || 'SC001', shotId: `SHOT${number}`,
      storyBeat: '', storyboardDescription: '', shotSize: '中景', cameraAngle: '平视', width: 832, height: 1216,
      canvasReason: '竖幅呈现角色与环境', characterNames: [], stateDelta: {}, mustShow: [], mustNotShow: [],
      dialogue: [], sfx: [], styleMode: 'main', styleReason: '', gapBefore: 0, gapAfter: 40
    }});
  }
  async function review(action) {
    if (!candidate) return;
    await run('human.review', { action, panelId, candidateId: candidate.candidateId,
      imageSha256: candidate.imageSha256, contextHash: candidate.contextHash,
      speakerAnchors: anchors, comment, points: point ? [{ ...point, comment }] : [] });
  }
  function imageClick(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const location = { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
    if (speaker) setAnchors(old => ({ ...old, [speaker]: location })); else setPoint(location);
  }
  return <section className="comic-workspace" aria-label="漫画工作台">
    <div className="comic-toolbar">
      <div><span className="comic-eyebrow">COMIC / PRODUCTION DESK</span><h2>小说分镜、生图与条漫组装</h2></div>
      <div className="comic-tools">
        <label>话数<select value={episodeId} onChange={e => { setEpisodeId(e.target.value); setEpisode(null); }}>
          {!episodes.length && <option value="">尚无 EP</option>}
          {episodes.map(ep => <option key={ep.episodeId} value={ep.episodeId}>{ep.episodeId} · {ep.title}</option>)}
        </select></label>
        <button onClick={refresh} disabled={busy} aria-label="刷新漫画状态"><RefreshCw size={16} />刷新</button>
      </div>
    </div>
    {error && <div className="comic-alert" role="alert">{error}</div>}
    {notice && <div className="comic-notice" role="status">{notice}</div>}
    <ComicAuthoring call={scopedCall} episode={episode} episodes={episodes} busy={working} error={error} onRun={run} onAdd={addPanel}/>
    {episode?.storyboardDraft && !episode.panels.length && <ComicDraftEditor key={episode.storyboardDraft.actionId} draft={episode.storyboardDraft} busy={working} error={error} onApply={plans => run('comics.storyboard.apply', { plans })}/>}
    {!episode ? <div className="comic-empty"><Layers size={40} /><h3>从小说开始，按话推进</h3><p>新建漫画话，选择章节生成分镜草稿。确认分镜后可直接在这里生成提示词与候选图，再由 Agent 看图预检。</p></div> : <>
      <div className="comic-summary"><strong>{episode.title}</strong><span>{episode.panels.length} 格</span><span>{waitingCount} 格待人工</span><span>{approvedCount} 格人工通过</span><span>{labels[episode.assemblyStatus]}</span></div>
      <div className="comic-desk">
        <aside className="comic-rail">
          <label className="comic-filter">审稿队列<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部画格</option><option value="waiting">待人工</option><option value="repair">预检与返修</option><option value="approved">人工通过</option></select></label>
          <div className="comic-panel-list">{panels.map(p => <button key={p.panelId} className={`comic-panel-button ${p.panelId === panelId ? 'selected' : ''}`} onClick={() => setPanelId(p.panelId)}>
            <span className="comic-panel-order">{String(episode.panelOrder.indexOf(p.panelId) + 1).padStart(2, '0')}</span><span><strong>{p.panelId}</strong><small>{p.plan.storyBeat}</small><em>{p.candidates.some(c => c.humanApproved) ? '人工通过' : p.candidates.some(c => c.qcStatus === 'PASS') ? '待人工' : '生成 / 预检中'}</em></span>
          </button>)}{!panels.length && <p className="comic-muted">此队列没有画格。</p>}</div>
        </aside>
        <main className="comic-art">
          {panel ? <>
            <div className="comic-art-heading"><div><b>{panel.panelId}</b><span>{panel.plan.shotSize} · {panel.plan.cameraAngle}</span></div>
              <div><button aria-label="上一格" disabled={episode.panelOrder.indexOf(panelId) <= 0} onClick={() => setPanelId(episode.panelOrder[episode.panelOrder.indexOf(panelId) - 1])}><ChevronLeft size={18}/></button><button aria-label="下一格" disabled={episode.panelOrder.indexOf(panelId) >= episode.panelOrder.length - 1} onClick={() => setPanelId(episode.panelOrder[episode.panelOrder.indexOf(panelId) + 1])}><ChevronRight size={18}/></button></div>
            </div>
            <div className="comic-panel-actions">
              <button disabled={working} onClick={() => setEditor({ mode: 'edit', panelId, plan: structuredClone(panel.plan) })}>编辑分镜与对白</button>
              <button disabled={working} onClick={() => setPromptEditor(panel)}>编辑生图输入</button>
              <button disabled={working} onClick={() => run('comics.prompts.generate', { panelIds: [panelId], rewrite: true, confirmCosts: true })}>LLM 编写提示词</button>
              <button disabled={working || panel.candidates.length >= 4} onClick={() => run('comics.images.generate', { panelIds: [panelId], mode: candidate ? 'reroll' : 'missing', confirmCosts: true })}>{candidate ? '再生成候选' : '生成本格'}</button>
            </div>
            <div className="comic-candidates">{panel.candidates.map((c, i) => <button key={c.candidateId} className={candidate?.candidateId === c.candidateId ? 'selected' : ''} onClick={() => { setCandidateId(c.candidateId); setAnchors({}); setPoint(null); }}>
              候选 {i + 1}<small>{c.humanApproved ? '人工通过' : labels[c.qcStatus]}</small>
            </button>)}</div>
            {candidate ? <>
              <div className="comic-image-controls"><label>点击原图定位<select value={speaker} onChange={e => setSpeaker(e.target.value)}><option value="">批注位置</option>{speakers.map(s => <option key={s} value={s}>说话角色 · {s}</option>)}</select></label><button onClick={() => setZoom(true)}>放大原图 <ExternalLink size={14}/></button></div>
              <div className="comic-image-stage"><div className="comic-image-map" onClick={imageClick} role="button" tabIndex={0} aria-label="点击原图记录批注或说话角色位置">
                <img src={currentImage} alt={`${panel.panelId} 当前候选原图`} />
                {Object.entries(anchors).map(([name, pos]) => <span className="comic-marker" key={name} style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }}>{name}</span>)}
                {point && <span className="comic-marker note" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>批注</span>}
              </div></div>
              {speakers.length > 0 && <p className="comic-anchor-progress">说话位置：{speakers.map(s => `${s}${anchors[s] ? ' ✓' : ' 待定位'}`).join(' · ')}</p>}
            </> : <div className="comic-empty small"><p>本格尚无候选图，点击“生成本格”开始生图。</p></div>}
            <details className="comic-reading-plan"><summary>对白、拟声与计划状态</summary>
              {panel.plan.dialogue.map(d => <p key={d.dialogueId}><b>{d.speakerId || '旁白'}</b> {d.text}</p>)}
              {panel.plan.sfx.length > 0 && <p>拟声：{panel.plan.sfx.join(' / ')}</p>}
              <pre>{JSON.stringify({ 入格: panel.plannedEntryState, 本格变化: panel.plan.stateDelta }, null, 2)}</pre>
            </details>
          </> : <div className="comic-empty small">选择一个画格开始审稿。</div>}
        </main>
        <aside className="comic-review">
          {panel && <>
            <h3>分镜与预检证据</h3><p className="comic-storyboard">{panel.plan.storyboardDescription}</p>
            <blockquote>{panel.plan.sourceExcerpt}<cite>{panel.plan.sourceLocator}</cite></blockquote>
            <details><summary>画面要求与生成输入</summary><p>必须呈现：{panel.plan.mustShow.join('；') || '按分镜'}</p><p>不能呈现：{panel.plan.mustNotShow.join('；') || '按原文时点'}</p><p>画幅理由：{panel.plan.canvasReason}</p><pre>{candidate?.request.basePrompt || 'Prompt 待编写'}</pre>{candidate?.request.characterPrompts?.map((p, i) => <pre key={i}>{p}</pre>)}<pre>{candidate?.request.negativePrompt}</pre></details>
            <div className="comic-qc-report"><h4>{candidate?.humanApproved ? '人工已通过' : labels[candidate?.qcStatus] || '等待图片与预检'}</h4>
              {candidate?.qc && <><p>{candidate.qc.summary}</p>{axes.map((name, i) => { const axis = candidate.qc.criteria[`C${i + 1}`]; return <div key={name}><strong>{name}<span className={`comic-result ${axis.result.toLowerCase()}`}>{axis.result}</span></strong><p>{axis.evidence}</p></div>; })}</>}
              {!candidate?.qc && <p className="comic-muted">Agent 实际查看原图后提交 C1–C12 报告。</p>}
            </div>
            <label className="comic-comment">审稿批注<textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="记录需要修改的动作、身份、道具或画面位置" rows={4}/></label>
            <div className="comic-review-actions"><button className="comic-approve" disabled={working || !candidate || candidate.qcStatus !== 'PASS' || speakers.some(s => !anchors[s])} onClick={() => review('approve')}><Check size={16}/>通过当前候选</button><button disabled={working || !candidate || !comment.trim()} onClick={() => review('reject')}>退回返修</button><button disabled={working || !candidate || !comment.trim()} onClick={() => review('comment')}><MessageSquare size={15}/>保存批注</button></div>
            <details><summary>人工批注历史</summary>{Object.values(episode.humanActions).filter(a => a.panelId === panelId).map(a => <p key={a.actionId}><b>{a.action === 'approve' ? '通过' : a.action === 'reject' ? '退修' : '批注'}</b> {a.comment || '已确认当前候选'}<small>{new Date(a.createdAt).toLocaleString('zh-CN')}</small></p>)}</details>
          </>}
        </aside>
      </div>
      <footer className="comic-assembly"><div><strong>EP 组装</strong><small>{episode.readyToAssemble ? '全格批准已校验，可以生成排字预览。' : episode.reason || '等待本话全部画格人工通过。'}</small></div><div className="comic-tools">
        <button disabled={working || !episode.readyToAssemble} onClick={() => run('comics.assemble')}><Layers size={16}/>组装预览</button>
        {episode.previewUrl && <a href={`${apiBase}${episode.previewUrl}`} target="_blank" rel="noreferrer">查看条漫 <ExternalLink size={14}/></a>}
        <button disabled={working || episode.assemblyStatus !== 'LAYOUT_REVIEW_REQUIRED'} onClick={() => run('human.review', { action: 'layout-pass', comment: '已检查对白、拟声、阅读顺序和手机排版。' })}>排版通过</button>
        <button disabled={working || episode.assemblyStatus !== 'LAYOUT_REVIEW_REQUIRED'} onClick={() => run('human.review', { action: 'layout-reject', comment: comment || '排版需修改，请调整后重新组装。' })}>排版退修</button>
        <button disabled={working || episode.assemblyStatus !== 'SIGNED_OFF'} onClick={() => run('comics.export')}><Download size={16}/>导出交付包</button>
        {episode.lastExport && episode.assemblyStatus === 'SIGNED_OFF' && <a href={`${apiBase}${episode.lastExport.url}`} download>下载最近交付包</a>}
      </div></footer>
    </>}
    {editor && <ComicPlanEditor key={`${editor.mode}/${editor.panelId}`} title={`${editor.panelId} · ${editor.mode === 'add' ? '新增画格' : '编辑分镜'}`} initialPlan={editor.plan} busy={working} error={error} onClose={() => setEditor(null)} onSave={async plan => {
      if (await run(editor.mode === 'add' ? 'comics.panels.add' : 'comics.panels.update', { panelId: editor.panelId, plan })) setEditor(null);
    }}/ >}
    {promptEditor && <ComicPromptEditor panel={promptEditor} busy={working} error={error} onClose={() => setPromptEditor(null)} onSave={async input => {
      if (await run('comics.prompts.write', { panelId: promptEditor.panelId, ...input })) setPromptEditor(null);
    }}/>}
    {zoom && candidate && <div className="comic-zoom" role="dialog" aria-modal="true" aria-label="原图放大"><button onClick={() => setZoom(false)}>关闭原图</button><img src={currentImage} alt="候选原尺寸查看"/></div>}
  </section>;
}
