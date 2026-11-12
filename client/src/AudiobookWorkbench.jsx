import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Headphones, Play, Pause, Square, Download, RefreshCw, KeyRound, Save, Trash2,
  AlertTriangle, CheckCircle2, Loader2, Gauge, Volume2, FileAudio, ChevronDown,
  ChevronRight, Zap, Clock, HardDrive, RotateCcw,
} from 'lucide-react';
import './AudiobookWorkbench.css';

const DEFAULT_BITRATES = [
  { id: 32, label: '32 kbps', note: '极限压缩 · 约 14 MB/小时' },
  { id: 48, label: '48 kbps', note: '推荐 · 约 22 MB/小时' },
  { id: 64, label: '64 kbps', note: '高音质 · 约 29 MB/小时' },
  { id: 96, label: '96 kbps', note: '接近无损 · 约 43 MB/小时' },
];

const DEFAULT_VOICES = [
  { id: '白桦', desc: '沉稳磁性' },
  { id: '苏打', desc: '清朗阳光' },
  { id: '茉莉', desc: '温柔知性' },
  { id: '冰糖', desc: '甜美活泼' },
];

/** 「填入示例」用的一小段正文，带叙述和一句对白，能听出语气差别 */
const SAMPLE_PRESET = '雨下了一整夜。她推门进来的时候，带进一阵潮湿的风，伞尖还在滴水。'
  + '“你等了很久？”她把伞靠在墙角，声音比雨声还轻。他摇摇头，说没有，其实已经坐了一个下午。';

/** 试听文本最长字数，与服务端 SAMPLE_MAX_CHARS 保持一致 */
const SAMPLE_MAX_CHARS = 500;

const STATUS_TEXT = {  pending: '未生成',
  encoding: '编码中',
  done: '已完成',
  error: '失败',
  empty: '空章节',
  skipped: '跳过',
};

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function fmtEta(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '—';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

export default function AudiobookWorkbench({ apiBase, projectName, projects = [], onSelectProject }) {
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);

  const [settings, setSettings] = useState({
    voice: '白桦', bitrateKbps: 48, concurrency: 4, chunkChars: 1600,
    chunkGapSec: 0.35, chapterGapSec: 1.0, context: '',
  });
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [force, setForce] = useState(false);

  const [task, setTask] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logOpen, setLogOpen] = useState(true);

  /* 试听：同一时刻只展开一章；token 用于章节重生后强制播放器重新拉流 */
  const [previewKey, setPreviewKey] = useState(null);
  const [previewToken, setPreviewToken] = useState({});
  const [audioError, setAudioError] = useState('');

  /* 样音试听：输入一小段文字，用当前音色 + 风格指令合成后立刻回放 */
  const [sampleText, setSampleText] = useState(() => {
    try { return window.localStorage.getItem('abw.sampleText') || ''; } catch { return ''; }
  });
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleUrl, setSampleUrl] = useState('');
  const [sampleInfo, setSampleInfo] = useState(null); // { voice, context, ms, bytes, fromCache }
  const [sampleError, setSampleError] = useState('');
  const sampleUrlRef = useRef('');

  const esRef = useRef(null);
  const logBoxRef = useRef(null);
  const settingsRef = useRef(settings);
  /** 首次加载用服务端保存的参数，之后才用页面上的值，避免把已保存音色又推回默认值 */
  const hydratedRef = useRef(false);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  /* 试听文本下次打开还在；blob URL 用完记得回收，否则整段 WAV 一直占内存 */
  useEffect(() => {
    try { window.localStorage.setItem('abw.sampleText', sampleText); } catch { /* 隐私模式忽略 */ }
  }, [sampleText]);

  useEffect(() => () => {
    if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
  }, []);

  // 全局串行：队列里等着的也算「占着任务」，只是没在跑
  const busy = Boolean(task && ['running', 'queued', 'stopping'].includes(task.status));
  const queued = Boolean(task && task.status === 'queued');
  const running = busy && !queued;

  /* ── 拉取状态与章节 ── */
  const loadStatus = useCallback(async () => {
    if (!projectName) return;
    const r = await fetch(`${apiBase}/api/audiobook/status?projectName=${encodeURIComponent(projectName)}`);
    const j = await r.json();
    if (j.ok) setStatus(j);
  }, [apiBase, projectName]);

  const loadChapters = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ projectName });
      if (hydratedRef.current) {
        const s = settingsRef.current;
        q.set('voice', s.voice);
        q.set('bitrateKbps', String(s.bitrateKbps));
        q.set('chunkChars', String(s.chunkChars));
      }
      const r = await fetch(`${apiBase}/api/audiobook/chapters?${q}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '读取章节失败');
      setData(j);
      if (!hydratedRef.current) {
        if (j.settings) setSettings((prev) => ({ ...prev, ...j.settings }));
        hydratedRef.current = true;
      }
      setSelected((prev) => {
        // 默认勾选「还没生成」和「音色已换、需要重生成」的章节；已有勾选则保留仍存在的项
        const needsWork = (c) => c.status !== 'done' || c.stale;
        if (prev.size === 0) {
          return new Set(j.chapters.filter(needsWork).map((c) => c.key));
        }
        const alive = new Set(j.chapters.map((c) => c.key));
        const kept = [...prev].filter((k) => alive.has(k));
        return kept.length ? new Set(kept) : new Set(j.chapters.filter(needsWork).map((c) => c.key));
      });
      if (j.task) {
        setTask(j.task);
        if (Array.isArray(j.task.logs)) setLogs(j.task.logs);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apiBase, projectName]);

  // 组件按书名做了 key，切书会整体重挂载，这里只负责首次加载
  useEffect(() => {
    void loadStatus();
    void loadChapters();
  }, [loadStatus, loadChapters]);

  /* ── 音色/码率/分块变了，重算「哪些章节需要重新生成」 ── */
  const sigKey = `${settings.voice}|${settings.bitrateKbps}|${settings.chunkChars}|24000`;
  useEffect(() => {
    if (!data || !projectName || !hydratedRef.current) return undefined;
    // 输入框正在输数字（超出 400-2400）时别急着重新拉，服务端会 clamp 成另一个值
    if (!(settings.chunkChars >= 400 && settings.chunkChars <= 2400)) return undefined;
    if (data.expectedSignature === sigKey) return undefined;
    const timer = setTimeout(() => { void loadChapters(); }, 350);
    return () => clearTimeout(timer);
  }, [sigKey, data, projectName, loadChapters, settings.chunkChars]);

  /* ── SSE 实时进度 ── */
  useEffect(() => {
    if (!projectName) return undefined;
    const es = new EventSource(`${apiBase}/api/audiobook/events?projectName=${encodeURIComponent(projectName)}`);
    esRef.current = es;

    es.addEventListener('snapshot', (e) => {
      try {
        const { task: t } = JSON.parse(e.data);
        if (t) {
          setTask(t);
          if (Array.isArray(t.logs)) setLogs(t.logs);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('audiobook', (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt.type === 'progress') {
        setTask((prev) => ({ ...prev, ...evt.data, status: 'running' }));
      } else if (evt.type === 'log') {
        setLogs((prev) => [...prev.slice(-299), { at: new Date().toISOString(), level: evt.level, message: evt.message }]);
      } else if (evt.type === 'chapter') {
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            chapters: prev.chapters.map((c) => (c.key === evt.data.key
              ? {
                ...c,
                status: evt.data.status,
                durationSec: evt.data.durationSec ?? c.durationSec,
                bytes: evt.data.bytes ?? c.bytes,
                skippedChars: evt.data.skippedChars ?? c.skippedChars,
                error: evt.data.error || '',
                // 刚合成完的章节一定用的是当前参数
                ...(evt.data.status === 'done' ? { stale: false, voice: settingsRef.current.voice } : {}),
              }
              : c)),
          };
        });
        if (evt.data.status === 'done') {
          // 这一章刚重新合成完，正在试听的话让播放器重新拉流
          setPreviewToken((prev) => ({ ...prev, [evt.data.key]: (prev[evt.data.key] || 0) + 1 }));
          const skipNote = evt.data.skippedChars ? ` · 跳过 ${evt.data.skippedChars} 字` : '';
          setLogs((prev) => [...prev.slice(-299), {
            at: new Date().toISOString(),
            level: evt.data.skippedChars ? 'warn' : 'success',
            message: `${evt.data.title} · 完成 ${fmtDuration(evt.data.durationSec)} · ${fmtBytes(evt.data.bytes)}${skipNote}`,
          }]);
        }
      } else if (evt.type === 'done') {
        setTask((prev) => ({ ...prev, status: 'done', percent: 100, output: evt.data }));
        setNotice(`m4b 已生成：${evt.data.file} · ${fmtBytes(evt.data.bytes)} · ${fmtDuration(evt.data.durationSec)}`);
        void loadChapters();
      } else if (evt.type === 'error') {
        setError(evt.message);
        setTask((prev) => (prev ? { ...prev, status: 'error' } : prev));
      } else if (evt.type === 'stopped') {
        setTask((prev) => (prev ? { ...prev, status: 'stopped' } : prev));
        setNotice(evt.message || '已停止');
        void loadChapters();
      } else if (evt.type === 'task' && evt.data) {
        setTask(evt.data);
      }
    });

    return () => { es.close(); esRef.current = null; };
  }, [apiBase, projectName, loadChapters]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  /* ── 配置 Key ── */
  async function saveKey() {
    if (!keyInput.trim()) { setError('请填写 MiMo API Key'); return; }
    setSavingKey(true);
    setError('');
    try {
      const r = await fetch(`${apiBase}/api/audiobook/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: keyInput.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '保存失败');
      setKeyInput('');
      setNotice(`Key 已保存（${j.key.masked}）`);
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingKey(false);
    }
  }

  async function testKey() {
    setTestingKey(true);
    setError('');
    try {
      const r = await fetch(`${apiBase}/api/audiobook/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: keyInput.trim() || undefined, voice: settings.voice }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '连接失败');
      setNotice(`连接正常 · ${j.latencyMs} ms`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTestingKey(false);
    }
  }

  /* ── 样音试听 ── */
  async function playSample() {
    const text = sampleText.trim();
    if (!text) { setSampleError('请先输入要试听的文字'); return; }
    if (text.length > SAMPLE_MAX_CHARS) {
      setSampleError(`试听文本最长 ${SAMPLE_MAX_CHARS} 字，当前 ${text.length} 字`);
      return;
    }
    setSampleBusy(true);
    setSampleError('');
    try {
      const r = await fetch(`${apiBase}/api/audiobook/sample`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: settings.voice, context: settings.context }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `试听失败（HTTP ${r.status}）`);
      }
      const blob = await r.blob();
      if (!blob.size) throw new Error('返回的音频是空的，换个文本再试');
      const url = URL.createObjectURL(blob);
      if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current);
      sampleUrlRef.current = url;
      setSampleUrl(url);
      setSampleInfo({
        voice: settings.voice,
        context: settings.context.trim(),
        ms: Number(r.headers.get('X-Sample-Ms')) || 0,
        bytes: blob.size,
        fromCache: r.headers.get('X-Sample-Cache') === 'hit',
      });
    } catch (err) {
      setSampleError(err.message);
    } finally {
      setSampleBusy(false);
    }
  }

  /* ── 开始 / 停止 / 清理 ── */
  async function start(override) {
    if (!data) return;
    const keys = override?.chapterKeys?.length ? override.chapterKeys : [...selected];
    if (!keys.length) { setError('请至少勾选一个章节'); return; }
    const runForce = override?.force ?? force;
    setError('');
    setNotice('');
    setLogs([]);
    try {
      const r = await fetch(`${apiBase}/api/audiobook/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName,
          chapterKeys: keys,
          settings,
          force: runForce,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '启动失败');
      const voiceNote = runForce ? ` · 音色 ${settings.voice}` : '';
      if (j.queued) {
        setTask({ taskId: j.taskId, status: 'queued', percent: 0, queueAhead: j.ahead, queuePosition: j.position });
        setNotice(`已排队 · ${keys.length} 章${voiceNote} · 前面还有 ${j.ahead} 本`);
      } else {
        setTask({ taskId: j.taskId, status: 'running', percent: 0 });
        setNotice(`已启动 · ${keys.length} 章${voiceNote} · 并发 ${settings.concurrency}`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  /** 用当前音色重生成一章 */
  async function regenerate(chapter) {
    if (busy) return;
    const ok = window.confirm(
      `用「${settings.voice}」重新生成第 ${chapter.index + 1} 章？\n\n旧的音频会被覆盖，已生成的 m4b 会在下次完成后重新封装。`,
    );
    if (!ok) return;
    await start({ chapterKeys: [chapter.key], force: true });
  }

  /** 音色换过之后，一键把不一致的章节全部重生成 */
  async function regenerateStale() {
    const keys = chapters.filter((c) => c.stale).map((c) => c.key);
    if (!keys.length || busy) return;
    const ok = window.confirm(
      `用「${settings.voice}」重新生成 ${keys.length} 章？\n\n这些章节已生成的音频是别的音色/码率合成的，需要重新合成才能和其余部分统一。`,
    );
    if (!ok) return;
    await start({ chapterKeys: keys, force: true });
  }

  async function stop() {
    const wasQueued = queued;
    await fetch(`${apiBase}/api/audiobook/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName }),
    });
    if (wasQueued) {
      setNotice('已取消排队');
      setTask((prev) => (prev ? { ...prev, status: 'stopped', queueAhead: 0 } : prev));
      await loadChapters();
      return;
    }
    setNotice('正在停止，已完成的章节会保留');
  }

  async function reset(all) {
    const label = all ? '清空本书全部音频与产物' : '清空所选章节的音频';
    if (!window.confirm(`${label}？此操作不可恢复。`)) return;
    setError('');
    const keys = all ? [] : [...selected];
    const r = await fetch(`${apiBase}/api/audiobook/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectName, chapterKeys: keys }),
    });
    const j = await r.json();
    if (!r.ok) { setError(j.error || '清理失败'); return; }
    setNotice('已清理');
    await loadChapters();
  }

  /* ── 派生数据 ── */
  const chapters = data?.chapters || [];
  const doneCount = chapters.filter((c) => c.status === 'done').length;
  const staleChapters = chapters.filter((c) => c.stale);
  const selectedChapters = useMemo(() => chapters.filter((c) => selected.has(c.key)), [chapters, selected]);
  const selEstSec = selectedChapters.reduce((s, c) => s + c.estDurationSec, 0);
  const estBytes = Math.round((selEstSec * settings.bitrateKbps * 1000) / 8);
  const voices = status?.voices?.length ? status.voices : DEFAULT_VOICES;
  const bitrates = status?.bitrates?.length ? status.bitrates : DEFAULT_BITRATES;
  const ffmpegOk = status?.ffmpeg?.ok;
  const hasKey = status?.key?.hasKey;
  const output = data?.output || task?.output;

  const progress = task?.percent ?? (data?.totals?.estDurationSec ? Math.round((doneCount / Math.max(chapters.length, 1)) * 100) : 0);

  function toggle(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === chapters.length ? new Set() : new Set(chapters.map((c) => c.key))));
  }

  function previewUrl(key) {
    const q = new URLSearchParams({
      projectName,
      chapterKey: key,
      t: String(previewToken[key] || 0),
    });
    return `${apiBase}/api/audiobook/preview?${q}`;
  }

  function togglePreview(key) {
    setAudioError('');
    setPreviewKey((prev) => (prev === key ? null : key));
  }

  if (!projectName) {
    return (
      <div className="abw-empty">
        <Headphones size={44} />
        <h3>先选一本小说</h3>
        <p>有声书与插图共用同一套书籍项目。在「书籍项目」里选中一本书，或直接在下方选择。</p>
        <div className="abw-empty-list">
          {projects.slice(0, 8).map((p) => (
            <button key={p.name} type="button" onClick={() => onSelectProject?.(p.name)}>
              <FileAudio size={14} /> {p.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="abw-root">
      {/* 顶部：书籍 + 关键状态 */}
      <div className="abw-toolbar">
        <div className="abw-toolbar-main">
          <div className="abw-eyebrow">AUDIOBOOK / M4B PIPELINE</div>
          <div className="abw-title-row">
            <select
              className="abw-book-select"
              value={projectName}
              onChange={(e) => onSelectProject?.(e.target.value)}
              title="切换书籍（与生图共用项目）"
            >
              {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              {!projects.some((p) => p.name === projectName) && <option value={projectName}>{projectName}</option>}
            </select>
            {data && (
              <span className="abw-meta">
                <FileAudio size={13} /> {chapters.length} 章 · {(data.totals?.chars || 0).toLocaleString()} 字
              </span>
            )}
            {data && (
              <span className="abw-meta">
                <Clock size={13} /> 预计 {fmtDuration(data.totals?.estDurationSec || 0)}
              </span>
            )}
          </div>
        </div>
        <div className="abw-chips">
          <span className={`abw-chip ${ffmpegOk ? 'ok' : 'bad'}`} title={status?.ffmpeg?.ffmpeg || status?.ffmpeg?.error || ''}>
            ffmpeg {ffmpegOk ? '就绪' : '未安装'}
          </span>
          <span className={`abw-chip ${hasKey ? 'ok' : 'bad'}`} title={status?.key?.masked || ''}>
            Key {hasKey ? status.key.masked : '未填写'}
          </span>
          <button className="abw-icon-btn" type="button" onClick={() => { void loadStatus(); void loadChapters(); }} title="刷新">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {error && <div className="abw-alert error"><AlertTriangle size={15} /> {error}</div>}
      {notice && !error && <div className="abw-alert ok"><CheckCircle2 size={15} /> {notice}</div>}

      <div className="abw-body">
        {/* 左：参数 */}
        <aside className="abw-panel">
          <div className="abw-panel-block">
            <h4><KeyRound size={14} /> MiMo API Key</h4>
            <div className="abw-key-row">
              <input
                type="password"
                placeholder={hasKey ? `已保存 ${status?.key?.masked || ''}，留空则保持不变` : '粘贴 MiMo API Key'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                autoComplete="off"
              />
              <button type="button" onClick={saveKey} disabled={savingKey}>
                {savingKey ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存
              </button>
            </div>
            <button className="abw-ghost-btn" type="button" onClick={testKey} disabled={testingKey}>
              {testingKey ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} 测试连接（1 句短文本）
            </button>
            <p className="abw-hint">Key 只写入本机 <code>.env</code>，不会回传到页面。</p>
          </div>

          <div className="abw-panel-block">
            <h4><Volume2 size={14} /> 音色</h4>
            <select value={settings.voice} onChange={(e) => setSettings({ ...settings, voice: e.target.value })}>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.id} · {v.desc}</option>)}
            </select>
            <label className="abw-field">
              <span>风格指令（可选，导演模式）</span>
              <textarea
                rows={2}
                placeholder="例如：低沉的男声，语速偏慢，句尾留白"
                value={settings.context}
                onChange={(e) => setSettings({ ...settings, context: e.target.value })}
              />
            </label>

            {/* 样音试听：先用一小段文字听效果，满意了再整本开跑 */}
            <div className="abw-sample">
              <label className="abw-field">
                <span>
                  试听文本
                  <em className={`abw-count${sampleText.length > SAMPLE_MAX_CHARS ? ' over' : ''}`}>
                    {sampleText.length}/{SAMPLE_MAX_CHARS}
                  </em>
                </span>
                <textarea
                  rows={3}
                  maxLength={SAMPLE_MAX_CHARS}
                  placeholder="粘贴一小段正文，用当前音色 + 上面的风格指令合成一段试听"
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                />
              </label>
              <div className="abw-sample-row">
                <button
                  className="abw-ghost-btn"
                  type="button"
                  onClick={playSample}
                  disabled={!hasKey || sampleBusy || !sampleText.trim()}
                  title={hasKey ? '用当前音色和风格指令合成这段文字' : '请先填写并保存 MiMo API Key'}
                >
                  {sampleBusy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                  {sampleBusy ? '合成中…' : '试听这段'}
                </button>
                <button
                  className="abw-ghost-btn"
                  type="button"
                  onClick={() => setSampleText(SAMPLE_PRESET)}
                  disabled={sampleBusy}
                >
                  填入示例
                </button>
              </div>

              {sampleError && (
                <p className="abw-sample-error"><AlertTriangle size={13} /> {sampleError}</p>
              )}

              {sampleUrl && (
                <>
                  <audio key={sampleUrl} className="abw-audio" src={sampleUrl} controls autoPlay />
                  <p className="abw-sample-meta">
                    <span>
                      {sampleInfo?.voice}
                      {sampleInfo?.context
                        ? ` · 风格「${sampleInfo.context.length > 16 ? `${sampleInfo.context.slice(0, 16)}…` : sampleInfo.context}」`
                        : ' · 无风格指令'}
                    </span>
                    <span>
                      {sampleInfo?.ms ? `${(sampleInfo.ms / 1000).toFixed(1)}s` : ''}
                      {sampleInfo?.bytes ? ` · ${fmtBytes(sampleInfo.bytes)}` : ''}
                      {sampleInfo?.fromCache ? ' · 缓存' : ''}
                    </span>
                  </p>
                  {sampleInfo
                    && (sampleInfo.voice !== settings.voice || sampleInfo.context !== settings.context.trim()) && (
                      <p className="abw-sample-stale">音色或风格指令已改，重新试听才是新的参数</p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="abw-panel-block">
            <h4><Gauge size={14} /> 并发与压缩</h4>
            <label className="abw-field">
              <span>并发请求数 <b>{settings.concurrency}</b></span>
              <input
                type="range" min="1" max="16" step="1"
                value={settings.concurrency}
                onChange={(e) => setSettings({ ...settings, concurrency: Number(e.target.value) })}
              />
            </label>
            <label className="abw-field">
              <span>音频码率（AAC，直接决定体积）</span>
              <select
                value={settings.bitrateKbps}
                onChange={(e) => setSettings({ ...settings, bitrateKbps: Number(e.target.value) })}
              >
                {bitrates.map((b) => <option key={b.id} value={b.id}>{b.label} · {b.note}</option>)}
              </select>
            </label>
            <div className="abw-estimate">
              <HardDrive size={13} />
              <span>所选 {selectedChapters.length} 章 · 预计 {fmtDuration(selEstSec)} · 约 {fmtBytes(estBytes)}</span>
            </div>
            <p className="abw-hint">TTS 原始 WAV 约 384 kbps；48 kbps 约省下 87% 空间。</p>
          </div>

          <div className="abw-panel-block">
            <button className="abw-collapse" type="button" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 高级
            </button>
            {advanced && (
              <>
                <label className="abw-field">
                  <span>每块字数（400-2400）</span>
                  <input
                    type="number" min="400" max="2400" step="100"
                    value={settings.chunkChars}
                    onChange={(e) => setSettings({ ...settings, chunkChars: Number(e.target.value) })}
                  />
                </label>
                <label className="abw-field">
                  <span>块间停顿（秒）</span>
                  <input
                    type="number" min="0" max="3" step="0.05"
                    value={settings.chunkGapSec}
                    onChange={(e) => setSettings({ ...settings, chunkGapSec: Number(e.target.value) })}
                  />
                </label>
                <label className="abw-field">
                  <span>章间停顿（秒）</span>
                  <input
                    type="number" min="0" max="5" step="0.1"
                    value={settings.chapterGapSec}
                    onChange={(e) => setSettings({ ...settings, chapterGapSec: Number(e.target.value) })}
                  />
                </label>
                <label className="abw-check">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  强制重跑已完成的章节
                </label>
                <div className="abw-danger-row">
                  <button type="button" className="abw-danger" onClick={() => reset(false)} disabled={busy}>
                    <Trash2 size={13} /> 清空所选章节
                  </button>
                  <button type="button" className="abw-danger" onClick={() => reset(true)} disabled={busy}>
                    <Trash2 size={13} /> 清空全书
                  </button>
                </div>
              </>
            )}
          </div>
        </aside>

        {/* 右：章节 + 进度 + 日志 */}
        <main className="abw-main">
          <div className="abw-progress-card">
            <div className="abw-progress-head">
              <div>
                <strong>
                  {queued ? '排队中'
                    : running ? (task.status === 'stopping' ? '正在停止…' : '合成中')
                      : task?.status === 'done' ? '已完成'
                        : task?.status === 'error' ? '中断'
                          : task?.status === 'stopped' ? '已停止' : '就绪'}
                </strong>
                <span>
                  {queued ? (
                    <>
                      {task.queueAhead > 0 ? `前面还有 ${task.queueAhead} 本` : '下一本轮到本书'}
                      {task.blockingProject ? ` · 正在合成《${task.blockingProject}》` : ''}
                      {' '}· 轮到后自动开始，可以切走
                    </>
                  ) : (
                    <>
                      {doneCount}/{chapters.length} 章已完成
                      {task?.doneChunks ? ` · 块 ${task.doneChunks}/${task.totalChunks}` : ''}
                      {running && task?.etaSec ? ` · 剩余约 ${fmtEta(task.etaSec)}` : ''}
                      {task?.aacBytes ? ` · 已压缩 ${fmtBytes(task.aacBytes)}` : ''}
                    </>
                  )}
                </span>
              </div>
              <div className="abw-actions">
                {busy ? (
                  <button className="abw-btn danger" type="button" onClick={stop} disabled={task.status === 'stopping'}>
                    {queued ? <><Clock size={14} /> 取消排队</> : <><Square size={14} /> 停止</>}
                  </button>
                ) : (
                  <button className="abw-btn primary" type="button" onClick={() => start()} disabled={!hasKey || !ffmpegOk || !selected.size}>
                    <Play size={14} /> 开始合成
                  </button>
                )}
                {output && (
                  <a className="abw-btn download" href={`${apiBase}/api/audiobook/download?projectName=${encodeURIComponent(projectName)}`}>
                    <Download size={14} /> 下载 m4b
                  </a>
                )}
              </div>
            </div>
            <div className={`abw-bar${queued ? ' is-queued' : ''}`}><span style={{ width: `${queued ? 100 : Math.min(100, Math.max(0, progress))}%` }} /></div>
            {output && (
              <div className="abw-output">
                <CheckCircle2 size={14} />
                <b>{output.file}</b>
                <span>{fmtBytes(output.bytes)}</span>
                <span>{fmtDuration(output.durationSec)}</span>
                <span>{output.chapters} 章</span>
                {output.compressionRatio ? <span className="abw-ratio">体积 ≈ WAV 的 1/{output.compressionRatio}</span> : null}
              </div>
            )}
            {!hasKey && <p className="abw-hint warn">还需要填写 MiMo API Key 才能开始。</p>}
            {hasKey && !ffmpegOk && <p className="abw-hint warn">系统未检测到 ffmpeg，无法压缩并打包 m4b。</p>}
          </div>

          <div className="abw-chapters">
            <div className="abw-chapters-head">
              <label className="abw-check">
                <input
                  type="checkbox"
                  checked={chapters.length > 0 && selected.size === chapters.length}
                  onChange={toggleAll}
                />
                全选
              </label>
              <span>{selected.size} 章已选 · 预计 {fmtBytes(estBytes)}</span>
            </div>

            {staleChapters.length > 0 && (
              <div className="abw-stale">
                <AlertTriangle size={14} />
                <span>
                  当前音色 <b>{settings.voice}</b> 与 {staleChapters.length} 章已生成的音频不一致
                  <small>直接开始合成会自动重生成这些章节，也可以只重生成它们。</small>
                </span>
                <button type="button" onClick={regenerateStale} disabled={busy || !hasKey || !ffmpegOk}>
                  <RotateCcw size={13} /> 重生成这 {staleChapters.length} 章
                </button>
              </div>
            )}

            {audioError && <div className="abw-player-error"><AlertTriangle size={13} /> {audioError}</div>}

            <div className="abw-chapter-list">
              {loading && !chapters.length && <div className="abw-placeholder"><Loader2 size={16} className="spin" /> 正在读取章节…</div>}
              {!loading && !chapters.length && <div className="abw-placeholder">这本书还没有可读章节。</div>}
              {chapters.map((c) => (
                <div key={c.key} className="abw-chapter-item">
                  <div
                    className={`abw-chapter ${selected.has(c.key) ? 'checked' : ''} ${c.status}${c.stale ? ' is-stale' : ''}`}
                    onClick={() => toggle(c.key)}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(c.key)}
                      onChange={() => toggle(c.key)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="abw-chapter-title">
                      <b>{c.index + 1}. {c.title}</b>
                      <small>
                        {c.charCount.toLocaleString()} 字 · 约 {fmtDuration(c.estDurationSec)}
                        {c.stale ? ` · 现为「${c.voice || '旧音色'}」` : ''}
                      </small>
                    </span>
                    {c.stale && <span className="abw-badge-stale" title="音频参数与当前设置不一致">待重生成</span>}
                    <span className={`abw-chapter-status ${c.status}${c.skippedChars ? ' skipped' : ''}`}>
                      {c.status === 'done'
                        ? `${fmtDuration(c.durationSec)} · ${fmtBytes(c.bytes)}${c.skippedChars ? ` · 跳过 ${c.skippedChars} 字` : ''}`
                        : (c.status === 'error' ? (c.error || STATUS_TEXT.error) : STATUS_TEXT[c.status] || c.status)}
                    </span>
                    {c.status === 'done' && (
                      <span className="abw-chapter-tools">
                        <button
                          type="button"
                          className={`abw-tool-btn${previewKey === c.key ? ' active' : ''}`}
                          title={previewKey === c.key ? '收起试听' : '在线试听这一章'}
                          onClick={(e) => { e.stopPropagation(); togglePreview(c.key); }}
                        >
                          {previewKey === c.key ? <Pause size={13} /> : <Play size={13} />}
                        </button>
                        <button
                          type="button"
                          className="abw-tool-btn"
                          title={`用「${settings.voice}」重新生成这一章`}
                          disabled={busy || !hasKey || !ffmpegOk}
                          onClick={(e) => { e.stopPropagation(); void regenerate(c); }}
                        >
                          <RotateCcw size={13} />
                        </button>
                      </span>
                    )}
                  </div>

                  {previewKey === c.key && (
                    <div className="abw-player">
                      <audio
                        key={`${c.key}-${previewToken[c.key] || 0}`}
                        controls
                        autoPlay
                        preload="metadata"
                        src={previewUrl(c.key)}
                        onError={() => setAudioError(`第 ${c.index + 1} 章试听加载失败，可能音频片段已损坏，可重新生成该章后再试。`)}
                      />
                      <div className="abw-player-meta">
                        <span>试听 · {c.title}</span>
                        <span>{c.stale ? `当前音频是「${c.voice || '旧音色'}」，重生成后自动替换` : `音色「${c.voice || settings.voice}」`}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className={`abw-logs ${logOpen ? '' : 'collapsed'}`}>
            <button className="abw-logs-head" type="button" onClick={() => setLogOpen(!logOpen)}>
              {logOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 运行日志
              <span>{logs.length}</span>
            </button>
            {logOpen && (
              <div className="abw-log-box" ref={logBoxRef}>
                {logs.length === 0 && <p className="abw-log-empty">还没有日志。启动后会实时显示每章合成进度。</p>}
                {logs.map((l, i) => (
                  <p key={`${l.at}-${i}`} className={`abw-log-line ${l.level || 'info'}`}>
                    <time>{new Date(l.at).toLocaleTimeString('zh-CN')}</time>
                    {l.message}
                  </p>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
