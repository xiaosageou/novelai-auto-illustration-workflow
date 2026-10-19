import { useState, useEffect, useRef } from 'react';
import { 
  Settings, Plus, BookOpen, User, Play, Square, Download, 
  RefreshCw, CheckCircle2, Sparkles, X, FileText, Clapperboard, Timer,
  Copy, PanelLeftClose, PanelLeftOpen, Trash2, Pencil, Image as ImageIcon,
  Flame, Heart, Users, MapPin, Camera, ChevronDown, ChevronUp, Check, Terminal,
  Maximize2, Minimize2
} from 'lucide-react';
import { isSingleChapterGenerateDisabled } from './chapterQueueState.js';
import { isNaiLogMessage } from './logClassification.js';
import { mergeProjectProgressSnapshot } from './projectProgressState.js';
import { placeReaderScenesByParagraph } from './readerScenePlacement.js';
import ComicWorkbench from './ComicWorkbench.jsx';
import {
  SCENE_CHARACTER_DETAIL_FIELDS,
  buildCharacterReferenceSummary,
  characterHasSceneDetails,
  formatSceneCharacterInteractionLines,
  normalizeSceneCharacterInteractionList,
  parseSceneCharacterInteractionLines,
  syncSceneCharacterInteractions,
  syncSceneCharactersFromNames
} from './sceneEditorCharacters.js';
import { SEX_POSITION_CATEGORIES, ALL_SEX_POSITIONS } from './sexPositions.js';

const API_BASE = import.meta.env.DEV ? "http://localhost:5001" : "";

export const BUILTIN_ARTIST_PRESETS = [
  {
    id: 'default_commercial',
    name: '默认商插 · 韩系现代立绘',
    desc: 'youngjoo kjy + nardack + rella · 高质感骨骼五官、通透发丝与仙气质感',
    prompt: '4::masterpiece, best quality ::, 2::official art, year2024, year2025 ::, 2.25::artist:youngjoo kjy ::, 1.45::artist:nardack ::, 1.25::artist:rella ::, 1.05::artist:qiandaiyiyu ::, 1.05::artist:atdan ::, 0.85::artist:void_0 ::, 0.65::artist:stu_dts ::, 0.75::artist:wo_jiushi_kanbudong ::, 0.75::artist:nixeu ::, -3::3D ::, 1.35::rim lighting, deep shadows, volumetric lighting, high contrast, cinematic lighting ::, no text'
  },
  {
    id: 'recipe_a_soft',
    name: '配方 A · 日系私密通透',
    desc: 'mignon + quasarcake + kedama milk · 软萌通透、纯爱日常、细腻轻纱丝袜与温润肤质',
    prompt: '0.6::mignon, artist:quasarcake, artist:houkisei, artist:kedama milk, 40hara::, piromizu, [ke-ta], [modare], year 2024, year 2025, fine fabric emphasis, clean lineart, soft shading'
  },
  {
    id: 'recipe_b_dark_fantasy',
    name: '配方 B · 深邃厚重西幻',
    desc: 'raita + misaka 12003 + dino · 深沉暗色调、厚重笔触、强明暗对比（chiaroscuro）',
    prompt: '-3::artist collaboration::, 1.2::misaka_12003-gou::, 0.8::dino_(dinoartforame), wanke, liduke::, 1.3::artist:raita::, artist:ningen_mame, artist:nixeu, dnd, fantasy, dramatic lighting, chiaroscuro, cinematic shadows'
  },
  {
    id: 'recipe_c_cinematic_action',
    name: '配方 C · 商业大片动势',
    desc: 'yoneyama mai + hyulla + mx2j · 米山舞动态构图、高饱和炫彩与电影级色散',
    prompt: '1.05::artist:yoneyama mai::, 0.95::hyulla::, 0.85::momokumo::, 0.8::mx2j::, 0.8::freng::, 0.9::artist:blue gk::, chromatic aberration, light diffusion, vibrant colors, dynamic pose, year 2025, year 2026'
  }
];

function AutoResizeTextarea({ style, value, onChange, minRows = 2, ...props }) {
  const textareaRef = useRef(null);

  const resize = () => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };

  useEffect(() => {
    resize();
  }, [value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      rows={minRows}
      value={value}
      onChange={(event) => {
        onChange?.(event);
        requestAnimationFrame(resize);
      }}
      style={{
        ...style,
        resize: 'none',
        overflow: 'hidden'
      }}
    />
  );
}

function App() {
  // 核心业务状态
  const [config, setConfig] = useState({
    llm_url: "",
    llm_key: "",
    llm_model: "deepseek-chat",
    llm_preset_id: "",
    llm_stream_enabled: true,
    llm_rate_limit_enabled: true,
    llm_rate_limit_rpm: 3,
    llm_api_presets: [],
    llm_character_dna_url: "",
    llm_character_dna_key: "",
    llm_character_dna_model: "",
    llm_character_dna_preset_id: "",
    llm_scene_url: "",
    llm_scene_key: "",
    llm_scene_model: "",
    llm_scene_preset_id: "",
    llm_nai_tags_url: "",
    llm_nai_tags_key: "",
    llm_nai_tags_model: "",
    llm_nai_tags_preset_id: "",
    llm_trim_url: "",
    llm_trim_key: "",
    llm_trim_model: "",
    llm_trim_preset_id: "",
    nai_token: "",
    nai_model: "nai-diffusion-4-5-full",
    nai_cooldown_seconds: 15,
    steps: 28,
    scale: 5.5,
    sampler: "k_euler_ancestral",
    noiseSchedule: "karras",
    cjk_scene_divisor: 600,
    english_scene_divisor: 350,
    max_scenes_per_request: 5,
    proxy_url: "",
    useVibeTransfer: false,
    vibeBundlePath: "2026-06-04.naiv4vibebundle",
    vibeStrength: 0.45,
    vibeInfoExtracted: 1.0,
    vibeNormalizeStrengths: true,
    nai_url: "https://image.novelai.net",
    artistStylePrompt: "",
    artist_presets: [],
    system_prompt_advanced_prompt: "",
    system_prompt_advanced_prompt_nl: ""
  });
  const [newArtistPresetName, setNewArtistPresetName] = useState('');

  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState("");
  const [projectDetails, setProjectDetails] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [mainTab, setMainTab] = useState('workbench'); // 'books' | 'dna' | 'workbench'
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [isLogsMaximized, setIsLogsMaximized] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState('scenes');
  const [selectedDnaCharacter, setSelectedDnaCharacter] = useState('');
  const [dnaSearchQuery, setDnaSearchQuery] = useState('');
  const [chapterContent, setChapterContent] = useState(null);
  const [textSelections, setTextSelections] = useState([]);
  const [isSubmittingSelections, setIsSubmittingSelections] = useState(false);
  const [isProjectSidebarCollapsed, setIsProjectSidebarCollapsed] = useState(() => (
    window.localStorage.getItem('project-sidebar-collapsed') === 'true'
  ));
  
  // 流水线运行状态
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [cooldownState, setCooldownState] = useState({
    cooldownSeconds: 15,
    baseCooldownSeconds: 15,
    mode: 'normal',
    consecutive429: 0,
    degradedSuccesses: 0
  });
  const [logs, setLogs] = useState([]);
  const [naiLogs, setNaiLogs] = useState([]);

  // 弹窗状态
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [configTab, setConfigTab] = useState('basic');
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [deleteProjectPrompt, setDeleteProjectPrompt] = useState(null);
  const [deleteProjectFiles, setDeleteProjectFiles] = useState(false);
  const [expandedPrompt, setExpandedPrompt] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [loadingScenes, setLoadingScenes] = useState({});
  const [chapterQueueStates, setChapterQueueStates] = useState({});
  const [dnaUpdatePrompt, setDnaUpdatePrompt] = useState(null);
  const [sceneEditor, setSceneEditor] = useState(null);
  const [sceneEditorDirty, setSceneEditorDirty] = useState(false);
  const [savingScene, setSavingScene] = useState(false);
  const [expandedSceneCharacterDetails, setExpandedSceneCharacterDetails] = useState({});
  const [inlineEditingSceneKey, setInlineEditingSceneKey] = useState(null);
  const [inlineSceneDraft, setInlineSceneDraft] = useState(null);
  const [savingInlineScene, setSavingInlineScene] = useState(false);
  const [quickUpdatingSceneKey, setQuickUpdatingSceneKey] = useState(null);
  const [editingCharacterName, setEditingCharacterName] = useState("");
  const [editingCharacterFeatures, setEditingCharacterFeatures] = useState(null);
  const [editingProxyCharacter, setEditingProxyCharacter] = useState(null);
  const [savingCharacterTags, setSavingCharacterTags] = useState(false);
  const [editingAppearanceVersion, setEditingAppearanceVersion] = useState(null);
  const [savingAppearanceVersion, setSavingAppearanceVersion] = useState(false);
  const [isExtractingDna, setIsExtractingDna] = useState(false);
  
  // 新建项目表单
  const [newProjName, setNewProjName] = useState("");
  const [newProjText, setNewProjText] = useState("");
  const [isParsing, setIsParsing] = useState(false);

  // LLM 模型列表缓存与加载状态
  const [availableModels, setAvailableModels] = useState({});
  const [isLoadingModels, setIsLoadingModels] = useState({});
  const [modelError, setModelError] = useState({});

  const getReaderSelectionStorageKey = (projectName, chapterKey) => (
    projectName && chapterKey ? `reader-selections::${projectName}::${chapterKey}` : ""
  );
  const getChapterQueueStateKey = (projectName, chapterKey) => (
    projectName && chapterKey ? `${projectName}::${chapterKey}` : ""
  );

  const replaceProjectChapterQueueStates = (projectName, nextChapterStates = {}) => {
    if (!projectName) return;
    setChapterQueueStates(prev => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([key]) => !key.startsWith(`${projectName}::`))
      );
      for (const [chapterKey, state] of Object.entries(nextChapterStates)) {
        const compositeKey = getChapterQueueStateKey(projectName, chapterKey);
        if (compositeKey && state) {
          next[compositeKey] = state;
        }
      }
      return next;
    });
  };

  const normalizeReaderSelections = (selections, paragraphs = []) => {
    const seen = new Set();
    return (Array.isArray(selections) ? selections : [])
      .map(item => ({
        paragraphIndex: Number(item?.paragraphIndex),
        text: String(item?.text || '').trim(),
        paragraph: String(item?.paragraph || '').trim()
      }))
      .filter(item => {
        const paragraph = paragraphs[item.paragraphIndex];
        return item.text && paragraph && (item.paragraph === paragraph || paragraph.includes(item.text));
      })
      .filter(item => {
        const key = `${item.paragraphIndex}::${item.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(item => ({
        ...item,
        paragraph: paragraphs[item.paragraphIndex]
      }));
  };

  const saveReaderSelections = (projectName, chapterKey, selections) => {
    const storageKey = getReaderSelectionStorageKey(projectName, chapterKey);
    if (!storageKey) return;
    if (!Array.isArray(selections) || selections.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(selections));
  };

  const loadReaderSelections = (projectName, chapterKey, paragraphs = []) => {
    const storageKey = getReaderSelectionStorageKey(projectName, chapterKey);
    if (!storageKey) return [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return normalizeReaderSelections(parsed, paragraphs);
    } catch {
      return [];
    }
  };

  useEffect(() => {
    window.localStorage.setItem('project-sidebar-collapsed', String(isProjectSidebarCollapsed));
  }, [isProjectSidebarCollapsed]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setIsParsing(true);
    addLog(`📁 正在读取并上传解析文件: ${file.name}...`);
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const dataUrl = event.target.result;
      try {
        const res = await fetch(`${API_BASE}/api/parse-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            base64Data: dataUrl
          })
        });
        const data = await res.json();
        if (data.success) {
          setNewProjName(data.suggestedName);
          setNewProjText(data.text);
          addLog(`✅ 文件解析成功: ${file.name} (共 ${data.text.length} 字)`);
        } else {
          addLog(`❌ 解析文件失败: ${data.error || '未知错误'}`, "error");
        }
      } catch (err) {
        addLog(`❌ 解析文件异常: ${err.message}`, "error");
      } finally {
        setIsParsing(false);
      }
    };
    reader.onerror = () => {
      addLog("读取本地文件失败！", "error");
      setIsParsing(false);
    };
    reader.readAsDataURL(file);
  };

  const logsEndRef = useRef(null);
  const naiLogsEndRef = useRef(null);

  // 初始化加载
  useEffect(() => {
    fetchConfig();
    fetchProjects();
  }, []);

  // 建立 SSE 实时监听
  useEffect(() => {
    const eventSource = new EventSource(`${API_BASE}/api/events`);

    eventSource.addEventListener('cooldown', (e) => {
      const data = JSON.parse(e.data);
      setCooldown(data.remaining);
      setCooldownState(prev => ({ ...prev, ...data }));
    });

    eventSource.addEventListener('cooldown_start', (e) => {
      const data = JSON.parse(e.data);
      setCooldown(data.remaining);
      setCooldownState(prev => ({ ...prev, ...data }));
      addLog(`⏱️ NAI 接口进入 ${data.cooldownSeconds || 15}s 冷却，等待锁释放...`);
    });

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'character_dna_required') {
        setPipelineRunning(false);
        setDnaUpdatePrompt(data);
        addLog(`⚠️ 进入${data.sliceLabel}前需要更新角色 DNA，流水线已暂停。`, 'warning');
        if (activeProject) {
          fetchProjectDetails(activeProject);
        }
        return;
      }

      if (data.fullProgress) {
        setProjectDetails(prev => mergeProjectProgressSnapshot(prev, data.fullProgress));
      }

      setPipelineRunning(true);

      const sceneKey = `${data.chapterKey}_${data.sceneIdx}`;
      
      if (data.type === 'chapter_scenes_extracted') {
        addLog(`📝 章节「${data.chapter}」已提炼出 ${data.totalScenes} 个场景卡。`);
      } else if (data.imagePath === 'prompt_ready') {
        addLog(`⚡ 章节「${data.chapter}」[场景 ${data.sceneIdx}/${data.totalScenes}] Prompt 已就绪，已推入生图队列。`);
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
      } else if (data.imagePath === null) {
        addLog(`⏳ 章节「${data.chapter}」[场景 ${data.sceneIdx}/${data.totalScenes}] 开始生图中...`);
        setLoadingScenes(prev => ({ ...prev, [sceneKey]: true }));
      } else if (data.imagePath === 'failed') {
        const phaseLabel = data.phase === 'nai'
          ? 'NAI 生图失败'
          : (data.phase === 'llm' ? 'LLM Prompt 生成失败' : '生成失败');
        addLog(`❌ 章节「${data.chapter}」[场景 ${data.sceneIdx}/${data.totalScenes}] ${phaseLabel}！`, 'error');
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
      } else {
        addLog(`🖼️ 章节「${data.chapter}」插图 [场景 ${data.sceneIdx}/${data.totalScenes}] 生图成功！`);
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
      }

      // 增量刷新项目进度
      if (activeProject) {
        fetchProjectDetails(activeProject);
      }
    });

    eventSource.addEventListener('redraw_queue', (e) => {
      const data = JSON.parse(e.data);
      if (data.projectName !== activeProject) return;
      const sceneKey = `${data.chapterKey}_${data.sceneIdx}`;

      if (data.state === 'queued') {
        setLoadingScenes(prev => ({ ...prev, [sceneKey]: 'queued' }));
        addLog(`📋 场景 #${data.sceneIdx} 已进入${data.priority ? '插队' : '重绘'}队列${data.position ? `，当前位置 ${data.position}` : ''}。`);
      } else if (data.state === 'running') {
        setPipelineRunning(true);
        setLoadingScenes(prev => ({ ...prev, [sceneKey]: 'running' }));
        addLog(`🎨 场景 #${data.sceneIdx} 开始执行队列重绘。`);
      } else if (data.state === 'completed') {
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
        if (data.remaining === 0 && !data.pipelineRunning) setPipelineRunning(false);
      } else if (data.state === 'failed') {
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
        if (data.remaining === 0 && !data.pipelineRunning) setPipelineRunning(false);
        addLog(`❌ 场景 #${data.sceneIdx} 队列重绘失败: ${data.message || '未知错误'}`, 'error');
      }
    });

    eventSource.addEventListener('chapter_queue', (e) => {
      const data = JSON.parse(e.data);
      if (data.projectName !== activeProject) return;
      const chapterStateKey = getChapterQueueStateKey(data.projectName, data.chapterKey);
      if (!chapterStateKey) return;

      if (data.state === 'queued' || data.state === 'running') {
        setChapterQueueStates(prev => ({ ...prev, [chapterStateKey]: data.state }));
      } else {
        setChapterQueueStates(prev => {
          const copy = { ...prev };
          delete copy[chapterStateKey];
          return copy;
        });
      }

      if (data.state === 'queued') {
        addLog(`📚 单章「${data.chapterKey}」已加入重画队列${data.position ? `，当前位置 ${data.position}` : ''}。`);
      } else if (data.state === 'running') {
        addLog(`🎬 单章「${data.chapterKey}」开始执行重画队列。`);
      } else if (data.state === 'failed') {
        addLog(`❌ 单章「${data.chapterKey}」队列执行失败: ${data.message || '未知错误'}`, 'error');
        if (activeProject) {
          fetchProjectDetails(activeProject);
        }
      } else if (data.state === 'paused') {
        addLog(`⏸️ 单章「${data.chapterKey}」执行到需要更新角色 DNA，队列已暂停等待处理。`, 'warning');
      }
    });

    eventSource.addEventListener('pipeline_stopped', (e) => {
      const data = JSON.parse(e.data);
      if (data.projectName !== activeProject) return;
      setPipelineRunning(false);
      setLoadingScenes({});
      setChapterQueueStates({});
      addLog("⏸️ 流水线已成功暂停，所有在途任务已秒级切断。");
      fetchStatus(activeProject);
      fetchProjectDetails(activeProject);
    });

    eventSource.addEventListener('characters_completed', (e) => {
      setIsExtractingDna(false);
      const data = JSON.parse(e.data);
      if (Number.isInteger(data?.sliceIndex)) {
        addLog(`🧬 角色 DNA 切片 #${data.sliceIndex + 1} 已更新并合并。`);
      } else {
        addLog("🧙 全局角色 DNA 大辞典智能提炼并合并完毕！");
      }
      if (activeProject) {
        fetchProjectDetails(activeProject);
      }
    });

    eventSource.addEventListener('pipeline_started', (e) => {
      setPipelineRunning(true);
    });

    eventSource.addEventListener('pipeline_completed', (e) => {
      const data = JSON.parse(e.data);
      if (data?.type === 'chapter_generate' && data.chapterKey) {
        addLog(`🎉 单章「${data.chapterKey}」重画完成！`);
      } else {
        addLog(`🎉 项目 ${data.projectName} 批量插画流水线大功告成！`);
      }
      setPipelineRunning(false);
      setIsExtractingDna(false);
      if (activeProject) {
        fetchProjectDetails(activeProject);
      }
    });

    eventSource.addEventListener('pipeline_failed', (e) => {
      const data = JSON.parse(e.data);
      if (data?.type === 'chapter_generate' && data.chapterKey) {
        addLog(`❌ 单章「${data.chapterKey}」重画异常中断: ${data.message}`, 'error');
      } else {
        addLog(`❌ 流水线发生异常中断: ${data.message}`, 'error');
      }
      setPipelineRunning(false);
      setIsExtractingDna(false);
    });

    eventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      addLog(data.text, data.type, data);
    });

    eventSource.addEventListener('error', (e) => {
      setIsExtractingDna(false);
      const data = JSON.parse(e.data);
      addLog(`⚠️ 系统提示: ${data.message}`, 'warning');
    });

    return () => {
      eventSource.close();
    };
  }, [activeProject]);

  // 日志滚动到底部
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    naiLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [naiLogs]);

  useEffect(() => {
    if (!activeProject || !selectedChapter) {
      setChapterContent(null);
      setTextSelections([]);
      return;
    }
    const chapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
    let cancelled = false;
    setChapterContent(null);
    fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapterKey)}/content`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setChapterContent(data);
        setTextSelections(loadReaderSelections(activeProject, chapterKey, data.paragraphs || []));
      })
      .catch(error => addLog(`读取章节正文失败: ${error.message}`, 'error'));
    return () => {
      cancelled = true;
    };
  }, [activeProject, selectedChapter]);

  const addLog = (text, type = 'info', options = {}) => {
    const time = new Date().toLocaleTimeString();
    const appendLogEntry = (prev) => {
      if (options.appendToPrevious && options.streamId && prev.length > 0) {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.streamId === options.streamId) {
          next[next.length - 1] = { ...last, text: `${last.text}${text}` };
          return next.slice(-200);
        }
      }
      return [...prev, { time, text, type, streamId: options.streamId || null }].slice(-200);
    };

    if (isNaiLogMessage(text)) {
      setNaiLogs(appendLogEntry);
    } else {
      setLogs(appendLogEntry);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config`);
      const data = await res.json();
      setConfig({
        ...data,
        llm_stream_enabled: data.llm_stream_enabled !== false,
        llm_rate_limit_enabled: data.llm_rate_limit_enabled !== false,
        llm_rate_limit_rpm: Number(data.llm_rate_limit_rpm) || 3,
        llm_api_presets: (data.llm_api_presets || []).map(normalizePreset),
        artist_presets: Array.isArray(data.artist_presets) ? data.artist_presets : []
      });
    } catch (e) {
      addLog("拉取全局配置失败: " + e.message, "error");
    }
  };

  const saveConfig = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.success) {
        addLog("✅ 全局配置保存并同步成功！");
        setIsConfigOpen(false);
      }
    } catch (e) {
      addLog("保存配置异常: " + e.message, "error");
    }
  };

  const llmTaskFields = {
    default: { url: 'llm_url', key: 'llm_key', model: 'llm_model', presetId: 'llm_preset_id' },
    characterDna: { url: 'llm_character_dna_url', key: 'llm_character_dna_key', model: 'llm_character_dna_model', presetId: 'llm_character_dna_preset_id' },
    scene: { url: 'llm_scene_url', key: 'llm_scene_key', model: 'llm_scene_model', presetId: 'llm_scene_preset_id' },
    naiTags: { url: 'llm_nai_tags_url', key: 'llm_nai_tags_key', model: 'llm_nai_tags_model', presetId: 'llm_nai_tags_preset_id' },
    trim: { url: 'llm_trim_url', key: 'llm_trim_key', model: 'llm_trim_model', presetId: 'llm_trim_preset_id' }
  };

  const normalizePreset = (preset = {}) => ({
    ...preset,
    rateLimitEnabled: preset?.rateLimitEnabled !== false,
    rateLimitRpm: Number(preset?.rateLimitRpm) || 3
  });

  const fetchModels = async (scope = 'default') => {
    const fields = llmTaskFields[scope];
    const llmUrl = config[fields.url] || config.llm_url;
    const llmKey = config[fields.key] || config.llm_key;
    if (!llmKey) {
      setModelError(prev => ({ ...prev, [scope]: "请先填写 LLM API Key" }));
      return;
    }
    setIsLoadingModels(prev => ({ ...prev, [scope]: true }));
    setModelError(prev => ({ ...prev, [scope]: "" }));
    try {
      const res = await fetch(`${API_BASE}/api/config/llm-models?llm_url=${encodeURIComponent(llmUrl)}&llm_key=${encodeURIComponent(llmKey)}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.models)) {
        setAvailableModels(prev => ({ ...prev, [scope]: data.models }));
        addLog(`✅ 成功获取了 ${data.models.length} 个 LLM 聊天模型`);
      } else {
        setModelError(prev => ({ ...prev, [scope]: data.error || "获取模型列表失败" }));
      }
    } catch (err) {
      setModelError(prev => ({ ...prev, [scope]: err.message }));
    } finally {
      setIsLoadingModels(prev => ({ ...prev, [scope]: false }));
    }
  };

  const copyDefaultLlmToTask = (scope) => {
    const fields = llmTaskFields[scope];
    setConfig(prev => ({
      ...prev,
      [fields.presetId]: "",
      [fields.url]: prev.llm_url,
      [fields.key]: prev.llm_key,
      [fields.model]: prev.llm_model
    }));
  };

  const bindPresetToScope = (scope, presetId) => {
    const fields = llmTaskFields[scope];
    const preset = normalizePreset((config.llm_api_presets || []).find(item => item.id === presetId));
    if (!preset?.id) return;

    setConfig(prev => ({
      ...prev,
      [fields.presetId]: preset.id,
      [fields.url]: preset.url || "",
      [fields.key]: preset.key || "",
      [fields.model]: preset.model || ""
    }));
  };

  const copyDefaultLlmToAllTasks = () => {
    setConfig(prev => ({
      ...prev,
      llm_character_dna_preset_id: "",
      llm_character_dna_url: prev.llm_url,
      llm_character_dna_key: prev.llm_key,
      llm_character_dna_model: prev.llm_model,
      llm_scene_preset_id: "",
      llm_scene_url: prev.llm_url,
      llm_scene_key: prev.llm_key,
      llm_scene_model: prev.llm_model,
      llm_nai_tags_preset_id: "",
      llm_nai_tags_url: prev.llm_url,
      llm_nai_tags_key: prev.llm_key,
      llm_nai_tags_model: prev.llm_model
    }));
    addLog("✅ 已将默认 LLM 连接带入三个任务配置");
  };

  const fetchProjects = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/projects`);
      const data = await res.json();
      setProjects(data);
      if (data.length > 0 && !activeProject) {
        selectProject(data[0].name);
      }
      return data;
    } catch (e) {
      addLog("获取项目列表失败: " + e.message, "error");
      return [];
    }
  };

  const selectProject = async (name, shouldSwitchTab = false) => {
    if (activeProject && selectedChapter && textSelections.length > 0) {
      const previousChapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
      saveReaderSelections(activeProject, previousChapterKey, textSelections);
    }
    setEditingCharacterName("");
    setEditingCharacterFeatures(null);
    setEditingProxyCharacter(null);
    closeSceneEditor();
    setActiveProject(name);
    addLog(`📂 载入项目: ${name}`);
    setSelectedChapter(null); // 切换项目时重置选中章节
    setTextSelections([]);
    if (shouldSwitchTab) {
      setMainTab('workbench');
    }
    fetchProjectDetails(name, true);
  };

  const requestDeleteProject = (project, event) => {
    event?.stopPropagation();
    setDeleteProjectPrompt(project);
    setDeleteProjectFiles(false);
  };

  const confirmDeleteProject = async () => {
    if (!deleteProjectPrompt) return;
    const name = deleteProjectPrompt.name;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(name)}?deleteFiles=${deleteProjectFiles ? 'true' : 'false'}`, {
        method: "DELETE"
      });
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
        setDeleteProjectPrompt(null);
        const wasActiveProject = activeProject === name;
        if (wasActiveProject) {
          setActiveProject("");
          setProjectDetails(null);
          setSelectedChapter(null);
          setPipelineRunning(false);
        }
        const updatedProjects = await fetchProjects();
        if (wasActiveProject && updatedProjects.length > 0) {
          selectProject(updatedProjects[0].name);
        }
      } else {
        addLog(`删除项目失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      addLog(`删除项目异常: ${e.message}`, "error");
    }
  };

  const fetchProjectDetails = async (name, isInitialLoad = false) => {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${name}`);
      const data = await res.json();
      setProjectDetails(data);
      if (data.progress?.pipeline_pause?.reason === 'character_dna_required') {
        setDnaUpdatePrompt(data.progress.pipeline_pause);
      }
      
      // 只有在初始加载时，才选中第一个章节
      if (isInitialLoad && data.chapters && data.chapters.length > 0) {
        setSelectedChapter(data.chapters[0]);
      }

      let completedCount = 0;
      if (data.progress && data.progress.completed_chapters) {
        for (const chap of Object.values(data.progress.completed_chapters)) {
          if (chap.status === 'completed') {
            completedCount++;
          }
        }
      }

      // 动态检测该项目后台流水线是否处于运行状态
      const statusRes = await fetch(`${API_BASE}/api/projects/${name}/pipeline/status`);
      const statusData = await statusRes.json();
      setPipelineRunning(statusData.isRunning);
      const nextChapterQueueStates = {};
      if (statusData.chapterQueue?.current?.chapterKey) {
        nextChapterQueueStates[statusData.chapterQueue.current.chapterKey] = 'running';
      }
      for (const queuedChapterKey of statusData.chapterQueue?.pendingChapterKeys || []) {
        if (!nextChapterQueueStates[queuedChapterKey]) {
          nextChapterQueueStates[queuedChapterKey] = 'queued';
        }
      }
      replaceProjectChapterQueueStates(name, nextChapterQueueStates);
      if (statusData.remainingCooldown > 0) {
        setCooldown(statusData.remainingCooldown);
      }
      if (statusData.cooldown) {
        setCooldownState(prev => ({ ...prev, ...statusData.cooldown }));
      }

      // 输出初始状态同步日志
      addLog(`ℹ️ 项目「${name}」已载入，当前处理进度: ${completedCount}/${data.chapters.length} 章节`);
      if (statusData.isRunning) {
        addLog("🚀 检测到流水线正在后台运行中，正实时接收进度更新...");
      }
    } catch (e) {
      addLog("载入项目详情异常: " + e.message, "error");
    }
  };

  const createProject = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: newProjName, bookText: newProjText })
      });
      const data = await res.json();
      if (data.success) {
        addLog(`✅ 书籍项目 ${newProjName} 创建成功！`);
        setNewProjName("");
        setNewProjText("");
        setIsNewProjectOpen(false);
        fetchProjects();
      }
    } catch (e) {
      addLog("创建项目失败: " + e.message, "error");
    }
  };

  const startExtractCharacters = async () => {
    if (!activeProject || isExtractingDna) return;
    try {
      setIsExtractingDna(true);
      const chapters = projectDetails?.chapters || [];
      const selectedIndex = selectedChapter
        ? chapters.findIndex(chap => chap.volume === selectedChapter.volume && chap.chapter === selectedChapter.chapter)
        : 0;
      const chapterIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const sliceIndex = Math.floor(chapterIndex / 10);
      const sliceStart = sliceIndex * 10;
      const sliceEnd = Math.min(sliceStart + 10, chapters.length || sliceStart + 10);

      addLog(`🧬 开始重建第 ${sliceStart + 1}-${sliceEnd} 章角色 DNA（切片 #${sliceIndex + 1}）... 详细流式分析可在「实时日志」中查看。`);
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/character-dna-slices/${sliceIndex}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuePipeline: false })
      });
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      } else {
        setIsExtractingDna(false);
        addLog(`重建角色 DNA 失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      setIsExtractingDna(false);
      addLog("提取角色 DNA 异常: " + e.message, "error");
    }
  };

  const updateDnaSliceAndContinue = async () => {
    if (!activeProject || !dnaUpdatePrompt) return;
    try {
      setIsExtractingDna(true);
      setPipelineRunning(true);
      addLog(`🧬 正在更新${dnaUpdatePrompt.sliceLabel}角色 DNA，完成后自动继续流水线... 详细流式分析可在「实时日志」中查看。`);
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/character-dna-slices/${dnaUpdatePrompt.sliceIndex}/update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            continuePipeline: true,
            targetChapterKey: dnaUpdatePrompt.targetChapterKey || null
          })
        }
      );
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
        setDnaUpdatePrompt(null);
      } else {
        setIsExtractingDna(false);
        setPipelineRunning(false);
        addLog(`❌ 更新角色 DNA 失败: ${data.error || '未知错误'}`, 'error');
      }
    } catch (e) {
      setIsExtractingDna(false);
      setPipelineRunning(false);
      addLog(`❌ 更新角色 DNA 异常: ${e.message}`, 'error');
    }
  };

  const generateSingleChapter = async (chap) => {
    if (!activeProject || !chap) return;
    const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
    const chapterStateKey = getChapterQueueStateKey(activeProject, chapKey);
    try {
      setChapterQueueStates(prev => ({ ...prev, [chapterStateKey]: 'queued' }));
      addLog(`📚 正在将章节「${chap.chapter}」加入单章重画队列...`);
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapKey)}/generate`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.success) {
        setChapterQueueStates(prev => ({ ...prev, [chapterStateKey]: data.state === 'running' ? 'running' : 'queued' }));
        addLog(data.message || `章节「${chap.chapter}」已提交单章重画任务。`);
      } else {
        setChapterQueueStates(prev => {
          const copy = { ...prev };
          delete copy[chapterStateKey];
          return copy;
        });
        addLog(`❌ 启动单章生图失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      setChapterQueueStates(prev => {
        const copy = { ...prev };
        delete copy[chapterStateKey];
        return copy;
      });
      addLog(`❌ 启动单章生图异常: ${e.message}`, "error");
    }
  };

  const redrawScene = async (chap, sceneIdx) => {
    if (!activeProject || !chap) return;
    const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
    const sceneKey = `${chapKey}_${sceneIdx}`;

    try {
      setLoadingScenes(prev => ({ ...prev, [sceneKey]: 'queued' }));
      addLog(`📋 正在将场景 #${sceneIdx} 加入 NAI 重绘队列...`);
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapKey)}/scenes/${sceneIdx}/redraw`,
        { method: "POST" }
      );
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      } else {
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
        addLog(`❌ 重绘场景 #${sceneIdx} 失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      setLoadingScenes(prev => {
        const copy = { ...prev };
        delete copy[sceneKey];
        return copy;
      });
      addLog(`❌ 重绘场景 #${sceneIdx} 异常: ${e.message}`, "error");
    }
  };

  const redrawSceneNaiOnly = async (chap, sceneIdx) => {
    if (!activeProject || !chap) return;
    const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
    const sceneKey = `${chapKey}_${sceneIdx}`;

    try {
      setLoadingScenes(prev => ({ ...prev, [sceneKey]: 'queued' }));
      addLog(`📋 正在将场景 #${sceneIdx} 加入仅 NAI 重绘队列...`);
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapKey)}/scenes/${sceneIdx}/redraw-nai`,
        { method: "POST" }
      );
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      } else {
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
        addLog(`❌ 仅 NAI 重绘场景 #${sceneIdx} 失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      setLoadingScenes(prev => {
        const copy = { ...prev };
        delete copy[sceneKey];
        return copy;
      });
      addLog(`❌ 仅 NAI 重绘场景 #${sceneIdx} 异常: ${e.message}`, "error");
    }
  };

  const isSceneReadyForRender = (scene) => {
    if (!scene) return false;
    const hasPrompt = Boolean(
      scene.final_prompt?.trim() ||
      scene.prepared_prompt?.finalPositive?.trim() ||
      scene.prepared_prompt?.basePrompt?.trim()
    );
    const needsRender = !scene.image_path || scene.image_path === 'failed' || scene.status !== 'SUCCESS';
    return hasPrompt && needsRender;
  };

  const getReadyScenesCount = (targetChapterKey = null) => {
    const completedChapters = projectDetails?.progress?.completed_chapters || {};
    if (!targetChapterKey) {
      let count = 0;
      for (const chap of Object.values(completedChapters)) {
        if (Array.isArray(chap.scenes)) {
          for (const s of chap.scenes) {
            if (isSceneReadyForRender(s)) count++;
          }
        }
      }
      return count;
    }

    const targetNorm = targetChapterKey.replace(/[\s_]+/g, '').toLowerCase();
    for (const [key, chap] of Object.entries(completedChapters)) {
      if (key.replace(/[\s_]+/g, '').toLowerCase() === targetNorm) {
        return (chap.scenes || []).filter(isSceneReadyForRender).length;
      }
    }
    const directChap = completedChapters[targetChapterKey];
    return directChap?.scenes ? directChap.scenes.filter(isSceneReadyForRender).length : 0;
  };

  const startRenderReadyScenes = async (targetChapterKey = null) => {
    if (!activeProject) return;
    try {
      addLog(targetChapterKey ? `🎨 正在将章节「${targetChapterKey}」就绪场景加入生图队列...` : '🎨 正在将所有就绪场景加入生图队列...');
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/pipeline/render-ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterKey: targetChapterKey })
      });
      const data = await res.json();
      if (data.success) {
        addLog(`✅ ${data.message}`);
        fetchProjectDetails(activeProject);
      } else {
        addLog(`❌ 加入生图队列失败: ${data.error || data.message || '未知错误'}`, 'error');
      }
    } catch (err) {
      addLog(`❌ 请求异常: ${err.message}`, 'error');
    }
  };

  const deleteScene = async (chap, sceneIdx) => {
    if (!activeProject || !chap) return;
    const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
    const sceneKey = `${chapKey}_${sceneIdx}`;
    const confirmed = window.confirm(`确定删除场景 #${sceneIdx} 吗？删除后会清除对应图片并重排后续编号。`);
    if (!confirmed) return;

    try {
      setLoadingScenes(prev => ({ ...prev, [sceneKey]: 'deleting' }));
      addLog(`🗑️ 正在删除场景 #${sceneIdx}...`);
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapKey)}/scenes/${sceneIdx}`,
        { method: "DELETE" }
      );
      const responseText = await res.text();
      let data = null;
      try {
        data = responseText ? JSON.parse(responseText) : null;
      } catch {
        throw new Error(`删除场景接口返回了非 JSON 内容: ${responseText.slice(0, 120)}`);
      }

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      if (!data.success) {
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
        addLog(`❌ 删除场景 #${sceneIdx} 失败: ${data.error || '未知错误'}`, "error");
        return;
      }

      if (data.removedQueuedRedraws > 0) {
        addLog(`🗑️ ${data.message}，并已取消 ${data.removedQueuedRedraws} 个待执行重绘任务。`);
      } else {
        addLog(`🗑️ ${data.message}`);
      }
      if (sceneEditor?.chapterKey === chapKey && sceneEditor?.sceneIdx === sceneIdx) {
        closeSceneEditor();
      }
      setExpandedPrompt(prev => (prev === sceneKey ? null : prev));
      setLoadingScenes({});
      await fetchProjectDetails(activeProject);
    } catch (e) {
      setLoadingScenes(prev => {
        const copy = { ...prev };
        delete copy[sceneKey];
        return copy;
      });
      addLog(`❌ 删除场景 #${sceneIdx} 异常: ${e.message}`, "error");
    }
  };

  const regenerateScene = async (chap, sceneIdx) => {
    if (!activeProject || !chap) return;
    const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
    const sceneKey = `${chapKey}_${sceneIdx}`;

    try {
      setLoadingScenes(prev => ({ ...prev, [sceneKey]: true }));
      addLog(`🧠 正在请求大模型重构场景 #${sceneIdx} 的画面描述并重绘...`);
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapKey)}/scenes/${sceneIdx}/regenerate`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!data.success) {
        setLoadingScenes(prev => {
          const copy = { ...prev };
          delete copy[sceneKey];
          return copy;
        });
        addLog(`❌ 重构场景 #${sceneIdx} 失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      setLoadingScenes(prev => {
        const copy = { ...prev };
        delete copy[sceneKey];
        return copy;
      });
      addLog(`❌ 重构场景 #${sceneIdx} 异常: ${e.message}`, "error");
    }
  };

  const startPipeline = async () => {
    if (!activeProject) return;
    try {
      setPipelineRunning(true);
      addLog("🚀 流水线启动中...");
      const res = await fetch(`${API_BASE}/api/projects/${activeProject}/pipeline/start`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      }
    } catch (e) {
      setPipelineRunning(false);
      addLog("流水线启动失败: " + e.message, "error");
    }
  };

  const stopPipeline = async () => {
    if (!activeProject) return;
    try {
      addLog("⏹️ 正在发送停止指令并执行硬刹车...");
      setPipelineRunning(false);
      const res = await fetch(`${API_BASE}/api/projects/${activeProject}/pipeline/stop`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      }
      fetchStatus(activeProject);
      fetchProjectDetails(activeProject);
    } catch (e) {
      addLog("暂停流水线异常: " + e.message, "error");
    }
  };

  const exportEPUB = async () => {
    if (!activeProject) return;
    try {
      addLog("📚 正在构建高排版水准的 EPUB 电子书，打包高清插图中...");
      const res = await fetch(`${API_BASE}/api/projects/${activeProject}/build-epub`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.success) {
        addLog(`🎉 EPUB 电子书编译打包大功告成！正在为您触发下载...`);
        // 触发下载
        window.open(`${API_BASE}${data.downloadUrl}`);
      }
    } catch (e) {
      addLog("EPUB 构建失败: " + e.message, "error");
    }
  };

  // 进度计算
  const getProgress = () => {
    if (!projectDetails || !projectDetails.chapters) return { ratio: 0, completed: 0, total: 0 };
    const total = projectDetails.chapters.length;
    const completed = Object.values(projectDetails.progress?.completed_chapters || {})
      .filter(chap => chap.status === 'completed').length;
    return {
      ratio: total > 0 ? (completed / total) * 100 : 0,
      completed,
      total
    };
  };

  const getChapterProgress = (volume, chapter) => {
    if (!projectDetails || !projectDetails.progress || !projectDetails.progress.completed_chapters) return null;
    const completed = projectDetails.progress.completed_chapters;
    const standardKey = `${volume}_${chapter}`.replace(/\s+/g, '_');
    const targetNorm = standardKey.replace(/[\s_]+/g, '').toLowerCase();
    for (const [key, val] of Object.entries(completed)) {
      if (key.replace(/[\s_]+/g, '').toLowerCase() === targetNorm) {
        return val;
      }
    }
    return completed[standardKey]; // 兜底直接取
  };

  const progressInfo = getProgress();
  const readyScenesCount = getReadyScenesCount();
  const characters = projectDetails?.progress?.global_characters || {};
  const characterDnaVersions = projectDetails?.progress?.character_dna_versions || {};
  const dnaFeatureOrder = [
    '外貌标签',
    '年龄标签',
    '身材标签',
    '胸部标签',
    'NSFW标签',
    '发型标签',
    '发色标签',
    '眼睛标签',
    '肤色标签',
    '服装基底标签',
    '特殊特征标签'
  ];

  const emptyCharacterFeatures = () => Object.fromEntries(dnaFeatureOrder.map(key => [key, '']));

  const normalizeFeatureText = (value) => (
    Array.isArray(value) ? value.join(', ') : String(value || '')
  );

  const featuresToEditorState = (features = {}) => (
    dnaFeatureOrder.reduce((acc, key) => {
      let val = features?.[key];
      if (key === '年龄标签' && (val === undefined || val === null || (Array.isArray(val) && val.length === 0) || val === '')) {
        val = features?.['年龄感标签'] || 'adult';
      }
      acc[key] = normalizeFeatureText(val);
      return acc;
    }, emptyCharacterFeatures())
  );

  const emptyProxyCharacterState = () => ({
    danbooru_tag: '',
    character_name_cn: '',
    series: '',
    reason: '',
    suppress_tags: ''
  });

  const proxyToEditorState = (proxy = null) => {
    if (!proxy) return emptyProxyCharacterState();
    return {
      danbooru_tag: proxy.danbooru_tag || '',
      character_name_cn: proxy.character_name_cn || '',
      series: proxy.series || '',
      reason: proxy.reason || '',
      suppress_tags: Array.isArray(proxy.suppress_tags)
        ? proxy.suppress_tags.join(', ')
        : String(proxy.suppress_tags || '')
    };
  };
  const sceneEditorLabelStyle = {
    display: 'grid',
    gap: '6px',
    fontSize: '0.78rem',
    color: 'var(--text-secondary)'
  };
  const sceneEditorInputStyle = {
    width: '100%',
    background: 'rgba(7, 10, 24, 0.72)',
    color: '#eef2ff',
    border: '1px solid rgba(148, 163, 184, 0.22)',
    borderRadius: '10px',
    padding: '10px 12px',
    outline: 'none',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
    fontSize: '0.92rem'
  };
  const sceneEditorTextareaStyle = {
    ...sceneEditorInputStyle,
    resize: 'vertical',
    lineHeight: 1.55,
    minHeight: '72px'
  };
  const sceneEditorSectionStyle = {
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: '12px',
    padding: '14px',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.01))',
    display: 'grid',
    gap: '12px'
  };

  const splitSceneList = (value) => (
    String(value || '')
      .split(/[\n,，]+/)
      .map(item => item.trim())
      .filter(Boolean)
  );

  const getNonEmptyPromptList = (...candidates) => {
    const selected = candidates.find(candidate => (
      Array.isArray(candidate) && candidate.some(item => String(item || '').trim())
    ));
    return selected || [];
  };

  const buildSceneEditorDraft = (scene = {}) => {
    const characterNamesText = Array.isArray(scene.character_names) ? scene.character_names.join(', ') : '';
    const normalizedCharacters = Array.isArray(scene.characters)
      ? scene.characters.map(char => ({
          name: String(char?.name || ''),
          gender: String(char?.gender || 'unknown'),
          appearance: String(char?.appearance || ''),
          clothing: String(char?.clothing || ''),
          expression: String(char?.expression || ''),
          pose: String(char?.pose || ''),
          position: String(char?.position || '')
        }))
      : [];
    const syncedCharacters = syncSceneCharactersFromNames(characterNamesText, normalizedCharacters, characters);
    const promptInteractionSeed = Array.isArray(scene.character_prompt_interactions || scene.prepared_prompt?.characterPromptInteractions)
      ? (scene.character_prompt_interactions || scene.prepared_prompt?.characterPromptInteractions).map(item => ({
          name: String(item?.name || '').trim(),
          interactions: normalizeSceneCharacterInteractionList(item)
        }))
      : [];

    const characterPromptInteractions = syncSceneCharacterInteractions(syncedCharacters, [], promptInteractionSeed);
    const finalCharacterPrompts = getNonEmptyPromptList(
      scene.character_prompts,
      scene.prepared_prompt?.characterPrompts
    ).map(prompt => String(prompt || '').trim()).filter(Boolean).join('\n');

    return {
      trigger_sentence: String(scene.trigger_sentence || ''),
      nsfw_rating: String(scene.nsfw_rating || 'sfw'),
      sex_position: String(scene.sex_position || ''),
      visual_description: String(scene.visual_description || scene.scene_desc || ''),
      core_action: String(scene.core_action || ''),
      environment: String(scene.environment || ''),
      cinematography: String(scene.cinematography || ''),
      interactions: String(scene.interactions || ''),
      plot_traces: String(scene.plot_traces || ''),
      text_elements: String(scene.text_elements || ''),
      character_names: characterNamesText,
      must_show: Array.isArray(scene.must_show) ? scene.must_show.join(', ') : '',
      must_not_show: Array.isArray(scene.must_not_show) ? scene.must_not_show.join(', ') : '',
      base_prompt: String(scene.base_prompt || scene.prepared_prompt?.basePrompt || ''),
      character_prompts: finalCharacterPrompts,
      final_negative: String(scene.final_negative || scene.prepared_prompt?.finalNegative || ''),
      negative_character_prompts: getNonEmptyPromptList(
        scene.negative_character_prompts,
        scene.prepared_prompt?.negativeCharacterPrompts
      ).join('\n'),
      width: scene.width || scene.prepared_prompt?.width || '',
      height: scene.height || scene.prepared_prompt?.height || '',
      characters: syncedCharacters,
      character_prompt_interactions: characterPromptInteractions,
      visual_entities: Array.isArray(scene.visual_entities)
        ? scene.visual_entities.map(entity => ({
            type: String(entity?.type || 'object'),
            description: String(entity?.description || ''),
            count: entity?.count || 1,
            position: String(entity?.position || ''),
            must_show: entity?.must_show !== false
          }))
        : []
    };
  };

  const openSceneEditor = (chapterKey, scene) => {
    setExpandedSceneCharacterDetails({});
    setSceneEditor({
      chapterKey,
      sceneIdx: scene.scene_idx,
      imagePath: scene.image_path || '',
      status: scene.status || '',
      draft: buildSceneEditorDraft(scene)
    });
    setSceneEditorDirty(false);
  };

  const closeSceneEditor = () => {
    setSceneEditor(null);
    setSceneEditorDirty(false);
    setSavingScene(false);
    setExpandedSceneCharacterDetails({});
  };

  const updateSceneDraft = (updater) => {
    setSceneEditor(prev => {
      if (!prev) return prev;
      const nextDraft = typeof updater === 'function' ? updater(prev.draft) : updater;
      return { ...prev, draft: nextDraft };
    });
    setSceneEditorDirty(true);
  };

  const serializeSceneDraft = (draft = {}) => ({
    trigger_sentence: String(draft.trigger_sentence || '').trim(),
    nsfw_rating: String(draft.nsfw_rating || 'sfw').trim() || 'sfw',
    sex_position: String(draft.sex_position || '').trim(),
    visual_description: String(draft.visual_description || '').trim(),
    core_action: String(draft.core_action || '').trim(),
    environment: String(draft.environment || '').trim(),
    cinematography: String(draft.cinematography || '').trim(),
    interactions: String(draft.interactions || '').trim(),
    plot_traces: String(draft.plot_traces || '').trim(),
    text_elements: String(draft.text_elements || '').trim(),
    character_names: splitSceneList(draft.character_names),
    must_show: splitSceneList(draft.must_show),
    must_not_show: splitSceneList(draft.must_not_show),
    base_prompt: String(draft.base_prompt || '').trim(),
    character_prompts: String(draft.character_prompts || '')
      .split(/\r?\n/)
      .map(item => String(item || '').trim())
      .filter(Boolean),
    final_negative: String(draft.final_negative || '').trim(),
    character_prompt_interactions: (Array.isArray(draft.characters) ? draft.characters : []).map((char, index) => {
      const interactions = normalizeSceneCharacterInteractionList(draft.character_prompt_interactions?.[index]);
      if (interactions.length === 0) return null;
      return {
        name: String(char?.name || '').trim(),
        interactions
      };
    }),
    negative_character_prompts: String(draft.negative_character_prompts || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean),
    width: draft.width === '' ? null : Number(draft.width),
    height: draft.height === '' ? null : Number(draft.height),
    characters: (Array.isArray(draft.characters) ? draft.characters : [])
      .map(char => ({
        name: String(char?.name || '').trim(),
        gender: String(char?.gender || 'unknown').trim() || 'unknown',
        appearance: String(char?.appearance || '').trim(),
        clothing: String(char?.clothing || '').trim(),
        expression: String(char?.expression || '').trim(),
        pose: String(char?.pose || '').trim(),
        position: String(char?.position || '').trim()
      }))
      .filter(char => Object.values(char).some(value => String(value || '').trim())),
    visual_entities: (Array.isArray(draft.visual_entities) ? draft.visual_entities : [])
      .map(entity => ({
        type: String(entity?.type || 'object').trim() || 'object',
        description: String(entity?.description || '').trim(),
        count: Math.max(1, Number(entity?.count) || 1),
        position: String(entity?.position || '').trim(),
        must_show: entity?.must_show !== false
      }))
      .filter(entity => entity.description),
    preserveDerived: true
  });

  const saveSceneEditor = async () => {
    if (!sceneEditor || !activeProject) return;
    try {
      setSavingScene(true);
      const response = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(sceneEditor.chapterKey)}/scenes/${sceneEditor.sceneIdx}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(serializeSceneDraft(sceneEditor.draft))
        }
      );
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存场景失败');
      }
      addLog(`💾 场景 #${sceneEditor.sceneIdx} 已保存。`, 'success');
      setSceneEditor(prev => prev ? {
        ...prev,
        imagePath: data.scene?.image_path || '',
        status: data.scene?.status || '',
        draft: buildSceneEditorDraft(data.scene || {})
      } : prev);
      setSceneEditorDirty(false);
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 保存场景失败: ${error.message}`, 'error');
    } finally {
      setSavingScene(false);
    }
  };

  const startInlineEditScene = (chapterKey, scene) => {
    const sceneKey = `${chapterKey}_${scene.scene_idx}`;
    setInlineEditingSceneKey(sceneKey);
    setInlineSceneDraft(buildSceneEditorDraft(scene));
  };

  const cancelInlineEditScene = () => {
    setInlineEditingSceneKey(null);
    setInlineSceneDraft(null);
    setSavingInlineScene(false);
  };

  const updateInlineDraft = (updater) => {
    setInlineSceneDraft(prev => {
      if (!prev) return prev;
      return typeof updater === 'function' ? updater(prev) : updater;
    });
  };

  const saveInlineSceneEditor = async (chapterKey, sceneIdx) => {
    if (!inlineSceneDraft || !activeProject) return;
    try {
      setSavingInlineScene(true);
      const payload = {
        ...serializeSceneDraft(inlineSceneDraft),
        preserveDerived: true
      };
      const response = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapterKey)}/scenes/${sceneIdx}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || '保存场景失败');
      }
      addLog(`💾 场景 #${sceneIdx} 结构化信息已保存。`, 'success');
      setInlineEditingSceneKey(null);
      setInlineSceneDraft(null);
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 保存场景失败: ${error.message}`, 'error');
    } finally {
      setSavingInlineScene(false);
    }
  };

  const quickUpdateSceneField = async (chapterKey, sceneIdx, updates, label) => {
    if (!activeProject) return;
    const sceneKey = `${chapterKey}_${sceneIdx}`;
    try {
      setQuickUpdatingSceneKey(sceneKey);
      const payload = {
        ...updates,
        preserveDerived: true
      };
      const response = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapterKey)}/scenes/${sceneIdx}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `更新场景 ${label || ''} 失败`);
      }
      addLog(`✨ 场景 #${sceneIdx} ${label || '属性'} 已更新。`, 'success');
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 更新场景失败: ${error.message}`, 'error');
    } finally {
      setQuickUpdatingSceneKey(null);
    }
  };

  const editorStateToFeatures = (state = {}) => (
    dnaFeatureOrder.reduce((acc, key) => {
      const raw = String(state?.[key] || '');
      acc[key] = raw
        .split(/[,，]/)
        .map(item => item.trim())
        .filter(Boolean);
      return acc;
    }, {})
  );

  const renderDnaFeatures = (features) => {
    if (!features || typeof features !== 'object') return null;
    const entries = dnaFeatureOrder
      .map(key => {
        let tags = Array.isArray(features[key]) ? features[key].filter(Boolean) : [];
        if (key === '年龄标签' && tags.length === 0) {
          tags = Array.isArray(features['年龄感标签'])
            ? features['年龄感标签'].filter(Boolean)
            : (features['年龄标签'] ? [String(features['年龄标签'])] : ['adult']);
        }
        return [key, tags];
      })
      .filter(([, tags]) => tags.length > 0);
    if (entries.length === 0) return null;

    return (
      <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {entries.map(([label, tags]) => (
          <div key={label} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <div style={{
              flex: '0 0 82px',
              fontSize: '0.72rem',
              color: 'var(--text-muted)',
              lineHeight: '1.4',
              paddingTop: '2px'
            }}>
              {label}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', minWidth: 0 }}>
              {tags.map(tag => (
                <span key={`${label}-${tag}`} className="tag-badge dna">{tag}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderSceneLegacySummary = (scene = {}) => {
    const sceneCharacters = Array.isArray(scene.characters) ? scene.characters : [];
    const summaryRows = [
      ['核心动作', scene.core_action],
      ['环境', scene.environment],
      ['镜头', scene.cinematography],
      ['互动', scene.interactions],
      ['痕迹', scene.plot_traces],
      ['文字', scene.text_elements],
      ['角色', sceneCharacters.map(char => char?.name).filter(Boolean).join('、') || (Array.isArray(scene.character_names) ? scene.character_names.join('、') : '')],
      ['必含', Array.isArray(scene.must_show) ? scene.must_show.join(', ') : ''],
      ['避开', Array.isArray(scene.must_not_show) ? scene.must_not_show.join(', ') : '']
    ].filter(([, value]) => String(value || '').trim());

    if (summaryRows.length === 0) return null;

    return (
      <div style={{
        marginTop: '10px',
        display: 'grid',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '10px',
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.06)'
      }}>
        {summaryRows.slice(0, 5).map(([label, value]) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '44px 1fr', gap: '8px', alignItems: 'start' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{label}</span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5, wordBreak: 'break-word' }}>{value}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderFeatureEditor = () => {
    if (!editingCharacterFeatures) return null;
    return (
      <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {dnaFeatureOrder.map(label => (
          <label key={label} style={{ display: 'grid', gridTemplateColumns: '82px 1fr', gap: '8px', alignItems: 'start' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: '1.4', paddingTop: '8px' }}>{label}</span>
            <textarea
              value={editingCharacterFeatures[label] || ''}
              onChange={(e) => setEditingCharacterFeatures(prev => ({
                ...(prev || emptyCharacterFeatures()),
                [label]: e.target.value
              }))}
              rows={2}
              spellCheck={false}
              placeholder={label === '年龄标签' ? '知道几岁写确定的岁数(如 18yo, 20yo)，不知道写 adult (默认 adult)' : '用逗号分隔'}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(168,85,247,0.35)',
                borderRadius: '6px',
                padding: '8px',
                color: 'white',
                fontFamily: 'monospace',
                fontSize: '0.78rem',
                lineHeight: '1.4',
                resize: 'vertical'
              }}
            />
          </label>
        ))}
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          每个字段输入逗号分隔的结构化视觉短语。保存后会自动重建基础外貌短语。
        </div>

        {/* 同人动漫脸模代理编辑器 */}
        <div style={{
          marginTop: '10px',
          padding: '10px',
          borderRadius: '8px',
          background: 'rgba(236, 72, 153, 0.05)',
          border: '1px solid rgba(236, 72, 153, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.76rem', fontWeight: 600, color: '#f472b6' }}>
              🎭 同人动漫脸模代理 (Proxy Character Anchor)
            </span>
            {editingProxyCharacter?.danbooru_tag && (
              <button
                type="button"
                className="btn-secondary"
                style={{ padding: '2px 6px', fontSize: '0.68rem', color: '#fda4af' }}
                onClick={() => setEditingProxyCharacter(emptyProxyCharacterState())}
              >
                清除脸模
              </button>
            )}
          </div>
          <div style={{ fontSize: '0.70rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
            绑定 Danbooru 知名动漫同人角色作为脸模骨相，生图时自动置于角色 prompt 前缀；原著服装自动置入反向提示词防止污染。
          </div>
          <label style={{ display: 'grid', gridTemplateColumns: '82px 1fr', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Danbooru Tag</span>
            <input
              type="text"
              value={editingProxyCharacter?.danbooru_tag || ''}
              onChange={(e) => setEditingProxyCharacter(prev => ({ ...(prev || emptyProxyCharacterState()), danbooru_tag: e.target.value }))}
              placeholder="如 kasugano_sora, asuka_langley_soryu"
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(236, 72, 153, 0.35)',
                borderRadius: '6px',
                padding: '6px 8px',
                color: 'white',
                fontFamily: 'monospace',
                fontSize: '0.78rem'
              }}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <label style={{ display: 'grid', gridTemplateColumns: '82px 1fr', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>中文名</span>
              <input
                type="text"
                value={editingProxyCharacter?.character_name_cn || ''}
                onChange={(e) => setEditingProxyCharacter(prev => ({ ...(prev || emptyProxyCharacterState()), character_name_cn: e.target.value }))}
                placeholder="如 春日野穹"
                style={{
                  width: '100%',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '6px',
                  padding: '6px 8px',
                  color: 'white',
                  fontSize: '0.78rem'
                }}
              />
            </label>
            <label style={{ display: 'grid', gridTemplateColumns: '60px 1fr', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>出处作品</span>
              <input
                type="text"
                value={editingProxyCharacter?.series || ''}
                onChange={(e) => setEditingProxyCharacter(prev => ({ ...(prev || emptyProxyCharacterState()), series: e.target.value }))}
                placeholder="如 缘之空 / EVA"
                style={{
                  width: '100%',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '6px',
                  padding: '6px 8px',
                  color: 'white',
                  fontSize: '0.78rem'
                }}
              />
            </label>
          </div>
          <label style={{ display: 'grid', gridTemplateColumns: '82px 1fr', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>压制原著服饰</span>
            <input
              type="text"
              value={editingProxyCharacter?.suppress_tags || ''}
              onChange={(e) => setEditingProxyCharacter(prev => ({ ...(prev || emptyProxyCharacterState()), suppress_tags: e.target.value }))}
              placeholder="逗号分隔，如 black_dress, hair_ornament, plugsuit"
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(244, 63, 94, 0.35)',
                borderRadius: '6px',
                padding: '6px 8px',
                color: 'white',
                fontFamily: 'monospace',
                fontSize: '0.78rem'
              }}
            />
          </label>
          <label style={{ display: 'grid', gridTemplateColumns: '82px 1fr', gap: '8px', alignItems: 'start' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', paddingTop: '6px' }}>匹配理由</span>
            <textarea
              rows={2}
              value={editingProxyCharacter?.reason || ''}
              onChange={(e) => setEditingProxyCharacter(prev => ({ ...(prev || emptyProxyCharacterState()), reason: e.target.value }))}
              placeholder="说明匹配该动漫角色的理由（如五官清秀、银白长发、病娇柔弱神态等）"
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '6px',
                padding: '6px 8px',
                color: 'white',
                fontSize: '0.78rem',
                resize: 'vertical'
              }}
            />
          </label>
        </div>
      </div>
    );
  };

  const renderTaskLlmCard = (scope, title, description, accent) => {
    const fields = llmTaskFields[scope];
    const models = availableModels[scope] || [];
    const taskPresetId = config[fields.presetId] || "";
    return (
      <section className="llm-task-card" style={{ '--task-accent': accent }}>
        <div className="llm-task-card__header">
          <div>
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
          <button type="button" className="btn-secondary llm-copy-button" onClick={() => copyDefaultLlmToTask(scope)}>
            <Copy size={13} /> 带入默认连接
          </button>
        </div>
        <div className="llm-task-grid">
          <label>
            <span>绑定 API 预设</span>
            <select
              value={taskPresetId}
              onChange={(e) => {
                const presetId = e.target.value;
                if (!presetId) {
                  setConfig({ ...config, [fields.presetId]: "" });
                  return;
                }
                bindPresetToScope(scope, presetId);
              }}
            >
              <option value="">继承默认连接</option>
              {(config.llm_api_presets || []).map(rawPreset => {
                const preset = normalizePreset(rawPreset);
                return (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.rateLimitEnabled !== false ? `${preset.rateLimitRpm || 3} RPM` : '不限流'})
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            <span>Base URL</span>
            <input
              type="text"
              value={config[fields.url] || ""}
              onChange={(e) => setConfig({ ...config, [fields.presetId]: "", [fields.url]: e.target.value })}
              placeholder={config.llm_url || "留空时使用默认 URL"}
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={config[fields.key] || ""}
              onChange={(e) => setConfig({ ...config, [fields.presetId]: "", [fields.key]: e.target.value })}
              placeholder={config.llm_key ? "留空时使用默认 Key" : "输入 API Key"}
            />
          </label>
          <label className="llm-task-model">
            <span>Model</span>
            <div className="llm-model-row">
                <input
                  type="text"
                  list={`llm-models-${scope}`}
                  value={config[fields.model] || ""}
                  onChange={(e) => setConfig({ ...config, [fields.presetId]: "", [fields.model]: e.target.value })}
                  placeholder={config.llm_model || "留空时使用默认模型"}
                />
              <button type="button" className="btn-secondary" onClick={() => fetchModels(scope)} disabled={isLoadingModels[scope]}>
                <RefreshCw size={12} className={isLoadingModels[scope] ? "animate-spin" : ""} />
                {isLoadingModels[scope] ? "获取中" : "模型"}
              </button>
            </div>
            <datalist id={`llm-models-${scope}`}>
              {models.map(model => <option key={model} value={model} />)}
            </datalist>
            {modelError[scope] && <small className="llm-model-error">{modelError[scope]}</small>}
          </label>
        </div>
      </section>
    );
  };

  const captureTextSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim();
    if (!selection || selection.rangeCount === 0 || !text) return;

    const range = selection.getRangeAt(0);
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer
      : range.endContainer.parentElement;
    const paragraphElement = endElement?.closest?.('[data-paragraph-index]');
    const paragraphIndex = Number(paragraphElement?.dataset?.paragraphIndex);
    const paragraph = chapterContent?.paragraphs?.[paragraphIndex];
    if (!paragraph || !Number.isInteger(paragraphIndex)) return;

    setTextSelections(prev => {
      if (prev.some(item => item.paragraphIndex === paragraphIndex && item.text === text)) return prev;
      const next = [...prev, { paragraphIndex, paragraph, text }];
      if (activeProject && selectedChapter) {
        const chapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
        saveReaderSelections(activeProject, chapterKey, next);
      }
      return next;
    });
    selection.removeAllRanges();
  };

  const generateSelectedParagraphs = async () => {
    if (!activeProject || !selectedChapter || !chapterContent || textSelections.length === 0) return;
    const chapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
    const selections = [...textSelections].sort((a, b) => a.paragraphIndex - b.paragraphIndex);
    setIsSubmittingSelections(true);
    setPipelineRunning(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/chapters/${encodeURIComponent(chapterKey)}/selected-scenes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selections })
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '提交失败');
      addLog(`📝 ${data.message}`);
      setTextSelections([]);
      if (activeProject && selectedChapter) {
        const chapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
        saveReaderSelections(activeProject, chapterKey, []);
      }
      setWorkspaceTab('scenes');
    } catch (error) {
      setPipelineRunning(false);
      addLog(`正文选段生图失败: ${error.message}`, 'error');
    } finally {
      setIsSubmittingSelections(false);
    }
  };

  const startEditingCharacterTags = (name) => {
    setEditingCharacterName(name);
    const character = characters[name] || {};
    setEditingCharacterFeatures(featuresToEditorState(character.features || {}));
    setEditingProxyCharacter(proxyToEditorState(character.proxy_character));
  };

  const cancelEditingCharacterTags = () => {
    setEditingCharacterName("");
    setEditingCharacterFeatures(null);
    setEditingProxyCharacter(null);
  };

  const saveEditingCharacterTags = async () => {
    if (!activeProject || !editingCharacterName) return;
    setSavingCharacterTags(true);
    try {
      const proxyPayload = editingProxyCharacter && editingProxyCharacter.danbooru_tag?.trim() ? {
        danbooru_tag: editingProxyCharacter.danbooru_tag.trim().toLowerCase().replace(/\s+/g, '_'),
        character_name_cn: editingProxyCharacter.character_name_cn?.trim() || '',
        series: editingProxyCharacter.series?.trim() || '',
        reason: editingProxyCharacter.reason?.trim() || '',
        suppress_tags: String(editingProxyCharacter.suppress_tags || '')
          .split(/[,，]/)
          .map(t => t.trim().toLowerCase().replace(/\s+/g, '_'))
          .filter(Boolean)
      } : null;

      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/characters/${encodeURIComponent(editingCharacterName)}/features`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            features: editorStateToFeatures(editingCharacterFeatures),
            proxy_character: proxyPayload
          })
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '保存失败');
      addLog(`🧬 角色「${editingCharacterName}」结构化 DNA 及同人脸模已更新。`);
      cancelEditingCharacterTags();
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 保存角色结构化 DNA 失败: ${error.message}`, 'error');
    } finally {
      setSavingCharacterTags(false);
    }
  };

  const saveAppearanceVersion = async () => {
    if (!activeProject || !editingAppearanceVersion) return;
    const { characterName, id, startChapterIndex, tags } = editingAppearanceVersion;
    setSavingAppearanceVersion(true);
    try {
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/characters/${encodeURIComponent(characterName)}/dna-versions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startChapterIndex: Number(startChapterIndex), tags })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '保存失败');
      addLog(`🧬 已更新角色「${characterName}」的外观版本。`);
      setEditingAppearanceVersion(null);
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 保存外观版本失败: ${error.message}`, 'error');
    } finally {
      setSavingAppearanceVersion(false);
    }
  };

  const deleteAppearanceVersion = async (characterName, id) => {
    if (!activeProject) return;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/characters/${encodeURIComponent(characterName)}/dna-versions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '删除失败');
      addLog(`🧬 已删除角色「${characterName}」的外观版本。`);
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 删除外观版本失败: ${error.message}`, 'error');
    }
  };


  const renderBooksTab = () => (
    <div className="books-tab-view">
      <div className="tab-view-header">
        <div>
          <h2><BookOpen size={22} /> 书籍项目库</h2>
          <p className="tab-view-subtitle">共 {projects.length} 部小说项目，点击进入创作工作台</p>
        </div>
        <button className="btn-primary" onClick={() => setIsNewProjectOpen(true)}>
          <Plus size={16} /> 导入新书籍
        </button>
      </div>

      <div className="books-grid">
        <div className="book-card-item create-card glass-panel" onClick={() => setIsNewProjectOpen(true)}>
          <div className="create-card-content">
            <div className="create-icon-wrapper">
              <Plus size={26} />
            </div>
            <div style={{ fontWeight: 600, fontSize: '1rem', marginTop: '12px' }}>导入新小说</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px' }}>支持 TXT 格式全本章节解析</div>
          </div>
        </div>

        {projects.map(proj => {
          const isActive = activeProject === proj.name;
          return (
            <div
              key={proj.name}
              className={`book-card-item glass-panel ${isActive ? 'active' : ''}`}
              onClick={() => selectProject(proj.name, true)}
            >
              <div className="book-card-top">
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div className="book-title" title={proj.name}>{proj.name}</div>
                  <button
                    className="btn-secondary book-delete-btn"
                    title="删除项目"
                    onClick={(e) => requestDeleteProject(proj, e)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="book-meta">
                  <span>📅 创建于 {new Date(proj.createdAt).toLocaleDateString()}</span>
                  {isActive && projectDetails && (
                    <span className="book-badge chapters-count">
                      {projectDetails.chapters?.length || 0} 章节
                    </span>
                  )}
                </div>
              </div>

              {isActive && (
                <div className="book-card-middle">
                  <div className="book-progress-info">
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>处理进度</span>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-blue)' }}>
                      {progressInfo.completed} / {progressInfo.total} 章
                    </span>
                  </div>
                  <div className="book-progress-bar">
                    <div
                      className="book-progress-fill"
                      style={{
                        width: `${progressInfo.total > 0 ? (progressInfo.completed / progressInfo.total) * 100 : 0}%`
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="book-card-bottom" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn-primary"
                  style={{ flex: 1, padding: '7px 12px', fontSize: '0.8rem', justifyContent: 'center' }}
                  onClick={() => selectProject(proj.name, true)}
                >
                  <Clapperboard size={14} /> 进入工作台
                </button>
                <button
                  className="btn-secondary"
                  style={{ padding: '7px 12px', fontSize: '0.8rem' }}
                  onClick={async () => {
                    await selectProject(proj.name, false);
                    setMainTab('dna');
                  }}
                  title="查看角色 DNA"
                >
                  <User size={14} /> DNA
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );


  const renderDnaTab = () => {
    if (!activeProject) {
      return (
        <div className="empty-state-container">
          <BookOpen size={48} style={{ opacity: 0.3, marginBottom: '12px' }} />
          <h3>请先在「书籍项目」中选择一部小说</h3>
          <p>选择小说后即可查看并提取该书的人物 DNA 词典与同人脸模</p>
          <button className="btn-primary" style={{ marginTop: '16px' }} onClick={() => setMainTab('books')}>
            去选择书籍
          </button>
        </div>
      );
    }

    const charEntries = Object.entries(characters);
    const activeDnaChar = characters[selectedDnaCharacter] ? selectedDnaCharacter : (charEntries[0]?.[0] || "");
    const charData = characters[activeDnaChar] || null;

    const filteredEntries = charEntries.filter(([name, data]) => {
      if (!dnaSearchQuery) return true;
      const q = dnaSearchQuery.toLowerCase();
      return name.toLowerCase().includes(q)
        || (data.aliases || []).some(a => a.toLowerCase().includes(q))
        || (data.proxy_character?.danbooru_tag || '').toLowerCase().includes(q)
        || (data.proxy_character?.character_name_cn || '').toLowerCase().includes(q);
    });

    return (
      <div className="dna-tab-view">
        {/* 左栏：角色列表导航 */}
        <div className="dna-sidebar-panel glass-panel">
          <div className="dna-sidebar-header">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <User size={16} /> 角色列表 ({charEntries.length})
              </div>
              <button
                className="btn-secondary"
                style={{ padding: '4px 8px', fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={startExtractCharacters}
                disabled={isExtractingDna || pipelineRunning}
                title="智能提取/重建当前章节组的角色 DNA"
              >
                <RefreshCw size={12} className={isExtractingDna ? "animate-spin" : ""} />
                {isExtractingDna ? '提炼中...' : '重建本组'}
              </button>
            </div>
            {isExtractingDna && (
              <div style={{
                padding: '6px 10px',
                marginTop: '8px',
                borderRadius: '6px',
                background: 'rgba(99, 102, 241, 0.12)',
                border: '1px solid rgba(99, 102, 241, 0.3)',
                fontSize: '0.73rem',
                color: '#a5b4fc',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px'
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <RefreshCw size={11} className="animate-spin" />
                  <span>正在提炼角色 DNA...</span>
                </span>
                <button
                  type="button"
                  style={{ fontSize: '0.72rem', color: '#818cf8', textDecoration: 'underline', padding: 0, cursor: 'pointer', border: 'none', background: 'transparent' }}
                  onClick={() => setIsLogsOpen(true)}
                >
                  实时日志 ➔
                </button>
              </div>
            )}
            <input
              type="text"
              placeholder="搜索角色名/别名/脸模..."
              value={dnaSearchQuery}
              onChange={(e) => setDnaSearchQuery(e.target.value)}
              className="dna-search-input"
            />
          </div>

          <div className="dna-char-list">
            {charEntries.length === 0 ? (
              <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                暂未提取角色 DNA<br />点击右上角「重建本组」提取
              </div>
            ) : filteredEntries.length === 0 ? (
              <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                未找到匹配的角色
              </div>
            ) : (
              filteredEntries.map(([name, data]) => {
                const isSelected = activeDnaChar === name;
                return (
                  <div
                    key={name}
                    className={`dna-char-item ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedDnaCharacter(name)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.88rem', color: isSelected ? 'white' : 'var(--text-primary)' }}>
                        {name}
                      </span>
                      {data.gender && (
                        <span className="tag-badge scene" style={{ fontSize: '0.66rem', padding: '1px 5px' }}>
                          {data.gender}
                        </span>
                      )}
                    </div>
                    {data.proxy_character?.danbooru_tag && (
                      <div style={{ fontSize: '0.7rem', color: '#f472b6', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span>🎭 {data.proxy_character.danbooru_tag}</span>
                        {data.proxy_character.character_name_cn ? `(${data.proxy_character.character_name_cn})` : ''}
                      </div>
                    )}
                    {(data.aliases?.length > 0) && (
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        别名: {data.aliases.join(' / ')}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右栏：角色详情展示与深度编辑器 */}
        <div className="dna-detail-viewport glass-panel">
          {charData ? (
            <div style={{ padding: '20px' }}>
              {/* 顶部标题栏与编辑按钮 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '14px', marginBottom: '16px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h2 style={{ fontSize: '1.4rem', color: 'var(--color-pink)' }}>{activeDnaChar}</h2>
                    {charData.gender && <span className="tag-badge scene">{charData.gender}</span>}
                    {charData.role_type && <span className="tag-badge dna">{charData.role_type}</span>}
                  </div>
                  {(charData.aliases?.length > 0 || charData.confidence || charData.source_chapters?.length > 0) && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                      {charData.aliases?.length > 0 ? `别名: ${charData.aliases.join(' / ')}` : ''}
                      {charData.confidence ? ` · 置信度: ${Number(charData.confidence).toFixed(2)}` : ''}
                      {charData.source_chapters?.length > 0 ? ` · 来源: ${charData.source_chapters.join(' / ')}` : ''}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  {editingCharacterName === activeDnaChar ? (
                    <>
                      <button className="btn-primary" onClick={saveEditingCharacterTags} disabled={savingCharacterTags} style={{ padding: '6px 14px', fontSize: '0.8rem' }}>
                        {savingCharacterTags ? '保存中...' : '保存修改'}
                      </button>
                      <button className="btn-secondary" onClick={cancelEditingCharacterTags} disabled={savingCharacterTags} style={{ padding: '6px 14px', fontSize: '0.8rem' }}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button className="btn-secondary" onClick={() => startEditingCharacterTags(activeDnaChar)} style={{ padding: '6px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Pencil size={13} /> 编辑人设与脸模
                    </button>
                  )}
                </div>
              </div>

              {/* 编辑态 vs 非编辑态 */}
              {editingCharacterName === activeDnaChar ? (
                renderFeatureEditor()
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* 同人脸模大卡片 */}
                  {charData.proxy_character?.danbooru_tag ? (
                    <div style={{
                      padding: '14px 16px',
                      borderRadius: '10px',
                      background: 'rgba(236, 72, 153, 0.08)',
                      border: '1px solid rgba(236, 72, 153, 0.3)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.92rem', color: '#f472b6', fontWeight: 600 }}>
                          <span>🎭 同人动漫脸模代理</span>
                          <span style={{ fontFamily: 'monospace', background: 'rgba(236, 72, 153, 0.2)', padding: '2px 8px', borderRadius: '5px' }}>
                            {charData.proxy_character.danbooru_tag}
                          </span>
                        </div>
                        {(charData.proxy_character.character_name_cn || charData.proxy_character.series) && (
                          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                            {charData.proxy_character.character_name_cn}
                            {charData.proxy_character.series ? ` · 《${charData.proxy_character.series}》` : ''}
                          </span>
                        )}
                      </div>
                      {charData.proxy_character.reason && (
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                          <span style={{ color: 'var(--text-muted)' }}>匹配理由：</span>{charData.proxy_character.reason}
                        </div>
                      )}
                      {Array.isArray(charData.proxy_character.suppress_tags) && charData.proxy_character.suppress_tags.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', flexWrap: 'wrap', marginTop: '4px' }}>
                          <span style={{ color: '#fda4af' }}>🚫 原著服饰压制词：</span>
                          {charData.proxy_character.suppress_tags.map(st => (
                            <span key={st} style={{ background: 'rgba(244, 63, 94, 0.15)', color: '#fda4af', padding: '1px 6px', borderRadius: '4px', fontFamily: 'monospace' }}>
                              {st}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{
                      padding: '12px 16px',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px dashed rgba(255, 255, 255, 0.1)',
                      fontSize: '0.78rem',
                      color: 'var(--text-muted)'
                    }}>
                      未绑定同人脸模代理。点击右上角「编辑人设与脸模」可指定 Danbooru 动漫角色作为骨相锚点。
                    </div>
                  )}

                  {/* 结构化五官体态标签 */}
                  <div style={{ marginTop: '8px' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '10px' }}>
                      结构化特征短语 (Visual Feature Tags)
                    </div>
                    {renderDnaFeatures(charData.features)}
                  </div>

                  {/* 章节外观版本流 */}
                  {(characterDnaVersions[activeDnaChar] || []).length > 0 && (
                    <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '0.82rem', color: 'var(--color-pink)', fontWeight: 600, marginBottom: '8px' }}>
                        章节外观演进版本 (Appearance Versions)
                      </div>
                      {characterDnaVersions[activeDnaChar].map(version => {
                        const isEditing = editingAppearanceVersion?.characterName === activeDnaChar && editingAppearanceVersion?.id === version.id;
                        const range = `第 ${Number(version.startChapterIndex) + 1} 章${version.endChapterIndex == null ? '起' : `–${Number(version.endChapterIndex) + 1} 章`}`;
                        return (
                          <div key={version.id} style={{ padding: '8px 10px', marginTop: '6px', borderRadius: '6px', background: 'rgba(255,255,255,0.035)' }}>
                            {isEditing ? (
                              <>
                                <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                                  <input type="number" min="1" value={Number(editingAppearanceVersion.startChapterIndex) + 1} onChange={(event) => setEditingAppearanceVersion(current => ({ ...current, startChapterIndex: Math.max(0, Number(event.target.value || 1) - 1) }))} style={{ width: '72px' }} aria-label="外观版本起始章节" />
                                  <button className="btn-secondary" type="button" onClick={saveAppearanceVersion} disabled={savingAppearanceVersion} style={{ padding: '2px 7px', fontSize: '0.72rem' }}>{savingAppearanceVersion ? '保存中' : '保存'}</button>
                                  <button className="btn-secondary" type="button" onClick={() => setEditingAppearanceVersion(null)} disabled={savingAppearanceVersion} style={{ padding: '2px 7px', fontSize: '0.72rem' }}>取消</button>
                                </div>
                                <AutoResizeTextarea minRows={2} value={editingAppearanceVersion.tags} onChange={(event) => setEditingAppearanceVersion(current => ({ ...current, tags: event.target.value }))} style={{ width: '100%', fontSize: '0.72rem' }} aria-label="外观版本标签" />
                              </>
                            ) : (
                              <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px', alignItems: 'start' }}>
                                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{range}</span>
                                  <span style={{ display: 'flex', gap: '4px' }}>
                                    <button className="btn-secondary" type="button" onClick={() => setEditingAppearanceVersion({ characterName: activeDnaChar, id: version.id, startChapterIndex: version.startChapterIndex, tags: version.tags || '' })} style={{ padding: '2px 5px' }} title="编辑外观版本"><Pencil size={10} /></button>
                                    <button className="btn-secondary" type="button" onClick={() => deleteAppearanceVersion(activeDnaChar, version.id)} disabled={characterDnaVersions[activeDnaChar].length <= 1} style={{ padding: '2px 5px', color: 'var(--color-pink)' }} title="删除外观版本"><Trash2 size={10} /></button>
                                  </span>
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '3px', wordBreak: 'break-word' }}>{version.tags}</div>
                                {version.evidence?.[0]?.quote && <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '4px' }}>证据：{version.evidence[0].quote}</div>}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', placeContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              请在左侧列表中选择一个角色以查看和编辑设定
            </div>
          )}
        </div>
      </div>
    );
  };


  const renderWorkbenchTab = () => {
    if (!projectDetails) {
      return (
        <div className="empty-state-container">
          <Clapperboard size={48} style={{ opacity: 0.3, marginBottom: '12px' }} />
          <h3>请先选择一部小说项目</h3>
          <p>选择小说后即可进入场景生图、分镜细化与条漫制作</p>
          <button className="btn-primary" style={{ marginTop: '16px' }} onClick={() => setMainTab('books')}>
            去选择小说
          </button>
        </div>
      );
    }

    return (
      <div className="workbench-tab-view">
        {projectDetails ? (
          <>
            <div className="column-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                
                <span style={{ fontSize: '1.1rem', fontWeight: '600' }}>{activeProject}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  ({progressInfo.completed} / {progressInfo.total} 章节已处理)
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-secondary" onClick={() => setIsConfigOpen(true)}>
                  <Settings size={16} /> 配置
                </button>
                {workspaceTab !== 'comics' && (pipelineRunning ? (
                  <button className="btn-secondary" style={{ color: 'var(--color-orange)' }} onClick={stopPipeline}>
                    <Square size={16} /> 暂停
                  </button>
                ) : (
                  <>
                    <button className="btn-primary" onClick={startPipeline}>
                      <Play size={16} /> 启动
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => startRenderReadyScenes()}
                      disabled={readyScenesCount === 0}
                      title="仅排队生成所有已就绪 Prompt 且未出图的场景"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        borderColor: readyScenesCount > 0 ? 'rgba(168, 85, 247, 0.65)' : undefined,
                        color: readyScenesCount > 0 ? '#c084fc' : undefined
                      }}
                    >
                      <ImageIcon size={16} /> 仅生图 ({readyScenesCount})
                    </button>
                  </>
                ))}
                {workspaceTab !== 'comics' && <button className="btn-secondary" onClick={exportEPUB}>
                  <Download size={16} /> 编译 EPUB
                </button>}
              </div>
            </div>

            <div className="workspace-tabs" role="tablist" aria-label="项目工作区">
              <button className={workspaceTab === 'comics' ? 'active' : ''} onClick={() => setWorkspaceTab('comics')}>
                <Clapperboard size={15} /> 漫画工作台
              </button>
              <button
                className={workspaceTab === 'scenes' ? 'active' : ''}
                onClick={() => setWorkspaceTab('scenes')}
              >
                <Clapperboard size={15} /> 场景生图
              </button>
              <button
                className={workspaceTab === 'reader' ? 'active' : ''}
                onClick={() => setWorkspaceTab('reader')}
              >
                <FileText size={15} /> 正文阅读
              </button>
            </div>

            {workspaceTab === 'comics' && <ComicWorkbench key={activeProject} apiBase={API_BASE} projectName={activeProject} />}

            {/* 章节与正文卡片容器 */}
            <div style={{ display: workspaceTab === 'scenes' ? 'grid' : 'none', gridTemplateColumns: '200px 1fr', gap: '16px', flex: 1, overflow: 'hidden' }}>
              {/* 章节导航树 */}
              <div className="glass-panel" style={{ height: '100%', overflowY: 'auto', padding: '8px' }}>
                {projectDetails.chapters.map(chap => {
                  const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
                  const state = getChapterProgress(chap.volume, chap.chapter);
                  const isCompleted = state?.status === 'completed';
                  const isGenerating = state?.status === 'generating';
                  
                  return (
                    <div 
                      key={chapKey}
                      className={`chapter-item ${selectedChapter?.chapter === chap.chapter ? 'active' : ''}`}
                      onClick={() => {
                        if (activeProject && selectedChapter && textSelections.length > 0) {
                          const previousChapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
                          saveReaderSelections(activeProject, previousChapterKey, textSelections);
                        }
                        setSelectedChapter(chap);
                        setChapterContent(null);
                        setTextSelections([]);
                        closeSceneEditor();
                      }}
                    >
                      <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{chap.chapter}</span>
                      {isCompleted && <CheckCircle2 size={14} style={{ color: 'var(--color-green)' }} />}
                      {isGenerating && <span className="tag-badge scene" style={{ margin: 0, padding: '1px 4px' }}>生图中</span>}
                    </div>
                  );
                })}
              </div>

              {/* 场景详情卡片流 */}
              <div className="column-body">
                {selectedChapter && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {(() => {
                      const selectedChapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
                      const selectedChapterQueueState = chapterQueueStates[getChapterQueueStateKey(activeProject, selectedChapterKey)];
                      const selectedChapterProgress = getChapterProgress(selectedChapter.volume, selectedChapter.chapter);
                      const isSceneExtractionFailed = selectedChapterProgress?.status === 'failed'
                        && (selectedChapterProgress?.scenes || []).length === 0;
                      return (
                    <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255,255,255,0.01)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h3 style={{ fontSize: '1.2rem', marginBottom: '6px' }}>{selectedChapter.chapter}</h3>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          所属分卷: {selectedChapter.volume} | 全章字数: {selectedChapter.wordCount} 字
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button 
                          className="btn-secondary" 
                          disabled={isSingleChapterGenerateDisabled({ pipelineRunning, chapterQueueState: selectedChapterQueueState })}
                          onClick={() => generateSingleChapter(selectedChapter)}
                          style={{ display: 'flex', alignItems: 'center', gap: '4px', borderColor: 'var(--color-pink)' }}
                        >
                          <Play size={14} style={{ color: 'var(--color-pink)' }} />
                          {selectedChapterQueueState === 'queued'
                            ? '单章排队中'
                            : selectedChapterQueueState === 'running'
                              ? '单章执行中'
                              : isSceneExtractionFailed
                                ? '重试场景提炼'
                                : '单章重画'}
                        </button>
                        {(() => {
                          const chapterReadyCount = getReadyScenesCount(selectedChapterKey);
                          if (chapterReadyCount === 0) return null;
                          return (
                            <button
                              className="btn-secondary"
                              disabled={pipelineRunning}
                              onClick={() => startRenderReadyScenes(selectedChapterKey)}
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', borderColor: 'rgba(168, 85, 247, 0.65)', color: '#c084fc' }}
                              title="仅使用已就绪 Prompt 排队生成本章未出图的场景"
                            >
                              <ImageIcon size={14} /> 本章仅生图 ({chapterReadyCount})
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                      );
                    })()}

                    {/* 渲染当前章节的场景卡片 */}
                    {(() => {
                      const chapKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
                      const progress = getChapterProgress(selectedChapter.volume, selectedChapter.chapter);
                      const scenes = progress?.scenes || [];

                      if (scenes.length === 0) {
                        const extractionFailed = progress?.status === 'failed';
                        return (
                          <div className="glass-panel" style={{ padding: '40px', textLight: 'center', textAlign: 'center', color: 'var(--text-muted)' }}>
                            {extractionFailed ? (
                              <div style={{ display: 'grid', justifyItems: 'center', gap: '12px' }}>
                                <div style={{ color: '#fca5a5' }}>场景提炼失败，未创建兜底场景卡。</div>
                                {progress?.error && (
                                  <div style={{ maxWidth: '680px', fontSize: '0.82rem', color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                                    {progress.error}
                                  </div>
                                )}
                                <button
                                  className="btn-secondary"
                                  disabled={isSingleChapterGenerateDisabled({ pipelineRunning, chapterQueueState: chapterQueueStates[getChapterQueueStateKey(activeProject, chapKey)] })}
                                  onClick={() => generateSingleChapter(selectedChapter)}
                                  style={{ display: 'flex', alignItems: 'center', gap: '5px', borderColor: 'rgba(248, 113, 113, 0.7)', color: '#fecaca' }}
                                >
                                  <Play size={14} /> 重试场景提炼
                                </button>
                              </div>
                            ) : (
                              '本章尚未提取生成场景卡片。启动生图流水线时，将自动为您分析提取 5-10 个高潮插画场景。'
                            )}
                          </div>
                        );
                      }

                      return scenes.map((scene) => {
                        const sceneKey = `${chapKey}_${scene.scene_idx}`;
                        const isSceneLoading = loadingScenes[sceneKey];
                        const isSceneDeleteLocked = pipelineRunning || isSceneLoading === true || isSceneLoading === 'running' || isSceneLoading === 'deleting';
                        const sceneCharacters = Array.isArray(scene.characters) ? scene.characters : [];
                        const sceneCharacterCount = sceneCharacters.length > 0
                          ? sceneCharacters.length
                          : (Array.isArray(scene.character_names) ? scene.character_names.length : 0);
                        const sceneImage = scene.image_path ? encodeURI(`${API_BASE}/projects/${activeProject}/${scene.image_path}`) : null;
                        const sceneThumbnail = scene.image_path ? encodeURI(`${API_BASE}/projects/${activeProject}/${scene.image_path}?w=360`) : null;
                        const basePrompt = String(scene.base_prompt || scene.prepared_prompt?.basePrompt || '').trim();
                        const characterPrompts = getNonEmptyPromptList(scene.character_prompts, scene.prepared_prompt?.characterPrompts);
                        const negativeCharacterPrompts = getNonEmptyPromptList(scene.negative_character_prompts, scene.prepared_prompt?.negativeCharacterPrompts);
                        const finalNegative = String(scene.final_negative || scene.prepared_prompt?.finalNegative || '').trim();
                        const promptSections = [
                          ['Base Prompt', basePrompt],
                          ['Character Prompts', characterPrompts.join('\n')],
                          ['Character Negative Prompts', negativeCharacterPrompts.join('\n')],
                          ['Final Negative', finalNegative]
                        ].filter(([, value]) => String(value || '').trim());
                        const hasPrompt = promptSections.length > 0;
                        const isPromptExpanded = expandedPrompt === sceneKey;
                        const isInlineEditing = inlineEditingSceneKey === sceneKey && inlineSceneDraft !== null;

                        return (
                          <div 
                            key={scene.scene_idx} 
                            className={`scene-card glass-panel ${
                              scene.status === 'SUCCESS' && !isSceneLoading 
                                ? 'success' 
                                : isSceneLoading 
                                  ? 'generating' 
                                  : scene.status === 'PROMPT_READY'
                                    ? 'prompt-ready'
                                    : ''
                            }`}
                            style={{
                              border: isInlineEditing
                                ? '1px solid rgba(168, 85, 247, 0.75)'
                                : sceneEditor?.chapterKey === chapKey && sceneEditor?.sceneIdx === scene.scene_idx
                                  ? '1px solid rgba(168, 85, 247, 0.65)'
                                  : undefined,
                              boxShadow: isInlineEditing
                                ? '0 0 16px rgba(168, 85, 247, 0.22)'
                                : undefined
                            }}
                          >
                            {/* 卡片头部行 */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--color-purple)' }}>
                                  场景 #{scene.scene_idx}
                                </span>
                                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: 'rgba(255,255,255,0.04)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                  {isSceneLoading ? (
                                    <>
                                      <span className="loading-spinner-tiny" style={{
                                        display: 'inline-block',
                                        width: '8px',
                                        height: '8px',
                                        borderRadius: '50%',
                                        border: '2px solid var(--color-purple)',
                                        borderTopColor: 'transparent',
                                        animation: 'spin 1s linear infinite'
                                      }} />
                                      生图中
                                    </>
                                  ) : scene.status === 'SUCCESS' ? (
                                    '已完成'
                                  ) : scene.status === 'FAILED' ? (
                                    '失败'
                                  ) : scene.status === 'PROMPT_READY' ? (
                                    <span style={{ color: 'var(--color-purple)', fontWeight: '600' }}>⚡ Prompt 已就绪</span>
                                  ) : (
                                    '待处理'
                                  )}
                                </span>
                                {(scene.width || scene.prepared_prompt?.width) && (
                                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px' }}>
                                    {scene.width || scene.prepared_prompt?.width} × {scene.height || scene.prepared_prompt?.height}
                                  </span>
                                )}
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  style={{
                                    padding: '3px 8px',
                                    fontSize: '0.72rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    borderRadius: '6px',
                                    borderColor: isInlineEditing ? 'rgba(168, 85, 247, 0.65)' : 'rgba(96, 165, 250, 0.45)',
                                    color: isInlineEditing ? 'var(--color-purple-light, #c084fc)' : '#93c5fd',
                                    background: isInlineEditing ? 'rgba(168, 85, 247, 0.15)' : 'rgba(255,255,255,0.03)'
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isInlineEditing) {
                                      cancelInlineEditScene();
                                    } else {
                                      startInlineEditScene(chapKey, scene);
                                    }
                                  }}
                                  title={isInlineEditing ? '取消并退出就地编辑' : '在场景卡上直接编辑所有结构化字段'}
                                >
                                  <Pencil size={11} /> {isInlineEditing ? '收起编辑' : '就地编辑'}
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  style={{
                                    padding: '3px 8px',
                                    fontSize: '0.72rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    borderRadius: '6px'
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openSceneEditor(chapKey, scene);
                                  }}
                                  title="在独立大弹窗中编辑完整信息"
                                >
                                  弹窗
                                </button>
                              </div>
                            </div>

                            {/* 条件分支：就地编辑模式 vs 结构化直接可见模式 */}
                            {isInlineEditing ? (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '12px',
                                  marginTop: '6px',
                                  padding: '14px',
                                  background: 'rgba(8, 12, 28, 0.85)',
                                  border: '1px solid rgba(168, 85, 247, 0.35)',
                                  borderRadius: '10px'
                                }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--color-purple-light, #c084fc)' }}>
                                    ✏️ 场景 #{scene.scene_idx} 结构化信息就地编辑
                                  </span>
                                  <div style={{ display: 'flex', gap: '8px' }}>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      style={{ padding: '3px 10px', fontSize: '0.75rem' }}
                                      onClick={cancelInlineEditScene}
                                      disabled={savingInlineScene}
                                    >
                                      ✕ 取消
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-primary"
                                      style={{ padding: '3px 12px', fontSize: '0.75rem' }}
                                      onClick={() => saveInlineSceneEditor(chapKey, scene.scene_idx)}
                                      disabled={savingInlineScene}
                                    >
                                      {savingInlineScene ? '保存中...' : '💾 保存场景卡'}
                                    </button>
                                  </div>
                                </div>

                                {/* 基础信息行 */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                                  <label style={sceneEditorLabelStyle}>
                                    触发原句 (Trigger Sentence)
                                    <input
                                      style={sceneEditorInputStyle}
                                      value={inlineSceneDraft.trigger_sentence}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, trigger_sentence: e.target.value }))}
                                    />
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    NSFW 分级
                                    <select
                                      style={sceneEditorInputStyle}
                                      value={inlineSceneDraft.nsfw_rating}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, nsfw_rating: e.target.value }))}
                                    >
                                      <option value="sfw">sfw 全年龄</option>
                                      <option value="nsfw_mild">nsfw_mild 微妙</option>
                                      <option value="nsfw_moderate">nsfw_moderate 中度</option>
                                      <option value="nsfw_explicit">nsfw_explicit 显式</option>
                                    </select>
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    体位 (标准体位下拉 / 自拟输入)
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                      <select
                                        style={{ ...sceneEditorInputStyle, flex: '1 1 140px', padding: '6px 8px', fontSize: '0.82rem' }}
                                        value={ALL_SEX_POSITIONS.some(p => p.name === inlineSceneDraft.sex_position) ? inlineSceneDraft.sex_position : ''}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          if (val) {
                                            updateInlineDraft(draft => ({ ...draft, sex_position: val }));
                                          }
                                        }}
                                      >
                                        <option value="">-- 标准体位库 --</option>
                                        {SEX_POSITION_CATEGORIES.map(cat => (
                                          <optgroup key={cat.category} label={cat.category}>
                                            {cat.positions.map(pos => (
                                              <option key={pos.name} value={pos.name}>
                                                {pos.name} - {pos.desc}
                                              </option>
                                            ))}
                                          </optgroup>
                                        ))}
                                      </select>
                                      <input
                                        list="standard-sex-positions-datalist"
                                        style={{ ...sceneEditorInputStyle, flex: '1 1 120px' }}
                                        placeholder="或直接手输自拟体位"
                                        value={inlineSceneDraft.sex_position || ''}
                                        onChange={(e) => updateInlineDraft(draft => ({ ...draft, sex_position: e.target.value }))}
                                      />
                                    </div>
                                  </label>

                                  <div style={{ display: 'flex', gap: '8px' }}>
                                    <label style={{ ...sceneEditorLabelStyle, flex: 1 }}>
                                      宽 (Width)
                                      <input
                                        style={sceneEditorInputStyle}
                                        type="number"
                                        value={inlineSceneDraft.width}
                                        onChange={(e) => updateInlineDraft(draft => ({ ...draft, width: e.target.value }))}
                                      />
                                    </label>
                                    <label style={{ ...sceneEditorLabelStyle, flex: 1 }}>
                                      高 (Height)
                                      <input
                                        style={sceneEditorInputStyle}
                                        type="number"
                                        value={inlineSceneDraft.height}
                                        onChange={(e) => updateInlineDraft(draft => ({ ...draft, height: e.target.value }))}
                                      />
                                    </label>
                                  </div>
                                </div>

                                {/* 画面描述 & 核心动作 */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
                                  <label style={sceneEditorLabelStyle}>
                                    画面描述 (Visual Description)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={3}
                                      value={inlineSceneDraft.visual_description}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, visual_description: e.target.value }))}
                                    />
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    核心动作 (Core Action)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={3}
                                      value={inlineSceneDraft.core_action}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, core_action: e.target.value }))}
                                    />
                                  </label>
                                </div>

                                {/* 环境与镜头构图 */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
                                  <label style={sceneEditorLabelStyle}>
                                    环境场景 (Environment)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={2}
                                      value={inlineSceneDraft.environment}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, environment: e.target.value }))}
                                    />
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    镜头构图 (Cinematography)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={2}
                                      value={inlineSceneDraft.cinematography}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, cinematography: e.target.value }))}
                                    />
                                  </label>
                                </div>

                                {/* 角色列表编辑 */}
                                <div style={{ ...sceneEditorSectionStyle, padding: '10px', gap: '8px' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <Users size={14} /> 登场角色结构化信息
                                    </span>
                                    <button
                                      type="button"
                                      className="btn-secondary"
                                      style={{ padding: '3px 8px', fontSize: '0.72rem', borderRadius: '999px' }}
                                      onClick={() => updateInlineDraft(draft => ({
                                        ...draft,
                                        characters: [...(draft.characters || []), { name: '', gender: 'unknown', appearance: '', clothing: '', expression: '', pose: '', position: '' }],
                                        character_prompt_interactions: [...(draft.character_prompt_interactions || []), []]
                                      }))}
                                    >
                                      <Plus size={12} /> 添加角色
                                    </button>
                                  </div>

                                  {(inlineSceneDraft.characters || []).map((character, index) => (
                                    <div
                                      key={`inline-char-${index}`}
                                      style={{
                                        border: '1px solid rgba(255,255,255,0.08)',
                                        borderRadius: '8px',
                                        padding: '10px',
                                        display: 'grid',
                                        gap: '6px',
                                        background: 'rgba(5, 8, 20, 0.35)'
                                      }}
                                    >
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <strong style={{ fontSize: '0.82rem', color: '#f3f4f6' }}>
                                          角色 {index + 1}
                                        </strong>
                                        <button
                                          type="button"
                                          className="btn-secondary"
                                          style={{ padding: '2px 8px', fontSize: '0.7rem', color: '#fca5a5', borderRadius: '999px' }}
                                          onClick={() => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.filter((_, i) => i !== index),
                                            character_prompt_interactions: (draft.character_prompt_interactions || []).filter((_, i) => i !== index)
                                          }))}
                                        >
                                          删除
                                        </button>
                                      </div>

                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '6px' }}>
                                        <input
                                          style={{ ...sceneEditorInputStyle, padding: '6px 8px', fontSize: '0.82rem' }}
                                          placeholder="姓名"
                                          value={character.name}
                                          onChange={(e) => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, name: e.target.value } : item)
                                          }))}
                                        />
                                        <input
                                          style={{ ...sceneEditorInputStyle, padding: '6px 8px', fontSize: '0.82rem' }}
                                          placeholder="性别"
                                          value={character.gender}
                                          onChange={(e) => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, gender: e.target.value } : item)
                                          }))}
                                        />
                                        <input
                                          style={{ ...sceneEditorInputStyle, padding: '6px 8px', fontSize: '0.82rem' }}
                                          placeholder="👗 衣着 (clothing)"
                                          value={character.clothing}
                                          onChange={(e) => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, clothing: e.target.value } : item)
                                          }))}
                                        />
                                        <input
                                          style={{ ...sceneEditorInputStyle, padding: '6px 8px', fontSize: '0.82rem' }}
                                          placeholder="🧘 姿态 (pose)"
                                          value={character.pose}
                                          onChange={(e) => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, pose: e.target.value } : item)
                                          }))}
                                        />
                                        <input
                                          style={{ ...sceneEditorInputStyle, padding: '6px 8px', fontSize: '0.82rem' }}
                                          placeholder="😊 神态 (expression)"
                                          value={character.expression}
                                          onChange={(e) => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, expression: e.target.value } : item)
                                          }))}
                                        />
                                        <input
                                          style={{ ...sceneEditorInputStyle, padding: '6px 8px', fontSize: '0.82rem' }}
                                          placeholder="📍 位置 (position)"
                                          value={character.position}
                                          onChange={(e) => updateInlineDraft(draft => ({
                                            ...draft,
                                            characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, position: e.target.value } : item)
                                          }))}
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>

                                {/* 互动、痕迹与画面文字 */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                                  <label style={sceneEditorLabelStyle}>
                                    角色互动 (Interactions)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={2}
                                      value={inlineSceneDraft.interactions}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, interactions: e.target.value }))}
                                    />
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    剧情痕迹 (Plot Traces)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={2}
                                      value={inlineSceneDraft.plot_traces}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, plot_traces: e.target.value }))}
                                    />
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    画面文字 (Text Elements)
                                    <AutoResizeTextarea
                                      style={sceneEditorTextareaStyle}
                                      minRows={2}
                                      value={inlineSceneDraft.text_elements}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, text_elements: e.target.value }))}
                                    />
                                  </label>
                                </div>

                                {/* 必含与避开 */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                  <label style={sceneEditorLabelStyle}>
                                    必含元素 (Must Show, 逗号分隔)
                                    <input
                                      style={sceneEditorInputStyle}
                                      value={inlineSceneDraft.must_show}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, must_show: e.target.value }))}
                                    />
                                  </label>

                                  <label style={sceneEditorLabelStyle}>
                                    避开元素 (Must Not Show, 逗号分隔)
                                    <input
                                      style={sceneEditorInputStyle}
                                      value={inlineSceneDraft.must_not_show}
                                      onChange={(e) => updateInlineDraft(draft => ({ ...draft, must_not_show: e.target.value }))}
                                    />
                                  </label>
                                </div>

                                {/* 保存与取消按钮栏 */}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={cancelInlineEditScene}
                                    disabled={savingInlineScene}
                                  >
                                    ✕ 取消
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-primary"
                                    onClick={() => saveInlineSceneEditor(chapKey, scene.scene_idx)}
                                    disabled={savingInlineScene}
                                  >
                                    {savingInlineScene ? '保存中...' : '💾 保存场景卡'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              /* 结构化信息直接可见卡片 */
                              <>
                                {/* 插画与原文描述 */}
                                <div style={{ display: 'grid', gridTemplateColumns: sceneImage ? '168px minmax(0, 1fr)' : '1fr', gap: '14px', alignItems: 'start', marginTop: '6px' }}>
                                  {sceneImage && (
                                    <img
                                      src={sceneThumbnail || sceneImage}
                                      loading="lazy"
                                      decoding="async"
                                      alt="插画"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setPreviewImage(sceneImage);
                                      }}
                                      style={{
                                        width: '168px',
                                        height: '112px',
                                        borderRadius: '8px',
                                        objectFit: 'contain',
                                        background: 'linear-gradient(180deg, rgba(2,6,23,0.88), rgba(15,23,42,0.7))',
                                        border: '1px solid var(--border-light)',
                                        padding: '6px',
                                        cursor: 'zoom-in'
                                      }}
                                    />
                                  )}

                                  <div style={{ minWidth: 0, display: 'grid', gap: '8px' }}>
                                    {scene.trigger_sentence && (
                                      <div className="scene-trigger" style={{ marginTop: 0 }}>
                                        「 {scene.trigger_sentence} 」
                                      </div>
                                    )}

                                    <div className="scene-desc" style={{ marginTop: 0, lineHeight: 1.55 }}>
                                      {scene.visual_description || scene.scene_desc || <span style={{ color: 'var(--text-muted)' }}>暂无画面描述</span>}
                                    </div>
                                  </div>
                                </div>

                                {/* ⭐ 体位与分级快速控制条 */}
                                <div style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '8px',
                                  alignItems: 'center',
                                  padding: '8px 10px',
                                  background: 'rgba(236, 72, 153, 0.05)',
                                  border: '1px solid rgba(236, 72, 153, 0.2)',
                                  borderRadius: '8px',
                                  marginTop: '6px'
                                }}>
                                  {/* 体位选择器 */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '0.78rem', color: '#f472b6', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                                      <Flame size={13} /> 体位:
                                    </span>
                                    <select
                                      style={{
                                        background: 'rgba(15, 23, 42, 0.85)',
                                        border: scene.sex_position ? '1px solid rgba(244, 114, 182, 0.5)' : '1px solid rgba(255, 255, 255, 0.15)',
                                        color: scene.sex_position ? '#f472b6' : 'var(--text-muted)',
                                        fontWeight: scene.sex_position ? 600 : 400,
                                        borderRadius: '6px',
                                        padding: '3px 8px',
                                        fontSize: '0.78rem',
                                        cursor: 'pointer',
                                        outline: 'none'
                                      }}
                                      value={scene.sex_position || ''}
                                      disabled={quickUpdatingSceneKey === sceneKey}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '__CUSTOM__') {
                                          startInlineEditScene(chapKey, scene);
                                        } else {
                                          quickUpdateSceneField(chapKey, scene.scene_idx, { sex_position: val }, '体位');
                                        }
                                      }}
                                    >
                                      <option value="">{scene.sex_position ? '清空体位' : '➕ 选择体位'}</option>
                                      {scene.sex_position && !ALL_SEX_POSITIONS.some(p => p.name === scene.sex_position) && (
                                        <option value={scene.sex_position}>{scene.sex_position} (自拟)</option>
                                      )}
                                      {SEX_POSITION_CATEGORIES.map(cat => (
                                        <optgroup key={cat.category} label={cat.category}>
                                          {cat.positions.map(pos => (
                                            <option key={pos.name} value={pos.name}>
                                              {pos.name} - {pos.desc}
                                            </option>
                                          ))}
                                        </optgroup>
                                      ))}
                                      <option value="__CUSTOM__">✍️ 自定义自拟体位...</option>
                                    </select>
                                    {scene.sex_position && (
                                      <span style={{
                                        fontSize: '0.72rem',
                                        color: '#fbcfe8',
                                        background: 'rgba(244, 114, 182, 0.18)',
                                        padding: '1px 6px',
                                        borderRadius: '4px',
                                        border: '1px solid rgba(244, 114, 182, 0.35)',
                                        fontWeight: 600
                                      }}>
                                        {scene.sex_position}
                                      </span>
                                    )}
                                  </div>

                                  {/* NSFW 分级选择器 */}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                                      分级:
                                    </span>
                                    <select
                                      style={{
                                        background: 'rgba(15, 23, 42, 0.85)',
                                        border: '1px solid rgba(255, 255, 255, 0.15)',
                                        color: scene.nsfw_rating?.includes('explicit') ? '#f472b6' : scene.nsfw_rating?.includes('nsfw') ? '#fb923c' : '#a78bfa',
                                        fontWeight: 600,
                                        borderRadius: '6px',
                                        padding: '3px 8px',
                                        fontSize: '0.78rem',
                                        cursor: 'pointer',
                                        outline: 'none'
                                      }}
                                      value={scene.nsfw_rating || 'sfw'}
                                      disabled={quickUpdatingSceneKey === sceneKey}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        quickUpdateSceneField(chapKey, scene.scene_idx, { nsfw_rating: e.target.value }, '分级');
                                      }}
                                    >
                                      <option value="sfw">SFW 全年龄</option>
                                      <option value="nsfw_mild">NSFW Mild 微妙</option>
                                      <option value="nsfw_moderate">NSFW Moderate 中度</option>
                                      <option value="nsfw_explicit">NSFW Explicit 显式</option>
                                    </select>
                                  </div>

                                  <span className="tag-badge scene" style={{ margin: 0 }}>
                                    <Users size={12} style={{ marginRight: '3px' }} />
                                    {sceneCharacterCount} 人
                                  </span>

                                  {scene.image_path && (
                                    <span className="tag-badge scene" style={{ margin: 0, color: '#86efac', borderColor: 'rgba(34,197,94,0.3)' }}>
                                      有图
                                    </span>
                                  )}

                                  {hasPrompt && (
                                    <button
                                      type="button"
                                      className="tag-badge scene"
                                      style={{
                                        margin: 0,
                                        cursor: 'pointer',
                                        border: '1px solid rgba(168,85,247,0.35)',
                                        color: isPromptExpanded ? '#f5d0fe' : 'var(--color-purple-light, #c084fc)'
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setExpandedPrompt(prev => (prev === sceneKey ? null : sceneKey));
                                      }}
                                      title="展开实际发送给 NAI 的 Danbooru 分段 Prompt"
                                    >
                                      {isPromptExpanded ? '收起 Prompt' : 'Danbooru Prompt'}
                                    </button>
                                  )}
                                </div>

                                {/* ⚡ 核心动作 */}
                                {scene.core_action && (
                                  <div style={{
                                    fontSize: '0.82rem',
                                    background: 'rgba(236,72,153,0.08)',
                                    border: '1px solid rgba(236,72,153,0.22)',
                                    borderRadius: '6px',
                                    padding: '6px 10px',
                                    color: '#fbcfe8',
                                    marginTop: '4px'
                                  }}>
                                    ⚡ <strong style={{ color: '#f472b6' }}>核心动作：</strong>{scene.core_action}
                                  </div>
                                )}

                                {/* 📍 环境场景 & 🎥 镜头构图 */}
                                {(scene.environment || scene.cinematography) && (
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px', marginTop: '4px' }}>
                                    {scene.environment && (
                                      <div style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', padding: '6px 10px', color: '#cbd5e1' }}>
                                        <span style={{ color: 'var(--color-blue-light, #93c5fd)', fontWeight: 600 }}>📍 环境场景：</span>
                                        {scene.environment}
                                      </div>
                                    )}
                                    {scene.cinematography && (
                                      <div style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px', padding: '6px 10px', color: '#cbd5e1' }}>
                                        <span style={{ color: 'var(--color-purple-light, #c084fc)', fontWeight: 600 }}>🎥 镜头构图：</span>
                                        {scene.cinematography}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* 👥 登场角色结构化卡片 */}
                                {sceneCharacters.length > 0 ? (
                                  <div style={{ display: 'grid', gap: '6px', marginTop: '4px' }}>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <Users size={13} />
                                      <span>登场角色 ({sceneCharacters.length}人)：</span>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' }}>
                                      {sceneCharacters.map((char, cIdx) => (
                                        <div
                                          key={cIdx}
                                          style={{
                                            background: 'rgba(10, 15, 30, 0.45)',
                                            border: '1px solid rgba(255,255,255,0.08)',
                                            borderRadius: '8px',
                                            padding: '8px 10px',
                                            fontSize: '0.78rem',
                                            display: 'grid',
                                            gap: '4px'
                                          }}
                                        >
                                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <span style={{ fontWeight: 600, color: '#f3f4f6', fontSize: '0.83rem' }}>
                                              👤 {char.name || `角色 ${cIdx + 1}`}
                                            </span>
                                            {char.gender && (
                                              <span className="tag-badge scene" style={{ fontSize: '0.7rem', margin: 0, padding: '1px 6px' }}>
                                                {char.gender}
                                              </span>
                                            )}
                                          </div>
                                          {characters[char.name]?.proxy_character?.danbooru_tag && (
                                            <div style={{ color: '#f472b6', fontSize: '0.72rem', lineHeight: 1.3 }}>
                                              <span style={{ fontWeight: 600 }}>🎭 脸模：</span>
                                              <span style={{ fontFamily: 'monospace' }}>{characters[char.name].proxy_character.danbooru_tag}</span>
                                              {characters[char.name].proxy_character.character_name_cn ? ` (${characters[char.name].proxy_character.character_name_cn})` : ''}
                                            </div>
                                          )}
                                          {char.clothing && (
                                            <div style={{ color: '#fed7aa', lineHeight: 1.4 }}>
                                              <span style={{ color: '#fb923c', fontWeight: 600 }}>👗 衣着：</span>{char.clothing}
                                            </div>
                                          )}
                                          {char.pose && (
                                            <div style={{ color: '#e2e8f0', lineHeight: 1.4 }}>
                                              <span style={{ color: '#38bdf8', fontWeight: 600 }}>🧘 姿态：</span>{char.pose}
                                            </div>
                                          )}
                                          {char.expression && (
                                            <div style={{ color: '#e2e8f0', lineHeight: 1.4 }}>
                                              <span style={{ color: '#a78bfa', fontWeight: 600 }}>😊 神态：</span>{char.expression}
                                            </div>
                                          )}
                                          {char.position && (
                                            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                              <span style={{ color: '#94a3b8', fontWeight: 600 }}>📍 位置：</span>{char.position}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (Array.isArray(scene.character_names) && scene.character_names.length > 0) ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '0.8rem', marginTop: '4px' }}>
                                    <span style={{ color: 'var(--text-muted)' }}>登场角色：</span>
                                    {scene.character_names.map((name, nIdx) => (
                                      <span key={nIdx} className="tag-badge scene" style={{ margin: 0 }}>
                                        👤 {name}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}

                                {/* 🤝 互动、🔍 剧情痕迹 & 💬 画面文字 */}
                                {(scene.interactions || scene.plot_traces || scene.text_elements) && (
                                  <div style={{ display: 'grid', gap: '4px', fontSize: '0.78rem', background: 'rgba(0,0,0,0.18)', padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.04)', marginTop: '4px' }}>
                                    {scene.interactions && (
                                      <div>
                                        <span style={{ color: '#f472b6', fontWeight: 600 }}>🤝 互动：</span>
                                        <span style={{ color: '#e5e7eb' }}>{scene.interactions}</span>
                                      </div>
                                    )}
                                    {scene.plot_traces && (
                                      <div>
                                        <span style={{ color: '#fbbf24', fontWeight: 600 }}>🔍 剧情痕迹：</span>
                                        <span style={{ color: '#e5e7eb' }}>{scene.plot_traces}</span>
                                      </div>
                                    )}
                                    {scene.text_elements && (
                                      <div>
                                        <span style={{ color: '#6ee7b7', fontWeight: 600 }}>💬 画面文字：</span>
                                        <span style={{ color: '#e5e7eb' }}>{scene.text_elements}</span>
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* 🏷️ 必含与避开元素 */}
                                {((Array.isArray(scene.must_show) && scene.must_show.length > 0) || (Array.isArray(scene.must_not_show) && scene.must_not_show.length > 0)) && (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', fontSize: '0.75rem', marginTop: '4px' }}>
                                    {Array.isArray(scene.must_show) && scene.must_show.length > 0 && (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                                        <span style={{ color: '#86efac', fontWeight: 600 }}>必含:</span>
                                        {scene.must_show.map((tag, tIdx) => (
                                          <span key={tIdx} style={{ background: 'rgba(34, 197, 94, 0.12)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#86efac', padding: '1px 6px', borderRadius: '4px' }}>
                                            +{tag}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    {Array.isArray(scene.must_not_show) && scene.must_not_show.length > 0 && (
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                                        <span style={{ color: '#fca5a5', fontWeight: 600 }}>避开:</span>
                                        {scene.must_not_show.map((tag, tIdx) => (
                                          <span key={tIdx} style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', padding: '1px 6px', borderRadius: '4px' }}>
                                            -{tag}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* Danbooru Prompt 折叠面板 */}
                                {isPromptExpanded && hasPrompt && (
                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      marginTop: '8px',
                                      padding: '12px',
                                      borderRadius: '8px',
                                      border: '1px solid rgba(168,85,247,0.22)',
                                      background: 'rgba(7,10,24,0.76)',
                                      display: 'grid',
                                      gap: '10px'
                                    }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-purple-light, #c084fc)' }}>
                                        Danbooru Prompt Params
                                      </span>
                                      <button
                                        type="button"
                                        className="btn-secondary"
                                        style={{ padding: '3px 8px', fontSize: '0.72rem', borderRadius: '999px' }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          const text = promptSections
                                            .map(([label, value]) => `${label}:\n${value}`)
                                            .join('\n\n');
                                          navigator.clipboard.writeText(text);
                                          addLog(`📋 已复制场景 #${scene.scene_idx} Danbooru Prompt 参数`, 'success');
                                        }}
                                      >
                                        <Copy size={12} /> 复制
                                      </button>
                                    </div>
                                    {promptSections.map(([label, value]) => (
                                      <div key={label} style={{ display: 'grid', gap: '4px' }}>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{label}</div>
                                        <pre
                                          style={{
                                            margin: 0,
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                                            fontSize: '0.76rem',
                                            lineHeight: 1.45,
                                            color: '#e5e7eb',
                                            background: 'rgba(0,0,0,0.24)',
                                            border: '1px solid rgba(255,255,255,0.06)',
                                            borderRadius: '6px',
                                            padding: '8px'
                                          }}
                                        >
                                          {value}
                                        </pre>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}

                            {/* 单场景重绘操作栏 */}
                            <div 
                              style={{ 
                                marginTop: '12px', 
                                paddingTop: '10px', 
                                borderTop: '1px solid rgba(255,255,255,0.04)', 
                                display: 'flex', 
                                justifyContent: 'flex-end', 
                                gap: '8px',
                                flexWrap: 'wrap'
                              }}
                            >
                              <button
                                className="btn-secondary"
                                style={{ 
                                  padding: '4px 12px', 
                                  fontSize: '0.75rem', 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  gap: '4px', 
                                  height: '28px',
                                  borderColor: 'rgba(168, 85, 247, 0.4)',
                                  color: 'var(--color-purple-light, #c084fc)'
                                }}
                                disabled={Boolean(isSceneLoading)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  redrawScene(selectedChapter, scene.scene_idx);
                                }}
                                title="重新调用 LLM 生成 Prompt，然后加入 NAI 串行重绘队列"
                              >
                                {isSceneLoading === 'queued'
                                  ? '📋 排队中'
                                  : isSceneLoading === 'running'
                                    ? '🎨 重绘中'
                                    : '🔄 重算 Prompt'}
                              </button>
                              <button
                                className="btn-secondary"
                                style={{
                                  padding: '4px 12px',
                                  fontSize: '0.75rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  height: '28px',
                                  borderColor: 'rgba(34, 197, 94, 0.45)',
                                  color: '#86efac'
                                }}
                                disabled={Boolean(isSceneLoading)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  redrawSceneNaiOnly(selectedChapter, scene.scene_idx);
                                }}
                                title="完全复用当前最终正向、负向及角色 Prompt，只重新调用 NAI"
                              >
                                {isSceneLoading === 'queued'
                                  ? '📋 排队中'
                                  : isSceneLoading === 'running'
                                    ? '🎨 重绘中'
                                    : '🖼️ 仅 NAI'}
                              </button>
                              <button
                                className="btn-secondary"
                                style={{ 
                                  padding: '4px 12px', 
                                  fontSize: '0.75rem', 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  gap: '4px', 
                                  height: '28px',
                                  borderColor: 'rgba(236, 72, 153, 0.4)',
                                  color: 'var(--color-pink-light, #f472b6)'
                                }}
                                disabled={pipelineRunning || isSceneLoading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  regenerateScene(selectedChapter, scene.scene_idx);
                                }}
                                title="调用 LLM 重新生成该高潮句的直白画面描述，并投喂给 NAI 重新生图"
                              >
                                🧠 重构描述 (LLM+NAI)
                              </button>
                              <button
                                className="btn-secondary"
                                style={{
                                  padding: '4px 12px',
                                  fontSize: '0.75rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  height: '28px',
                                  borderColor: isInlineEditing ? 'rgba(168, 85, 247, 0.65)' : 'rgba(96, 165, 250, 0.45)',
                                  color: isInlineEditing ? 'var(--color-purple-light, #c084fc)' : '#93c5fd'
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isInlineEditing) {
                                    cancelInlineEditScene();
                                  } else {
                                    startInlineEditScene(chapKey, scene);
                                  }
                                }}
                                title="在场景卡上直接编辑所有结构化字段"
                              >
                                <Pencil size={12} /> {isInlineEditing ? '收起编辑' : '编辑卡片'}
                              </button>
                              <button
                                className="btn-secondary"
                                style={{
                                  padding: '4px 12px',
                                  fontSize: '0.75rem',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  height: '28px',
                                  borderColor: 'rgba(239, 68, 68, 0.45)',
                                  color: '#fca5a5'
                                }}
                                disabled={isSceneDeleteLocked}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteScene(selectedChapter, scene.scene_idx);
                                }}
                                title="删除该场景并清理对应图片文件，后续场景会重新编号"
                              >
                                <Trash2 size={12} /> 删除
                              </button>
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            </div>

            {workspaceTab === 'reader' && (
              <div className="reader-layout">
                <div className="glass-panel reader-chapters">
                  {projectDetails.chapters.map(chap => {
                    const chapKey = `${chap.volume}_${chap.chapter}`.replace(/\s+/g, '_');
                    return (
                    <button
                        key={`reader-${chapKey}`}
                        className={`chapter-item ${selectedChapter?.chapter === chap.chapter ? 'active' : ''}`}
                        onClick={() => {
                          if (activeProject && selectedChapter && textSelections.length > 0) {
                            const previousChapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
                            saveReaderSelections(activeProject, previousChapterKey, textSelections);
                          }
                          setSelectedChapter(chap);
                          setChapterContent(null);
                          setTextSelections([]);
                          closeSceneEditor();
                        }}
                      >
                        <span>{chap.chapter}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="reader-page glass-panel">
                  <div className="reader-toolbar">
                    <div>
                      <h3>{selectedChapter?.chapter || '请选择章节'}</h3>
                      <span>用光标拖选句子或段落，松开后自动加入待生成列表；可连续选择多处。</span>
                    </div>
                    <button
                      className="btn-primary"
                      disabled={!textSelections.length || isSubmittingSelections}
                      onClick={generateSelectedParagraphs}
                    >
                      <Sparkles size={15} />
                      {isSubmittingSelections ? '提交中...' : `生成所选${textSelections.length ? ` ${textSelections.length} 处` : ''}`}
                    </button>
                  </div>
                  {textSelections.length > 0 && (
                    <div className="reader-selection-tray">
                      {textSelections.map((selection, index) => (
                        <div className="reader-selection-chip" key={`${selection.paragraphIndex}-${selection.text}-${index}`}>
                          <span>{selection.text}</span>
                          <button
                            type="button"
                            aria-label={`移除选区 ${index + 1}`}
                            onClick={() => setTextSelections(prev => {
                              const next = prev.filter((_, itemIndex) => itemIndex !== index);
                              if (activeProject && selectedChapter) {
                                const chapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
                                saveReaderSelections(activeProject, chapterKey, next);
                              }
                              return next;
                            })}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <article
                    className="novel-reader"
                    onPointerUp={() => window.setTimeout(captureTextSelection, 0)}
                  >
                    {!chapterContent ? (
                      <div className="reader-empty">正在载入正文...</div>
                    ) : (() => {
                      const scenes = getChapterProgress(selectedChapter.volume, selectedChapter.chapter)?.scenes || [];
                      const paragraphScenePlacements = placeReaderScenesByParagraph(chapterContent.paragraphs, scenes);
                      return chapterContent.paragraphs.map((paragraph, paragraphIndex) => {
                      const paragraphScenes = paragraphScenePlacements[paragraphIndex] || [];
                      return (
                        <section key={`${paragraphIndex}-${paragraph.slice(0, 16)}`} className="reader-paragraph-block">
                          <p className="reader-paragraph" data-paragraph-index={paragraphIndex}>{paragraph}</p>
                          {paragraphScenes.map(scene => (
                            <img
                              key={`inline-${scene.scene_idx}`}
                              className="reader-illustration"
                              src={encodeURI(`${API_BASE}/projects/${activeProject}/${scene.image_path}?w=960`)}
                              loading="lazy"
                              decoding="async"
                              alt=""
                              onClick={() => setPreviewImage(encodeURI(`${API_BASE}/projects/${activeProject}/${scene.image_path}`))}
                            />
                          ))}
                        </section>
                      );
                    });
                    })()}
                  </article>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)' }}>
            请先创建或导入小说项目，即可开始自动配图工作流。
          </div>
        )}
      </div>
    );
  };


  const renderLogDrawer = () => {
    const lastPipelineLog = logs.length > 0 ? logs[logs.length - 1] : null;
    const lastNaiLog = naiLogs.length > 0 ? naiLogs[naiLogs.length - 1] : null;
    const latestLog = (() => {
      if (!lastPipelineLog && !lastNaiLog) return null;
      if (lastPipelineLog && !lastNaiLog) return lastPipelineLog;
      if (!lastPipelineLog && lastNaiLog) return lastNaiLog;
      return (lastNaiLog.time >= lastPipelineLog.time) ? lastNaiLog : lastPipelineLog;
    })();

    return (
      <div className={`log-dock-container ${isLogsOpen ? (isLogsMaximized ? 'maximized' : 'expanded') : 'collapsed'}`}>
        {!isLogsOpen ? (
          <div className="log-dock-collapsed-bar" onClick={() => setIsLogsOpen(true)} title="点击展开实时运行日志">
            <div className="log-dock-bar-left">
              <Terminal size={14} className="log-dock-icon" />
              <span className="log-dock-title">实时日志</span>
              <span className="log-dock-count">
                ({logs.length} 条流水线 / {naiLogs.length} 条生图)
              </span>

              {cooldown > 0 && (
                <div
                  className={`cooldown-chip mini active ${cooldownState.mode === 'degraded' ? 'degraded' : ''}`}
                  title={cooldownState.mode === 'degraded'
                    ? `429 降级模式：固定 35 秒，成功 ${cooldownState.degradedSuccesses || 0}/5 次后恢复`
                    : `基础间隔 ${cooldownState.baseCooldownSeconds || config.nai_cooldown_seconds || 15} 秒`}
                >
                  <Timer size={11} />
                  <span>{Math.ceil(cooldown)}s</span>
                </div>
              )}

              <div className="log-dock-latest-preview">
                {latestLog ? (
                  <span className={`latest-text ${latestLog.type || ''}`}>
                    <span className="latest-time">[{latestLog.time}]</span> {latestLog.text}
                  </span>
                ) : (
                  <span className="latest-empty" style={{ opacity: 0.5 }}>系统就绪，暂无实时日志</span>
                )}
              </div>
            </div>

            <div className="log-dock-bar-right" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="btn-secondary log-dock-action-btn"
                onClick={() => setIsLogsOpen(true)}
                title="展开实时日志"
              >
                <ChevronUp size={13} /> 展开日志
              </button>
            </div>
          </div>
        ) : (
          <div className="log-dock-expanded-view">
            <div className="log-dock-header">
              <div className="log-dock-header-left">
                <div className="log-dock-header-title">
                  <Terminal size={17} style={{ color: '#a855f7' }} />
                  <span>流水线与生图运行日志</span>
                </div>
                <span className="log-dock-header-subtitle">
                  实时监控后台大模型提取状态、NovelAI 生图请求与频控降级
                </span>
              </div>

              <div className="log-dock-header-right">
                <div
                  className={`cooldown-chip ${cooldown > 0 ? 'active' : ''} ${cooldownState.mode === 'degraded' ? 'degraded' : ''}`}
                  title={cooldownState.mode === 'degraded'
                    ? `429 降级模式：固定 35 秒，成功 ${cooldownState.degradedSuccesses || 0}/5 次后恢复`
                    : `基础间隔 ${cooldownState.baseCooldownSeconds || config.nai_cooldown_seconds || 15} 秒`}
                >
                  <Timer size={14} />
                  <span>{cooldown > 0 ? `${Math.ceil(cooldown)}s` : `${cooldownState.cooldownSeconds || 15}s`}</span>
                </div>

                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setLogs([]); setNaiLogs([]); }}
                  style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                  title="清空日志"
                >
                  <Trash2 size={13} /> 清空日志
                </button>

                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsLogsMaximized(!isLogsMaximized)}
                  style={{ padding: '4px 8px', fontSize: '0.78rem' }}
                  title={isLogsMaximized ? "还原高度" : "全屏放大"}
                >
                  {isLogsMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>

                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsLogsOpen(false)}
                  style={{ padding: '4px 10px', fontSize: '0.78rem', color: '#fca5a5' }}
                  title="收起日志抽屉"
                >
                  <ChevronDown size={14} /> 收起
                </button>
              </div>
            </div>

            <div className="logs-split-container">
              {/* 左半部分：常规/LLM日志 */}
              <div className="log-panel-box glass-panel">
                <div className="log-panel-header">
                  <span style={{ fontWeight: 600, fontSize: '0.82rem' }}>⚙️ 流水线与 LLM 提取日志</span>
                  <span style={{ fontSize: '0.70rem', color: 'var(--text-muted)' }}>{logs.length} 条记录</span>
                </div>
                <div className="log-scroll-area">
                  {logs.length === 0 ? (
                    <div className="log-empty-tip">暂无流水线日志</div>
                  ) : (
                    logs.map((log, idx) => (
                      <div key={idx} className={`log-line ${log.type || ''}`}>
                        <span className="log-timestamp">[{log.time}]</span>
                        <span>{log.text}</span>
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>

              {/* 右半部分：NovelAI 生图日志 */}
              <div className="log-panel-box glass-panel">
                <div className="log-panel-header">
                  <span style={{ fontWeight: 600, fontSize: '0.82rem' }}>🎨 NovelAI 生图控制台</span>
                  <span style={{ fontSize: '0.70rem', color: 'var(--text-muted)' }}>{naiLogs.length} 条记录</span>
                </div>
                <div className="log-scroll-area">
                  {naiLogs.length === 0 ? (
                    <div className="log-empty-tip">暂无 NovelAI 生图日志</div>
                  ) : (
                    naiLogs.map((log, idx) => (
                      <div key={idx} className={`log-line ${log.type || ''}`}>
                        <span className="log-timestamp">[{log.time}]</span>
                        <span>{log.text}</span>
                      </div>
                    ))
                  )}
                  <div ref={naiLogsEndRef} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };


  return (
    <div className="app-root">
      {/* 顶部全局导航栏 */}
      <header className="app-header">
        <div className="app-header-left">
          <div className="app-brand">
            <Sparkles size={19} className="brand-icon" />
            <span>NovelAI Illustrator</span>
          </div>

          <nav className="main-tab-bar" role="tablist">
            <button 
              type="button"
              className={`main-tab-item ${mainTab === 'books' ? 'active' : ''}`}
              onClick={() => setMainTab('books')}
            >
              <BookOpen size={15} />
              <span>书籍项目</span>
              <span className="tab-badge">{projects.length}</span>
            </button>

            <button 
              type="button"
              className={`main-tab-item ${mainTab === 'dna' ? 'active' : ''}`}
              onClick={() => setMainTab('dna')}
              disabled={!activeProject}
              title={!activeProject ? '请先选择一本书籍' : ''}
            >
              <User size={15} />
              <span>角色 DNA</span>
              {activeProject && <span className="tab-badge dna">{Object.keys(characters).length}</span>}
              {isExtractingDna && <span className="tab-pulse-dot" style={{ background: '#a855f7' }} title="角色 DNA 提炼中" />}
            </button>

            <button 
              type="button"
              className={`main-tab-item ${mainTab === 'workbench' ? 'active' : ''}`}
              onClick={() => setMainTab('workbench')}
              disabled={!activeProject}
              title={!activeProject ? '请先选择一本书籍' : ''}
            >
              <Clapperboard size={15} />
              <span>工作台</span>
              {activeProject && progressInfo.total > 0 && (
                <span className="tab-badge progress">{progressInfo.completed}/{progressInfo.total}</span>
              )}
            </button>

            <button 
              type="button"
              className={`main-tab-item log-toggle-tab ${isLogsOpen ? 'active' : ''}`}
              onClick={() => setIsLogsOpen(!isLogsOpen)}
              title={isLogsOpen ? "收起底部运行日志" : "在当前工作台展开实时运行日志"}
            >
              <Terminal size={15} />
              <span>实时日志</span>
              {(logs.length + naiLogs.length > 0) && (
                <span className="tab-badge" style={{ background: isLogsOpen ? 'rgba(168,85,247,0.3)' : 'rgba(255,255,255,0.08)' }}>
                  {logs.length + naiLogs.length}
                </span>
              )}
              {(pipelineRunning || isExtractingDna) && (
                <span className="tab-pulse-dot" title={isExtractingDna ? "角色 DNA 提炼中" : "流水线运行中"} />
              )}
              {isLogsOpen ? <ChevronDown size={13} style={{ opacity: 0.7, marginLeft: 2 }} /> : <ChevronUp size={13} style={{ opacity: 0.7, marginLeft: 2 }} />}
            </button>
          </nav>
        </div>

        <div className="app-header-right">
          {activeProject && (
            <div className="active-project-pill" onClick={() => setMainTab('books')} title="点击切换书籍">
              <BookOpen size={13} />
              <span className="pill-name">{activeProject}</span>
            </div>
          )}

          {activeProject && (
            <div className="header-pipeline-controls">
              {pipelineRunning ? (
                <button className="btn-secondary" style={{ color: 'var(--color-orange)', padding: '5px 12px', fontSize: '0.8rem' }} onClick={stopPipeline}>
                  <Square size={14} /> 暂停
                </button>
              ) : (
                <button className="btn-primary" style={{ padding: '5px 14px', fontSize: '0.8rem' }} onClick={startPipeline}>
                  <Play size={14} /> 启动流水线
                </button>
              )}

              {readyScenesCount > 0 && (
                <button
                  className="btn-secondary"
                  onClick={() => startRenderReadyScenes()}
                  style={{
                    padding: '5px 12px',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    borderColor: 'rgba(168, 85, 247, 0.65)',
                    color: '#c084fc'
                  }}
                  title="仅排队生成所有已就绪场景"
                >
                  <ImageIcon size={14} /> 仅生图 ({readyScenesCount})
                </button>
              )}

              <div
                className={`cooldown-chip ${cooldown > 0 ? 'active' : ''} ${cooldownState.mode === 'degraded' ? 'degraded' : ''}`}
                title={cooldownState.mode === 'degraded'
                  ? '429 降级模式：固定 35 秒，成功 5 次后恢复'
                  : `基础间隔 ${cooldownState.baseCooldownSeconds || config.nai_cooldown_seconds || 15} 秒`}
              >
                <Timer size={13} />
                <span>{cooldown > 0 ? `${Math.ceil(cooldown)}s` : `${cooldownState.cooldownSeconds || 15}s`}</span>
              </div>
            </div>
          )}

          <button className="btn-secondary" style={{ padding: '6px 9px' }} onClick={() => setIsConfigOpen(true)} title="全局设置">
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* 主视口 */}
      <main className="app-main-viewport">
        {mainTab === 'books' && renderBooksTab()}
        {mainTab === 'dna' && renderDnaTab()}
        {(mainTab === 'workbench' || mainTab === 'logs') && renderWorkbenchTab()}
      </main>

      {/* 底部可收起与展开的实时日志抽屉 */}
      {renderLogDrawer()}

      {/* 角色 DNA 切片更新提示 */}
      {dnaUpdatePrompt && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '520px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><User size={20} /> 更新角色 DNA</h2>
              <button className="btn-secondary" style={{ padding: '6px' }} onClick={() => setDnaUpdatePrompt(null)}>
                <X size={16} />
              </button>
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '14px' }}>
              流水线即将处理{dnaUpdatePrompt.sliceLabel}，这组章节还没有更新角色 DNA。建议先分析这 10 章的人物外貌、别名与证据，再继续生图，避免长篇后续角色设定缺失或漂移。
            </div>
            <div style={{ maxHeight: '160px', overflowY: 'auto', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '10px', marginBottom: '16px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              {(dnaUpdatePrompt.chapters || []).map((chap, idx) => (
                <div key={`${chap.volume}_${chap.chapter}_${idx}`}>{idx + 1}. {chap.volume} / {chap.chapter}</div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button className="btn-secondary" onClick={() => setDnaUpdatePrompt(null)}>
                稍后处理
              </button>
              <button className="btn-primary" onClick={updateDnaSliceAndContinue} disabled={pipelineRunning}>
                一键更新并继续
              </button>
            </div>
          </div>
        </div>
      )}

      {sceneEditor && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '1100px', width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, rgba(24, 28, 56, 0.98), rgba(18, 22, 46, 0.98))', border: '1px solid rgba(148, 163, 184, 0.14)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexShrink: 0 }}>
              <div>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Pencil size={18} /> 场景 #{sceneEditor.sceneIdx}</h2>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  点击保存后只更新场景卡与已存 Prompt，不会自动重绘
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {sceneEditorDirty && <span style={{ fontSize: '0.8rem', color: 'var(--color-orange)' }}>未保存</span>}
                <button className="btn-secondary" style={{ padding: '6px' }} onClick={closeSceneEditor}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: sceneEditor.imagePath ? '220px 1fr' : '1fr', gap: '18px', overflow: 'hidden', flex: 1 }}>
              {sceneEditor.imagePath && (
                <div style={{ ...sceneEditorSectionStyle, alignContent: 'start', minHeight: 0 }}>
                  <img
                    src={encodeURI(`${API_BASE}/projects/${activeProject}/${sceneEditor.imagePath}?w=720`)}
                    loading="lazy"
                    decoding="async"
                    alt="场景插画"
                    onClick={() => setPreviewImage(encodeURI(`${API_BASE}/projects/${activeProject}/${sceneEditor.imagePath}`))}
                    style={{
                      width: '100%',
                      maxHeight: '240px',
                      borderRadius: '12px',
                      border: '1px solid var(--border-light)',
                      objectFit: 'contain',
                      background: 'linear-gradient(180deg, rgba(2,6,23,0.88), rgba(15,23,42,0.7))',
                      padding: '10px',
                      cursor: 'zoom-in'
                    }}
                  />
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    <div>状态: {sceneEditor.status || '未知'}</div>
                    <div>路径: {sceneEditor.imagePath}</div>
                  </div>
                </div>
              )}

              <div style={{ overflowY: 'auto', paddingRight: '4px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ ...sceneEditorSectionStyle, gridTemplateColumns: '1fr 130px 160px 100px 100px', gap: '10px' }}>
                  <label style={sceneEditorLabelStyle}>
                    Trigger Sentence
                    <input style={sceneEditorInputStyle} value={sceneEditor.draft.trigger_sentence} onChange={(e) => updateSceneDraft(draft => ({ ...draft, trigger_sentence: e.target.value }))} />
                  </label>
                  <label style={sceneEditorLabelStyle}>
                    NSFW
                    <select style={sceneEditorInputStyle} value={sceneEditor.draft.nsfw_rating} onChange={(e) => updateSceneDraft(draft => ({ ...draft, nsfw_rating: e.target.value }))}>
                      <option value="sfw">sfw</option>
                      <option value="nsfw_mild">nsfw_mild</option>
                      <option value="nsfw_moderate">nsfw_moderate</option>
                      <option value="nsfw_explicit">nsfw_explicit</option>
                    </select>
                  </label>
                  <label style={sceneEditorLabelStyle}>
                    Sex Position (体位)
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <select
                        style={{ ...sceneEditorInputStyle, flex: '1 1 140px', padding: '6px 8px', fontSize: '0.82rem' }}
                        value={ALL_SEX_POSITIONS.some(p => p.name === sceneEditor.draft.sex_position) ? sceneEditor.draft.sex_position : ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val) {
                            updateSceneDraft(draft => ({ ...draft, sex_position: val }));
                          }
                        }}
                      >
                        <option value="">-- 标准体位库 --</option>
                        {SEX_POSITION_CATEGORIES.map(cat => (
                          <optgroup key={cat.category} label={cat.category}>
                            {cat.positions.map(pos => (
                              <option key={pos.name} value={pos.name}>
                                {pos.name} - {pos.desc}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <input
                        list="standard-sex-positions-datalist"
                        style={{ ...sceneEditorInputStyle, flex: '1 1 120px' }}
                        placeholder="体位/动作(选或自拟)"
                        value={sceneEditor.draft.sex_position || ''}
                        onChange={(e) => updateSceneDraft(draft => ({ ...draft, sex_position: e.target.value }))}
                      />
                    </div>
                    <datalist id="standard-sex-positions-datalist">
                      {ALL_SEX_POSITIONS.map(pos => (
                        <option key={pos.name} value={pos.name}>{pos.name} - {pos.desc}</option>
                      ))}
                    </datalist>
                  </label>
                  <label style={sceneEditorLabelStyle}>
                    Width
                    <input style={sceneEditorInputStyle} type="number" value={sceneEditor.draft.width} onChange={(e) => updateSceneDraft(draft => ({ ...draft, width: e.target.value }))} />
                  </label>
                  <label style={sceneEditorLabelStyle}>
                    Height
                    <input style={sceneEditorInputStyle} type="number" value={sceneEditor.draft.height} onChange={(e) => updateSceneDraft(draft => ({ ...draft, height: e.target.value }))} />
                  </label>
                </div>

                <div style={sceneEditorSectionStyle}>
                  <div style={{ display: 'grid', gap: '4px' }}>
                    <h3 style={{ fontSize: '0.95rem', margin: 0 }}>轻量场景卡</h3>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      这里维护选帧结果本身，供后续 Prompt LLM 再补全。
                    </div>
                  </div>
                  {[
                    ['visual_description', 'Visual Description', 4],
                    ['core_action', 'Core Action', 2],
                    ['character_names', 'Character Names', 2]
                  ].map(([field, label, rows]) => (
                    <label key={field} style={sceneEditorLabelStyle}>
                      {label}
                      <AutoResizeTextarea
                        style={{
                          ...sceneEditorTextareaStyle,
                          background: 'linear-gradient(180deg, rgba(8,11,26,0.82), rgba(12,18,38,0.72))'
                        }}
                        minRows={rows}
                        value={sceneEditor.draft[field]}
                        onChange={(e) => updateSceneDraft(draft => {
                          if (field !== 'character_names') {
                            return { ...draft, [field]: e.target.value };
                          }

                          const characterNames = e.target.value;
                          const syncedCharacters = syncSceneCharactersFromNames(characterNames, draft.characters, characters);
                          return {
                            ...draft,
                            character_names: characterNames,
                            characters: syncedCharacters,
                            character_prompt_interactions: syncSceneCharacterInteractions(
                              syncedCharacters,
                              draft.character_prompt_interactions
                            )
                          };
                        })}
                      />
                    </label>
                  ))}
                </div>

                <div style={sceneEditorSectionStyle}>
                  <div style={{ display: 'grid', gap: '4px' }}>
                    <h3 style={{ fontSize: '0.95rem', margin: 0 }}>派生 Prompt 上下文</h3>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      这些字段由 Prompt 生成阶段继续扩写，保留可手改入口，但不再作为主场景卡核心字段。
                    </div>
                  </div>
                  {[
                    'environment',
                    'cinematography',
                    'interactions',
                    'plot_traces',
                    'text_elements',
                    'must_show',
                    'must_not_show'
                  ].every((field) => !String(sceneEditor.draft[field] || '').trim()) && (
                    <div style={{
                      fontSize: '0.8rem',
                      color: 'var(--text-muted)',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      border: '1px dashed rgba(148, 163, 184, 0.24)',
                      background: 'rgba(255,255,255,0.02)'
                    }}>
                      轻量场景卡已变更，这部分派生上下文已清空，等待重新生成或手动补充。
                    </div>
                  )}
                  {[
                    ['environment', 'Environment', 2],
                    ['cinematography', 'Cinematography', 2],
                    ['interactions', 'Interactions', 2],
                    ['plot_traces', 'Plot Traces', 2],
                    ['text_elements', 'Text Elements', 2],
                    ['must_show', 'Must Show', 2],
                    ['must_not_show', 'Must Not Show', 2]
                  ].map(([field, label, rows]) => (
                    <label key={field} style={sceneEditorLabelStyle}>
                      {label}
                      <AutoResizeTextarea style={sceneEditorTextareaStyle} minRows={rows} value={sceneEditor.draft[field]} onChange={(e) => updateSceneDraft(draft => ({ ...draft, [field]: e.target.value }))} />
                    </label>
                  ))}
                </div>

                <div style={{ ...sceneEditorSectionStyle }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '0.95rem' }}>Characters</h3>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.75rem', borderRadius: '999px' }}
                    onClick={() => updateSceneDraft(draft => ({
                      ...draft,
                      characters: [...draft.characters, { name: '', gender: 'unknown', appearance: '', clothing: '', expression: '', pose: '', position: '' }],
                      character_prompt_interactions: [...(draft.character_prompt_interactions || []), []]
                    }))}
                  >
                    <Plus size={12} /> 添加角色
                  </button>
                </div>

                {(sceneEditor.draft.characters || []).map((character, index) => (
                  <div key={`character-${index}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '12px', display: 'grid', gap: '8px', background: 'rgba(5, 8, 20, 0.28)' }}>
                    {(() => {
                      const detailKey = `${sceneEditor.chapterKey}:${sceneEditor.sceneIdx}:${index}`;
                      const hasDetails = characterHasSceneDetails(character);
                      const isExpanded = hasDetails || expandedSceneCharacterDetails[detailKey] === true;
                      const dnaReference = buildCharacterReferenceSummary(characters?.[character.name] || null);
                      return (
                        <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: '0.85rem' }}>角色 {index + 1}</strong>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {!hasDetails && (
                          <button
                            type="button"
                            className="btn-secondary"
                            style={{ padding: '4px 8px', fontSize: '0.72rem', borderRadius: '999px' }}
                            onClick={() => setExpandedSceneCharacterDetails(prev => ({ ...prev, [detailKey]: !prev[detailKey] }))}
                          >
                            {isExpanded ? '收起细节' : '补充细节'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '0.72rem', color: '#fca5a5', borderRadius: '999px' }}
                          onClick={() => updateSceneDraft(draft => ({
                            ...draft,
                            characters: draft.characters.filter((_, itemIndex) => itemIndex !== index),
                            character_prompt_interactions: (draft.character_prompt_interactions || []).filter((_, itemIndex) => itemIndex !== index)
                          }))}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: '8px' }}>
                      <input style={sceneEditorInputStyle} placeholder="姓名" value={character.name} onChange={(e) => updateSceneDraft(draft => ({ ...draft, characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, name: e.target.value } : item) }))} />
                      <input style={sceneEditorInputStyle} placeholder="gender" value={character.gender} onChange={(e) => updateSceneDraft(draft => ({ ...draft, characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, gender: e.target.value } : item) }))} />
                    </div>
                    <label style={{ ...sceneEditorLabelStyle, gap: '6px' }}>
                      <span>Interactions (一行一个，`role | action | target`)</span>
                      <AutoResizeTextarea
                        style={sceneEditorTextareaStyle}
                        minRows={2}
                        placeholder={'source | penis_in_vagina | Cindy\ntarget | fingering | 阿宾'}
                        value={formatSceneCharacterInteractionLines(sceneEditor.draft.character_prompt_interactions?.[index])}
                        onChange={(e) => updateSceneDraft(draft => ({
                          ...draft,
                          character_prompt_interactions: (draft.character_prompt_interactions || []).map((item, itemIndex) => (
                            itemIndex === index ? parseSceneCharacterInteractionLines(e.target.value) : item
                          ))
                        }))}
                      />
                    </label>
                    {!isExpanded && (
                      <div style={{
                        display: 'grid',
                        gap: '6px',
                        padding: '10px 12px',
                        borderRadius: '10px',
                        border: '1px dashed rgba(148, 163, 184, 0.2)',
                        background: 'rgba(255,255,255,0.02)'
                      }}>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          轻量场景卡当前只保留角色名。角色细节会在 Prompt 生成阶段继续补全。
                        </div>
                        {dnaReference && (
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                            <strong style={{ color: 'white', fontSize: '0.78rem' }}>DNA参考：</strong> {dnaReference}
                          </div>
                        )}
                        {normalizeSceneCharacterInteractionList(sceneEditor.draft.character_prompt_interactions?.[index]).length > 0 && (
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            <strong style={{ color: 'white', fontSize: '0.78rem' }}>Interaction：</strong>{' '}
                            {normalizeSceneCharacterInteractionList(sceneEditor.draft.character_prompt_interactions?.[index])
                              .map(({ role, action, target }) => [role, action, target].filter(Boolean).join(' / '))
                              .join(' ; ')}
                          </div>
                        )}
                      </div>
                    )}
                    {isExpanded && SCENE_CHARACTER_DETAIL_FIELDS.map(field => (
                      <input
                        key={field}
                        style={sceneEditorInputStyle}
                        placeholder={field}
                        value={character[field]}
                        onChange={(e) => updateSceneDraft(draft => ({ ...draft, characters: draft.characters.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: e.target.value } : item) }))}
                      />
                    ))}
                        </>
                      );
                    })()}
                  </div>
                ))}
                </div>

                <div style={{ ...sceneEditorSectionStyle }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '0.95rem' }}>Visual Entities</h3>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '0.75rem', borderRadius: '999px' }}
                    onClick={() => updateSceneDraft(draft => ({
                      ...draft,
                      visual_entities: [...draft.visual_entities, { type: 'object', description: '', count: 1, position: '', must_show: true }]
                    }))}
                  >
                    <Plus size={12} /> 添加实体
                  </button>
                </div>

                {(sceneEditor.draft.visual_entities || []).map((entity, index) => (
                  <div key={`entity-${index}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '12px', display: 'grid', gap: '8px', background: 'rgba(5, 8, 20, 0.28)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 120px auto', gap: '8px', alignItems: 'center' }}>
                      <input style={sceneEditorInputStyle} placeholder="type" value={entity.type} onChange={(e) => updateSceneDraft(draft => ({ ...draft, visual_entities: draft.visual_entities.map((item, itemIndex) => itemIndex === index ? { ...item, type: e.target.value } : item) }))} />
                      <input style={sceneEditorInputStyle} type="number" min="1" placeholder="count" value={entity.count} onChange={(e) => updateSceneDraft(draft => ({ ...draft, visual_entities: draft.visual_entities.map((item, itemIndex) => itemIndex === index ? { ...item, count: e.target.value } : item) }))} />
                      <input style={sceneEditorInputStyle} placeholder="position" value={entity.position} onChange={(e) => updateSceneDraft(draft => ({ ...draft, visual_entities: draft.visual_entities.map((item, itemIndex) => itemIndex === index ? { ...item, position: e.target.value } : item) }))} />
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '0.72rem', color: '#fca5a5', borderRadius: '999px' }}
                        onClick={() => updateSceneDraft(draft => ({
                          ...draft,
                          visual_entities: draft.visual_entities.filter((_, itemIndex) => itemIndex !== index)
                        }))}
                      >
                        删除
                      </button>
                    </div>
                    <AutoResizeTextarea style={sceneEditorTextareaStyle} minRows={2} placeholder="description" value={entity.description} onChange={(e) => updateSceneDraft(draft => ({ ...draft, visual_entities: draft.visual_entities.map((item, itemIndex) => itemIndex === index ? { ...item, description: e.target.value } : item) }))} />
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      <input type="checkbox" checked={entity.must_show !== false} onChange={(e) => updateSceneDraft(draft => ({ ...draft, visual_entities: draft.visual_entities.map((item, itemIndex) => itemIndex === index ? { ...item, must_show: e.target.checked } : item) }))} />
                      must_show
                    </label>
                  </div>
                ))}
                </div>

                <div style={sceneEditorSectionStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ fontSize: '0.95rem' }}>Saved Prompt Params</h3>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ padding: '4px 10px', fontSize: '0.75rem', borderRadius: '999px' }}
                      onClick={() => {
                        const parts = [
                          sceneEditor.draft.base_prompt && `Base Prompt:\n${sceneEditor.draft.base_prompt}`,
                          sceneEditor.draft.character_prompts && `Character Prompts:\n${sceneEditor.draft.character_prompts}`,
                          sceneEditor.draft.negative_character_prompts && `Character Negative Prompts:\n${sceneEditor.draft.negative_character_prompts}`,
                          sceneEditor.draft.final_negative && `Final Negative:\n${sceneEditor.draft.final_negative}`
                        ].filter(Boolean);
                        navigator.clipboard.writeText(parts.join('\n\n'));
                        addLog(`📋 已复制场景 #${sceneEditor.sceneIdx} 完整生图参数到剪贴板！`, 'success');
                      }}
                    >
                      <Copy size={12} /> 复制参数
                    </button>
                  </div>
                  {[
                    ['base_prompt', 'Base Prompt', 4],
                    ['character_prompts', 'Character Prompts (一行一个)', 4],
                    ['negative_character_prompts', 'Character Negative Prompts (一行一个)', 4],
                    ['final_negative', 'Final Negative', 3]
                  ].map(([field, label, rows]) => (
                    <label key={field} style={sceneEditorLabelStyle}>
                      {label}
                      <AutoResizeTextarea style={sceneEditorTextareaStyle} minRows={rows} value={sceneEditor.draft[field]} onChange={(e) => updateSceneDraft(draft => ({ ...draft, [field]: e.target.value }))} />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '14px', flexShrink: 0 }}>
              <button className="btn-secondary" onClick={closeSceneEditor}>关闭</button>
              <button className="btn-primary" onClick={saveSceneEditor} disabled={savingScene}>
                {savingScene ? '保存中...' : '保存场景卡'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. 全局配置弹窗 */}
      {isConfigOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: configTab === 'prompts' ? '800px' : '920px', width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexShrink: 0 }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Settings size={20} /> 全局 API 配置</h2>
              <button className="btn-secondary" style={{ padding: '6px' }} onClick={() => setIsConfigOpen(false)}>
                <X size={16} />
              </button>
            </div>
            
            {/* Tab 选项卡 */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '10px', flexShrink: 0 }}>
              <button 
                type="button" 
                className={`btn-secondary ${configTab === 'basic' ? 'active' : ''}`}
                style={{ background: configTab === 'basic' ? 'var(--color-pink)' : 'transparent', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', transition: 'all 0.2s' }}
                onClick={() => setConfigTab('basic')}
              >
                基本接口设置
              </button>
              <button 
                type="button" 
                className={`btn-secondary ${configTab === 'prompts' ? 'active' : ''}`}
                style={{ background: configTab === 'prompts' ? 'var(--color-pink)' : 'transparent', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', transition: 'all 0.2s' }}
                onClick={() => setConfigTab('prompts')}
              >
                系统 Prompt 配置
              </button>
            </div>

            <form onSubmit={saveConfig} style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
              {configTab === 'basic' ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '4px', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '12px', background: 'rgba(255,255,255,0.015)' }}>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 'bold' }}>API 预设与一键载入</label>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <select
                        value=""
                        onChange={(e) => {
                          const presetId = e.target.value;
                          if (!presetId) return;
                          const preset = normalizePreset((config.llm_api_presets || []).find(p => p.id === presetId));
                          if (preset) {
                            setConfig({
                              ...config,
                              llm_preset_id: preset.id,
                              llm_url: preset.url,
                              llm_key: preset.key,
                              llm_model: preset.model,
                              llm_rate_limit_enabled: preset.rateLimitEnabled !== false,
                              llm_rate_limit_rpm: Number(preset.rateLimitRpm) || 3
                            });
                          }
                          // 重置下拉菜单选择
                          e.target.value = "";
                        }}
                        style={{ flex: 1, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', cursor: 'pointer', outline: 'none' }}
                      >
                        <option value="">-- 选择并载入已保存的 API 预设 --</option>
                        {(config.llm_api_presets || []).map(preset => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name} ({preset.model})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          const name = prompt("请输入此 API 预设的名称：");
                          if (!name || !name.trim()) return;
                          const newPreset = {
                            id: Date.now().toString(),
                            name: name.trim(),
                            url: config.llm_url || "",
                            key: config.llm_key || "",
                            model: config.llm_model || "",
                            rateLimitEnabled: config.llm_rate_limit_enabled !== false,
                            rateLimitRpm: Number(config.llm_rate_limit_rpm) || 3
                          };
                          const presets = [...(config.llm_api_presets || []), newPreset];
                          setConfig({ ...config, llm_api_presets: presets });
                        }}
                        style={{ whiteSpace: 'nowrap', padding: '8px 12px', fontSize: '0.8rem', cursor: 'pointer' }}
                      >
                        保存当前
                      </button>
                      {(config.llm_api_presets || []).length > 0 && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            const presets = config.llm_api_presets || [];
                            const selectToDelete = prompt("请输入要删除的预设名称 (或输入 'all' 清空所有)：");
                            if (!selectToDelete || !selectToDelete.trim()) return;
                            if (selectToDelete.trim().toLowerCase() === 'all') {
                              if (confirm("确定要清空所有的 API 预设吗？")) {
                                setConfig({ ...config, llm_api_presets: [] });
                              }
                              return;
                            }
                            const updated = presets.filter(p => p.name !== selectToDelete.trim());
                            if (updated.length === presets.length) {
                              alert("没有找到该预设！");
                            } else {
                              setConfig({ ...config, llm_api_presets: updated });
                            }
                          }}
                          style={{ whiteSpace: 'nowrap', padding: '8px 12px', fontSize: '0.8rem', cursor: 'pointer', color: '#ff4d4f' }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                  {(config.llm_api_presets || []).length > 0 && (
                    <div style={{ display: 'grid', gap: '8px', marginTop: '-2px' }}>
                      {(config.llm_api_presets || []).map(rawPreset => {
                        const preset = normalizePreset(rawPreset);
                        return (
                          <div key={preset.id} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '10px', background: 'rgba(0,0,0,0.18)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '8px', alignItems: 'center' }}>
                              <div style={{ color: 'white', fontSize: '0.85rem', fontWeight: 600 }}>
                                {preset.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({preset.model || '未填模型'})</span>
                              </div>
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => {
                                  setConfig({
                                    ...config,
                                    llm_preset_id: preset.id,
                                    llm_url: preset.url || "",
                                    llm_key: preset.key || "",
                                    llm_model: preset.model || "",
                                    llm_rate_limit_enabled: preset.rateLimitEnabled !== false,
                                    llm_rate_limit_rpm: Number(preset.rateLimitRpm) || 3
                                  });
                                }}
                                style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                              >
                                载入为默认
                              </button>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '10px', alignItems: 'end' }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                                <input
                                  type="checkbox"
                                  checked={preset.rateLimitEnabled !== false}
                                  onChange={(e) => setConfig(prev => ({
                                    ...prev,
                                    llm_api_presets: (prev.llm_api_presets || []).map(item => item.id === preset.id ? {
                                      ...item,
                                      rateLimitEnabled: e.target.checked
                                    } : item)
                                  }))}
                                />
                                启用 3 RPM / 自定义 RPM 限流
                              </label>
                              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                RPM
                                <input
                                  type="number"
                                  min="1"
                                  max="120"
                                  step="1"
                                  value={Number(preset.rateLimitRpm) || 3}
                                  onChange={(e) => setConfig(prev => ({
                                    ...prev,
                                    llm_api_presets: (prev.llm_api_presets || []).map(item => item.id === preset.id ? {
                                      ...item,
                                      rateLimitRpm: Number(e.target.value) || 3
                                    } : item)
                                  }))}
                                  style={{ width: '100%', marginTop: '4px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '7px 8px', color: 'white' }}
                                />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>LLM Base URL</label>
                    <input 
                      type="text" 
                      value={config.llm_url}
                      onChange={(e) => setConfig({ ...config, llm_preset_id: "", llm_url: e.target.value })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>LLM API Key</label>
                    <input 
                      type="password" 
                      value={config.llm_key}
                      onChange={(e) => setConfig({ ...config, llm_preset_id: "", llm_key: e.target.value })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>LLM Model</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input 
                        type="text" 
                        list="llm-models-datalist"
                        value={config.llm_model}
                        onChange={(e) => setConfig({ ...config, llm_preset_id: "", llm_model: e.target.value })}
                        style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                        placeholder="例如: deepseek-chat"
                      />
                      <button 
                        type="button" 
                        className="btn-secondary" 
                        onClick={() => fetchModels('default')}
                        disabled={isLoadingModels.default}
                        style={{ whiteSpace: 'nowrap', padding: '0 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        {isLoadingModels.default ? <RefreshCw size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {isLoadingModels.default ? "获取中..." : "获取模型"}
                      </button>
                    </div>
                    <datalist id="llm-models-datalist">
                      {(availableModels.default || []).map(model => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                    {modelError.default && (
                      <div style={{ color: 'var(--color-pink)', fontSize: '0.75rem', marginTop: '4px' }}>
                        {modelError.default}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: '10px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.85rem', border: '1px solid var(--border-light)', borderRadius: '8px', padding: '10px 12px' }}>
                      <input
                        type="checkbox"
                        checked={config.llm_stream_enabled !== false}
                        onChange={(e) => setConfig({ ...config, llm_stream_enabled: e.target.checked })}
                      />
                      LLM 使用流式输出
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: '0.78rem', color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '8px', padding: '10px 12px', background: 'rgba(255,255,255,0.015)' }}>
                      关闭后改用普通 JSON 响应，请求日志不再逐字流出。
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: '10px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.85rem', border: '1px solid var(--border-light)', borderRadius: '8px', padding: '10px 12px' }}>
                      <input
                        type="checkbox"
                        checked={config.llm_rate_limit_enabled !== false}
                        onChange={(e) => setConfig({ ...config, llm_preset_id: "", llm_rate_limit_enabled: e.target.checked })}
                      />
                      默认连接启用 RPM 限流
                    </label>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>默认连接 RPM</label>
                      <input
                        type="number"
                        min="1"
                        max="120"
                        step="1"
                        value={config.llm_rate_limit_rpm ?? 3}
                        onChange={(e) => setConfig({ ...config, llm_preset_id: "", llm_rate_limit_rpm: Number(e.target.value) || 3 })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                    </div>
                  </div>
                  <div className="llm-routing-panel">
                    <div className="llm-routing-panel__intro">
                      <div>
                        <strong>任务级 LLM 路由</strong>
                        <p>每个任务可使用独立 API、Key 和模型；留空时自动回退到上方默认连接。</p>
                      </div>
                      <button type="button" className="btn-secondary" onClick={copyDefaultLlmToAllTasks}>
                        <Copy size={14} /> 一键带入全部
                      </button>
                    </div>
                    {renderTaskLlmCard('characterDna', '角色 DNA', '提取和更新人物外貌、别名与稳定特征', '#22c55e')}
                    {renderTaskLlmCard('scene', '场景生成', '章节分镜提取与单场景描述重构', '#38bdf8')}
                    {renderTaskLlmCard('naiTags', '生图 Prompt', '把分镜与角色 DNA 转换为 V4.5 自然语言生图参数', '#c084fc')}
                    {renderTaskLlmCard('trim', 'Prompt 精简', '单词粘连修复与超额预算精简（推荐轻量快速模型）', '#f59e0b')}
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>NovelAI Token (pst-开头)</label>
                    <input 
                      type="password" 
                      value={config.nai_token}
                      onChange={(e) => setConfig({ ...config, nai_token: e.target.value })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>NovelAI Base URL</label>
                    <input 
                      type="text" 
                      value={config.nai_url}
                      onChange={(e) => setConfig({ ...config, nai_url: e.target.value })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>NovelAI Model</label>
                    <input
                      type="text"
                      value={config.nai_model}
                      onChange={(e) => setConfig({ ...config, nai_model: e.target.value })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>网络代理地址 (Proxy)</label>
                    <input
                      type="text"
                      placeholder="例如 http://127.0.0.1:7890"
                      value={config.proxy_url || ""}
                      onChange={(e) => setConfig({ ...config, proxy_url: e.target.value })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      如国内连接 NovelAI 官方生图接口超时，请在此处填写本地代理地址。
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>基础生图间隔（秒）</label>
                    <input
                      type="number"
                      min="1"
                      max="120"
                      step="1"
                      value={config.nai_cooldown_seconds ?? 15}
                      onChange={(e) => setConfig({ ...config, nai_cooldown_seconds: Number(e.target.value) })}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                    />
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      默认 15 秒；连续 3 次 429 后自动固定为 35 秒，连续成功 5 次后恢复此间隔。
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Steps</label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={config.steps ?? 28}
                        onChange={(e) => setConfig({ ...config, steps: Number(e.target.value) })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Prompt Guidance / Scale</label>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        step="0.1"
                        value={config.scale ?? 5.5}
                        onChange={(e) => setConfig({ ...config, scale: Number(e.target.value) })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>中文分镜字数除数</label>
                      <input
                        type="number"
                        min="100"
                        max="5000"
                        value={config.cjk_scene_divisor ?? 600}
                        onChange={(e) => setConfig({ ...config, cjk_scene_divisor: Number(e.target.value) })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>当前按每 {config.cjk_scene_divisor ?? 600} 字生成一个分镜，默认 600</div>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>英文分镜词数除数</label>
                      <input
                        type="number"
                        min="50"
                        max="3000"
                        value={config.english_scene_divisor ?? 350}
                        onChange={(e) => setConfig({ ...config, english_scene_divisor: Number(e.target.value) })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>当前按每 {config.english_scene_divisor ?? 350} 词生成一个分镜，默认 350</div>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>单次提炼最多场景数</label>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={config.max_scenes_per_request ?? 5}
                        onChange={(e) => setConfig({ ...config, max_scenes_per_request: Math.max(1, Math.min(20, Number(e.target.value) || 5)) })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>单次请求上限（默认 5），超限自动切片分批提炼</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Sampler</label>
                      <input
                        type="text"
                        value={config.sampler || "k_euler_ancestral"}
                        onChange={(e) => setConfig({ ...config, sampler: e.target.value })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>Noise Schedule</label>
                      <input
                        type="text"
                        value={config.noiseSchedule || "karras"}
                        onChange={(e) => setConfig({ ...config, noiseSchedule: e.target.value })}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                      />
                    </div>
                  </div>
                  <div style={{ border: '1px solid rgba(168,85,247,0.25)', borderRadius: '8px', padding: '12px', background: 'rgba(168,85,247,0.04)' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(config.useVibeTransfer)}
                        onChange={(e) => setConfig({ ...config, useVibeTransfer: e.target.checked })}
                      />
                      启用 Vibe Transfer Bundle
                    </label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Bundle 路径（相对项目根目录）</label>
                        <input
                          type="text"
                          value={config.vibeBundlePath || "2026-06-04.naiv4vibebundle"}
                          onChange={(e) => setConfig({ ...config, vibeBundlePath: e.target.value })}
                          style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                        />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Reference Strength</label>
                          <input
                            type="number"
                            min="0"
                            max="1"
                            step="0.05"
                            value={config.vibeStrength ?? 0.45}
                            onChange={(e) => setConfig({ ...config, vibeStrength: Number(e.target.value) })}
                            style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Information Extracted</label>
                          <input
                            type="number"
                            min="0"
                            max="1"
                            step="0.05"
                            value={config.vibeInfoExtracted ?? 1.0}
                            onChange={(e) => setConfig({ ...config, vibeInfoExtracted: Number(e.target.value) })}
                            style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white' }}
                          />
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        <input
                          type="checkbox"
                          checked={config.vibeNormalizeStrengths !== false}
                          onChange={(e) => setConfig({ ...config, vibeNormalizeStrengths: e.target.checked })}
                        />
                        多 Vibe 时自动归一化强度总和
                      </label>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {(() => {
                    const handleResetPrompt = async (promptField, promptLabel) => {
                      try {
                        const res = await fetch(`${API_BASE}/api/config/default-prompts`);
                        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
                        const defaults = await res.json();
                        if (defaults && defaults[promptField]) {
                          setConfig(prev => ({ ...prev, [promptField]: defaults[promptField] }));
                          alert(`已恢复【${promptLabel}】为官方最新默认提示词！请点击弹窗下方的「保存设置」生效。`);
                        }
                      } catch (err) {
                        alert(`获取默认提示词失败: ${err.message}`);
                      }
                    };

                    return (
                      <>
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' }}>1. 分镜场景提取 System Prompt</label>
                            <button
                              type="button"
                              className="btn-secondary"
                              style={{ padding: '2px 8px', fontSize: '0.72rem', color: '#c084fc', display: 'flex', alignItems: 'center', gap: '4px' }}
                              onClick={() => handleResetPrompt('system_prompt_extract_scenes', '分镜场景提取')}
                              title="恢复最新官方默认提示词"
                            >
                              <RefreshCw size={11} /> 恢复官方默认
                            </button>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>用于将小说章节正文切分并提炼为 5-10 个中文分镜描述卡片</div>
                          <textarea 
                            value={config.system_prompt_extract_scenes || ""}
                            onChange={(e) => setConfig({ ...config, system_prompt_extract_scenes: e.target.value })}
                            style={{ width: '100%', height: '170px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                          />
                        </div>

                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' }}>2. 角色设定 DNA 提取 System Prompt</label>
                            <button
                              type="button"
                              className="btn-secondary"
                              style={{ padding: '2px 8px', fontSize: '0.72rem', color: '#c084fc', display: 'flex', alignItems: 'center', gap: '4px' }}
                              onClick={() => handleResetPrompt('system_prompt_character_dna', '角色设定 DNA 提取（含同人脸模代理）')}
                              title="恢复最新官方默认提示词（包含同人脸模代理协议）"
                            >
                              <RefreshCw size={11} /> 恢复官方默认 (含同人脸模)
                            </button>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>用于智能扫描全书主要人物，提取常驻的发型、瞳色、服装与同人脸模代理等固有 DNA 特征</div>
                          <textarea 
                            value={config.system_prompt_character_dna || ""}
                            onChange={(e) => setConfig({ ...config, system_prompt_character_dna: e.target.value })}
                            style={{ width: '100%', height: '170px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                          />
                        </div>

                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' }}>3. 高级生图参数生成 System Prompt（Danbooru 标签版）</label>
                            <button
                              type="button"
                              className="btn-secondary"
                              style={{ padding: '2px 8px', fontSize: '0.72rem', color: '#c084fc', display: 'flex', alignItems: 'center', gap: '4px' }}
                              onClick={() => handleResetPrompt('system_prompt_advanced_prompt', '高级生图参数生成')}
                              title="恢复最新官方默认提示词"
                            >
                              <RefreshCw size={11} /> 恢复官方默认
                            </button>
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                            这是后端实际使用的底稿字段。保存后会写入 `illustrator_config.json` 并热更新运行中的 pipeline；后端会在此基础上补运行时 contract 与校验规则，再按 base | character 分段发给 NAI。
                          </div>
                          <textarea 
                            value={config.system_prompt_advanced_prompt || ""}
                            onChange={(e) => setConfig({ ...config, system_prompt_advanced_prompt: e.target.value })}
                            style={{ width: '100%', height: '200px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(168,85,247,0.35)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                          />
                        </div>
                      </>
                    );
                  })()}
                  {(() => {
                    const allArtistPresets = [...BUILTIN_ARTIST_PRESETS, ...(config.artist_presets || [])];
                    const matchedPreset = allArtistPresets.find(p => (p.prompt || '').trim() === (config.artistStylePrompt || '').trim());
                    const currentPresetId = matchedPreset ? matchedPreset.id : 'custom';
                    const isCustomSaved = (config.artist_presets || []).some(p => p.id === currentPresetId);

                    const handlePresetChange = (presetId) => {
                      if (presetId === 'custom') return;
                      const p = allArtistPresets.find(item => item.id === presetId);
                      if (p) {
                        setConfig({ ...config, artistStylePrompt: p.prompt });
                      }
                    };

                    const handleSavePreset = () => {
                      const name = (newArtistPresetName || '').trim();
                      if (!name) {
                        alert('请输入预设名称！');
                        return;
                      }
                      const currentPrompt = (config.artistStylePrompt || '').trim();
                      if (!currentPrompt) {
                        alert('画师/风格 Prompt 串不能为空！');
                        return;
                      }
                      const newPreset = {
                        id: 'custom_' + Date.now(),
                        name,
                        desc: '自定义画风预设',
                        prompt: currentPrompt
                      };
                      setConfig({
                        ...config,
                        artist_presets: [...(config.artist_presets || []), newPreset]
                      });
                      setNewArtistPresetName('');
                      addLog(`已保存新画风预设: ${name}`);
                    };

                    const handleDeletePreset = (idToDelete) => {
                      const found = (config.artist_presets || []).find(p => p.id === idToDelete);
                      if (!found) return;
                      if (!window.confirm(`确定要删除画风预设「${found.name}」吗？`)) return;
                      const updated = (config.artist_presets || []).filter(p => p.id !== idToDelete);
                      setConfig({
                        ...config,
                        artist_presets: updated,
                        artistStylePrompt: BUILTIN_ARTIST_PRESETS[0].prompt
                      });
                      addLog(`已删除画风预设: ${found.name}`);
                    };

                    return (
                      <div style={{ marginTop: '14px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '8px' }}>
                          <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '500' }}>
                            4. NovelAI 画师 / 风格 Prompt 串
                          </label>
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <select
                              value={currentPresetId}
                              onChange={(e) => handlePresetChange(e.target.value)}
                              style={{
                                background: 'rgba(20, 20, 32, 0.9)',
                                border: '1px solid rgba(168, 85, 247, 0.45)',
                                color: '#e2e8f0',
                                borderRadius: '6px',
                                padding: '4px 8px',
                                fontSize: '0.8rem',
                                outline: 'none',
                                cursor: 'pointer',
                                maxWidth: '280px'
                              }}
                            >
                              <optgroup label="内置核心画风配方">
                                {BUILTIN_ARTIST_PRESETS.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </optgroup>
                              {(config.artist_presets && config.artist_presets.length > 0) && (
                                <optgroup label="自定义已存画风">
                                  {config.artist_presets.map(p => (
                                    <option key={p.id} value={p.id}>★ {p.name}</option>
                                  ))}
                                </optgroup>
                              )}
                              <option value="custom">✨ 自定义（自由编辑）</option>
                            </select>

                            {isCustomSaved && (
                              <button
                                type="button"
                                onClick={() => handleDeletePreset(currentPresetId)}
                                title="删除当前自定义预设"
                                style={{
                                  background: 'rgba(239, 68, 68, 0.2)',
                                  border: '1px solid rgba(239, 68, 68, 0.4)',
                                  color: '#f87171',
                                  padding: '4px 8px',
                                  borderRadius: '5px',
                                  fontSize: '0.75rem',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px'
                                }}
                              >
                                <Trash2 size={12} /> 删除
                              </button>
                            )}
                          </div>
                        </div>

                        {/* 预设说明徽章 */}
                        <div style={{
                          fontSize: '0.75rem',
                          color: matchedPreset ? 'rgba(192, 132, 252, 0.95)' : 'var(--text-muted)',
                          marginBottom: '6px',
                          background: matchedPreset ? 'rgba(168, 85, 247, 0.1)' : 'transparent',
                          padding: matchedPreset ? '4px 8px' : '0',
                          borderRadius: '4px',
                          display: 'inline-block'
                        }}>
                          {matchedPreset ? `💡 ${matchedPreset.desc}` : '✏️ 自定义自由编辑：可在下方编辑 Prompt，并支持保存为新的可选项'}
                        </div>

                        <textarea
                          value={config.artistStylePrompt || ""}
                          onChange={(e) => setConfig({ ...config, artistStylePrompt: e.target.value })}
                          placeholder="例如：2.0::artist:name ::, 1.2::cinematic lighting ::"
                          spellCheck={false}
                          style={{
                            width: '100%',
                            height: '110px',
                            background: 'rgba(0,0,0,0.25)',
                            border: '1px solid rgba(168,85,247,0.4)',
                            borderRadius: '6px',
                            padding: '8px',
                            color: 'white',
                            fontFamily: 'monospace',
                            fontSize: '0.8rem',
                            lineHeight: '1.4',
                            resize: 'vertical'
                          }}
                        />

                        {/* 存为新预设栏 */}
                        <div style={{
                          marginTop: '8px',
                          display: 'flex',
                          gap: '8px',
                          alignItems: 'center',
                          background: 'rgba(255,255,255,0.03)',
                          padding: '6px 8px',
                          borderRadius: '6px',
                          border: '1px dashed rgba(168,85,247,0.3)'
                        }}>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', flexShrink: 0 }}>保存为新预设：</span>
                          <input
                            type="text"
                            placeholder="输入预设名称（如：我的浪漫古风）..."
                            value={newArtistPresetName}
                            onChange={(e) => setNewArtistPresetName(e.target.value)}
                            style={{
                              flex: 1,
                              background: 'rgba(0,0,0,0.3)',
                              border: '1px solid rgba(255,255,255,0.15)',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              color: '#fff',
                              fontSize: '0.78rem',
                              outline: 'none'
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleSavePreset}
                            style={{
                              background: 'rgba(168, 85, 247, 0.25)',
                              border: '1px solid rgba(168, 85, 247, 0.5)',
                              color: '#c084fc',
                              padding: '4px 10px',
                              borderRadius: '4px',
                              fontSize: '0.78rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              flexShrink: 0
                            }}
                          >
                            <Plus size={13} /> 存为选项
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
              
              <button className="btn-primary" type="submit" style={{ marginTop: '10px', justifyContent: 'center', flexShrink: 0 }}>
                保存设置
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 5. 创建项目弹窗 */}
      {isNewProjectOpen && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><Plus size={20} /> 创建新项目</h2>
              <button className="btn-secondary" style={{ padding: '6px' }} onClick={() => setIsNewProjectOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={createProject} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>从本地小说文件导入</label>
                <input 
                  type="file" 
                  accept=".txt,.docx,.epub"
                  onChange={handleFileUpload}
                  disabled={isParsing}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', cursor: isParsing ? 'not-allowed' : 'pointer' }}
                />
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {isParsing ? (
                    <span style={{ color: 'var(--color-orange)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <RefreshCw size={12} className="animate-spin" /> 正在智能解析小说文件，请稍候...
                    </span>
                  ) : (
                    "支持格式: .txt, .docx, .epub。系统会自动解析文件内容、划分章节并智能生成项目名称"
                  )}
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>小说项目名称</label>
                <input 
                  type="text" 
                  value={newProjName}
                  onChange={(e) => setNewProjName(e.target.value)}
                  disabled={isParsing}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', cursor: isParsing ? 'not-allowed' : 'auto' }}
                  placeholder="例如: 神话生物攻略手册"
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>小说文本内容 (book.txt)</label>
                <textarea 
                  rows={12}
                  value={newProjText}
                  onChange={(e) => setNewProjText(e.target.value)}
                  disabled={isParsing}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.85rem', cursor: isParsing ? 'not-allowed' : 'auto' }}
                  placeholder="请粘入完整小说文本..."
                  required
                />
              </div>
              <button 
                className="btn-primary" 
                type="submit" 
                disabled={isParsing} 
                style={{ marginTop: '10px', justifyContent: 'center', opacity: isParsing ? 0.6 : 1, cursor: isParsing ? 'not-allowed' : 'pointer' }}
              >
                {isParsing ? "正在解析文件..." : "导入并解析"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 删除项目确认弹窗 */}
      {deleteProjectPrompt && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '460px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><X size={20} /> 删除项目</h2>
              <button className="btn-secondary" style={{ padding: '6px' }} onClick={() => setDeleteProjectPrompt(null)}>
                <X size={16} />
              </button>
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '14px' }}>
              确定要删除项目「{deleteProjectPrompt.name}」吗？默认只从项目列表移除，并将项目目录移动到回收区。
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '18px' }}>
              <input
                type="checkbox"
                checked={deleteProjectFiles}
                onChange={(e) => setDeleteProjectFiles(e.target.checked)}
              />
              同时删除项目文件（不可恢复）
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button className="btn-secondary" onClick={() => setDeleteProjectPrompt(null)}>
                取消
              </button>
              <button className="btn-primary" onClick={confirmDeleteProject} style={{ background: 'var(--color-pink)' }}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. 图片大图预览弹窗 */}
      {previewImage && (
        <div className="modal-overlay" onClick={() => setPreviewImage(null)} style={{ zIndex: 1000, background: 'rgba(0,0,0,0.85)' }}>
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
            <button 
              className="btn-secondary" 
              style={{ position: 'absolute', top: '-40px', right: '0px', padding: '6px', color: 'white', border: 'none', background: 'rgba(255,255,255,0.1)' }}
              onClick={() => setPreviewImage(null)}
            >
              <X size={18} />
            </button>
            <img 
              src={previewImage} 
              decoding="async"
              alt="预览" 
              style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain', borderRadius: '8px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }} 
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
