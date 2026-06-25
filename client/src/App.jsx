import { useState, useEffect, useRef } from 'react';
import { 
  Settings, Plus, BookOpen, User, Play, Square, Download, 
  RefreshCw, CheckCircle2, Sparkles, X, FileText, Clapperboard, Timer,
  Copy, PanelLeftClose, PanelLeftOpen, Trash2, Pencil
} from 'lucide-react';
import { isSingleChapterGenerateDisabled } from './chapterQueueState.js';
import { isNaiLogMessage } from './logClassification.js';
import { mergeProjectProgressSnapshot } from './projectProgressState.js';
import {
  SCENE_CHARACTER_DETAIL_FIELDS,
  buildCharacterReferenceSummary,
  characterHasSceneDetails,
  syncSceneCharactersFromNames
} from './sceneEditorCharacters.js';

const API_BASE = import.meta.env.DEV ? "http://localhost:5001" : "";

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
    proxy_url: "",
    useVibeTransfer: false,
    vibeBundlePath: "2026-06-04.naiv4vibebundle",
    vibeStrength: 0.45,
    vibeInfoExtracted: 1.0,
    vibeNormalizeStrengths: true,
    nai_url: "https://image.novelai.net",
    artistStylePrompt: "",
    system_prompt_advanced_prompt_nl: ""
  });

  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState("");
  const [projectDetails, setProjectDetails] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [workspaceTab, setWorkspaceTab] = useState('scenes');
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
  const [editingCharacterName, setEditingCharacterName] = useState("");
  const [editingCharacterFeatures, setEditingCharacterFeatures] = useState(null);
  const [savingCharacterTags, setSavingCharacterTags] = useState(false);
  
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
      } else if (data.state === 'paused') {
        addLog(`⏸️ 单章「${data.chapterKey}」执行到需要更新角色 DNA，队列已暂停等待处理。`, 'warning');
      }
    });

    eventSource.addEventListener('characters_completed', (e) => {
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
    });

    eventSource.addEventListener('pipeline_failed', (e) => {
      const data = JSON.parse(e.data);
      if (data?.type === 'chapter_generate' && data.chapterKey) {
        addLog(`❌ 单章「${data.chapterKey}」重画异常中断: ${data.message}`, 'error');
      } else {
        addLog(`❌ 流水线发生异常中断: ${data.message}`, 'error');
      }
      setPipelineRunning(false);
    });

    eventSource.addEventListener('log', (e) => {
      const data = JSON.parse(e.data);
      addLog(data.text, data.type);
    });

    eventSource.addEventListener('error', (e) => {
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

  const addLog = (text, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    if (isNaiLogMessage(text)) {
      setNaiLogs(prev => [...prev, { time, text, type }].slice(-200));
    } else {
      setLogs(prev => [...prev, { time, text, type }].slice(-200));
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config`);
      const data = await res.json();
      setConfig({
        ...data,
        llm_rate_limit_enabled: data.llm_rate_limit_enabled !== false,
        llm_rate_limit_rpm: Number(data.llm_rate_limit_rpm) || 3,
        llm_api_presets: (data.llm_api_presets || []).map(normalizePreset)
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

  const selectProject = async (name) => {
    if (activeProject && selectedChapter && textSelections.length > 0) {
      const previousChapterKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
      saveReaderSelections(activeProject, previousChapterKey, textSelections);
    }
    setEditingCharacterName("");
    setEditingCharacterFeatures(null);
    closeSceneEditor();
    setActiveProject(name);
    addLog(`📂 载入项目: ${name}`);
    setSelectedChapter(null); // 切换项目时重置选中章节
    setTextSelections([]);
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
    if (!activeProject) return;
    try {
      const chapters = projectDetails?.chapters || [];
      const selectedIndex = selectedChapter
        ? chapters.findIndex(chap => chap.volume === selectedChapter.volume && chap.chapter === selectedChapter.chapter)
        : 0;
      const chapterIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const sliceIndex = Math.floor(chapterIndex / 10);
      const sliceStart = sliceIndex * 10;
      const sliceEnd = Math.min(sliceStart + 10, chapters.length || sliceStart + 10);

      addLog(`🧬 开始重建第 ${sliceStart + 1}-${sliceEnd} 章角色 DNA...`);
      const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/character-dna-slices/${sliceIndex}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuePipeline: false })
      });
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      } else {
        addLog(`重建角色 DNA 失败: ${data.error || '未知错误'}`, "error");
      }
    } catch (e) {
      addLog("提取角色 DNA 异常: " + e.message, "error");
    }
  };

  const updateDnaSliceAndContinue = async () => {
    if (!activeProject || !dnaUpdatePrompt) return;
    try {
      setPipelineRunning(true);
      addLog(`🧬 正在更新${dnaUpdatePrompt.sliceLabel}角色 DNA，完成后自动继续流水线...`);
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
        setPipelineRunning(false);
        addLog(`❌ 更新角色 DNA 失败: ${data.error || '未知错误'}`, 'error');
      }
    } catch (e) {
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
      addLog("⏹️ 正在发送停止指令...");
      const res = await fetch(`${API_BASE}/api/projects/${activeProject}/pipeline/stop`, {
        method: "POST"
      });
      const data = await res.json();
      if (data.success) {
        addLog(data.message);
      }
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
  const characters = projectDetails?.progress?.global_characters || {};
  const dnaFeatureOrder = [
    '外貌标签',
    '身材标签',
    '胸部标签',
    'NSFW标签',
    '发型标签',
    '发色标签',
    '眼睛标签',
    '肤色标签',
    '年龄感标签',
    '服装基底标签',
    '特殊特征标签'
  ];

  const emptyCharacterFeatures = () => Object.fromEntries(dnaFeatureOrder.map(key => [key, '']));

  const normalizeFeatureText = (value) => (
    Array.isArray(value) ? value.join(', ') : String(value || '')
  );

  const featuresToEditorState = (features = {}) => (
    dnaFeatureOrder.reduce((acc, key) => {
      acc[key] = normalizeFeatureText(features?.[key]);
      return acc;
    }, emptyCharacterFeatures())
  );
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

    return {
      trigger_sentence: String(scene.trigger_sentence || ''),
      nsfw_rating: String(scene.nsfw_rating || 'sfw'),
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
      final_prompt: String(scene.final_prompt || scene.prepared_prompt?.finalPositive || ''),
      base_prompt: String(scene.base_prompt || scene.prepared_prompt?.basePrompt || ''),
      final_negative: String(scene.final_negative || scene.prepared_prompt?.finalNegative || ''),
      character_prompts: Array.isArray(scene.character_prompts || scene.prepared_prompt?.characterPrompts)
        ? (scene.character_prompts || scene.prepared_prompt?.characterPrompts).join('\n')
        : '',
      negative_character_prompts: Array.isArray(scene.negative_character_prompts || scene.prepared_prompt?.negativeCharacterPrompts)
        ? (scene.negative_character_prompts || scene.prepared_prompt?.negativeCharacterPrompts).join('\n')
        : '',
      width: scene.width || scene.prepared_prompt?.width || '',
      height: scene.height || scene.prepared_prompt?.height || '',
      characters: syncSceneCharactersFromNames(characterNamesText, normalizedCharacters, characters),
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
    final_prompt: String(draft.final_prompt || '').trim(),
    base_prompt: String(draft.base_prompt || '').trim(),
    final_negative: String(draft.final_negative || '').trim(),
    character_prompts: String(draft.character_prompts || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean),
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
      .filter(entity => entity.description)
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
      .map(key => [key, Array.isArray(features[key]) ? features[key].filter(Boolean) : []])
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
              placeholder="用逗号分隔"
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

  const startEditingCharacterTags = (name, tags = "") => {
    setEditingCharacterName(name);
    const character = characters[name] || {};
    setEditingCharacterFeatures(featuresToEditorState(character.features || {}));
  };

  const cancelEditingCharacterTags = () => {
    setEditingCharacterName("");
    setEditingCharacterFeatures(null);
  };

  const saveEditingCharacterTags = async () => {
    if (!activeProject || !editingCharacterName) return;
    setSavingCharacterTags(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/projects/${encodeURIComponent(activeProject)}/characters/${encodeURIComponent(editingCharacterName)}/features`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ features: editorStateToFeatures(editingCharacterFeatures) })
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '保存失败');
      addLog(`🧬 角色「${editingCharacterName}」结构化 DNA 已更新。`);
      cancelEditingCharacterTags();
      await fetchProjectDetails(activeProject);
    } catch (error) {
      addLog(`❌ 保存角色结构化 DNA 失败: ${error.message}`, 'error');
    } finally {
      setSavingCharacterTags(false);
    }
  };

  return (
    <div className={[
      'app-container',
      workspaceTab === 'reader' && projectDetails ? 'reader-mode' : '',
      isProjectSidebarCollapsed ? 'project-sidebar-collapsed' : ''
    ].filter(Boolean).join(' ')}>
      {isProjectSidebarCollapsed && !projectDetails && (
        <button
          className="sidebar-toggle sidebar-toggle-floating"
          type="button"
          title="展开书籍项目栏"
          aria-label="展开书籍项目栏"
          onClick={() => setIsProjectSidebarCollapsed(false)}
        >
          <PanelLeftOpen size={17} />
        </button>
      )}
      {/* 1. 左栏：项目概览与角色 DNA */}
      <div className="app-column project-sidebar">
        <div className="column-header">
          <h2><BookOpen size={18} /> 书籍项目</h2>
          <div className="sidebar-header-actions">
            <button
              className="sidebar-toggle"
              type="button"
              title="收起书籍项目栏"
              aria-label="收起书籍项目栏"
              onClick={() => setIsProjectSidebarCollapsed(true)}
            >
              <PanelLeftClose size={16} />
            </button>
            <button className="btn-secondary" style={{ padding: '6px' }} onClick={() => setIsNewProjectOpen(true)}>
              <Plus size={16} />
            </button>
          </div>
        </div>
        
        <div className="column-body" style={{ flex: '0 0 220px', marginBottom: '20px' }}>
          <div className="glass-panel" style={{ height: '100%', overflowY: 'auto', padding: '8px' }}>
            {projects.map(proj => (
              <div 
                key={proj.name}
                className={`project-card glass-panel ${activeProject === proj.name ? 'active' : ''}`}
                onClick={() => selectProject(proj.name)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ fontWeight: '500', fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proj.name}</div>
                  <button
                    className="btn-secondary"
                    title="删除项目"
                    onClick={(event) => requestDeleteProject(proj, event)}
                    style={{ padding: '3px', flexShrink: 0, borderColor: 'rgba(239,68,68,0.35)', color: 'var(--color-pink)' }}
                  >
                    <X size={12} />
                  </button>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  创建时间: {new Date(proj.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="column-header">
          <h2><User size={18} /> 角色 DNA 大辞典</h2>
          {activeProject && (
            <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={startExtractCharacters}>
              <RefreshCw size={12} style={{ marginRight: '4px' }} /> 重建本组
            </button>
          )}
        </div>

        <div className="column-body">
          <div className="glass-panel" style={{ height: '100%', overflowY: 'auto', padding: '12px' }}>
            {Object.keys(characters).length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', marginTop: '40px' }}>
                暂无提取的角色资料，点击上方开始智能分析提取 DNA 特征
              </div>
            ) : (
              Object.entries(characters).map(([name, data]) => (
                <div key={name} style={{ marginBottom: '14px', borderBottom: '1px solid rgba(255,255,255,0.03)', paddingBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ fontWeight: '500', fontSize: '0.9rem', color: 'var(--color-pink)' }}>{name}</div>
                    {editingCharacterName === name ? (
                      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                        <button
                          className="btn-secondary"
                          type="button"
                          onClick={saveEditingCharacterTags}
                          disabled={savingCharacterTags}
                          style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                        >
                          {savingCharacterTags ? '保存中' : '保存'}
                        </button>
                        <button
                          className="btn-secondary"
                          type="button"
                          onClick={cancelEditingCharacterTags}
                          disabled={savingCharacterTags}
                          style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn-secondary"
                        type="button"
                        onClick={() => startEditingCharacterTags(name)}
                        style={{ padding: '3px 8px', fontSize: '0.75rem', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Pencil size={11} /> 编辑结构化
                      </button>
                    )}
                  </div>
                  {(data.aliases?.length > 0 || data.confidence || data.source_chapters?.length > 0) && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                      {data.aliases?.length > 0 ? `别名: ${data.aliases.join(' / ')}` : ''}
                      {data.confidence ? `${data.aliases?.length > 0 ? ' · ' : ''}置信度: ${Number(data.confidence).toFixed(2)}` : ''}
                      {data.source_chapters?.length > 0 ? ` · 来源: ${data.source_chapters.slice(0, 3).join(' / ')}${data.source_chapters.length > 3 ? ' ...' : ''}` : ''}
                    </div>
                  )}
                  {editingCharacterName === name ? renderFeatureEditor() : renderDnaFeatures(data.features)}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 2. 中栏：章节选择与场景定格卡片流 */}
      <div className="app-column workbench">
        {projectDetails ? (
          <>
            <div className="column-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  className="sidebar-toggle"
                  type="button"
                  title={isProjectSidebarCollapsed ? '展开书籍项目栏' : '收起书籍项目栏'}
                  aria-label={isProjectSidebarCollapsed ? '展开书籍项目栏' : '收起书籍项目栏'}
                  aria-expanded={!isProjectSidebarCollapsed}
                  onClick={() => setIsProjectSidebarCollapsed(collapsed => !collapsed)}
                >
                  {isProjectSidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
                </button>
                <span style={{ fontSize: '1.1rem', fontWeight: '600' }}>{activeProject}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  ({progressInfo.completed} / {progressInfo.total} 章节已处理)
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-secondary" onClick={() => setIsConfigOpen(true)}>
                  <Settings size={16} /> 配置
                </button>
                {pipelineRunning ? (
                  <button className="btn-secondary" style={{ color: 'var(--color-orange)' }} onClick={stopPipeline}>
                    <Square size={16} /> 暂停
                  </button>
                ) : (
                  <button className="btn-primary" onClick={startPipeline}>
                    <Play size={16} /> 启动
                  </button>
                )}
                <button className="btn-secondary" onClick={exportEPUB}>
                  <Download size={16} /> 编译 EPUB
                </button>
              </div>
            </div>

            <div className="workspace-tabs" role="tablist" aria-label="项目工作区">
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
                      return (
                    <div className="glass-panel" style={{ padding: '16px', background: 'rgba(255,255,255,0.01)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <h3 style={{ fontSize: '1.2rem', marginBottom: '6px' }}>{selectedChapter.chapter}</h3>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          所属分卷: {selectedChapter.volume} | 全章字数: {selectedChapter.wordCount} 字
                        </div>
                      </div>
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
                            : '单章重画'}
                      </button>
                    </div>
                      );
                    })()}

                    {/* 渲染当前章节的场景卡片 */}
                    {(() => {
                      const chapKey = `${selectedChapter.volume}_${selectedChapter.chapter}`.replace(/\s+/g, '_');
                      const progress = getChapterProgress(selectedChapter.volume, selectedChapter.chapter);
                      const scenes = progress?.scenes || [];

                      if (scenes.length === 0) {
                        return (
                          <div className="glass-panel" style={{ padding: '40px', textLight: 'center', textAlign: 'center', color: 'var(--text-muted)' }}>
                            本章尚未提取生成场景卡片。启动生图流水线时，将自动为您分析提取 5-10 个高潮插画场景。
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
                            onClick={() => openSceneEditor(chapKey, scene)}
                            style={{
                              cursor: 'pointer',
                              border: sceneEditor?.chapterKey === chapKey && sceneEditor?.sceneIdx === scene.scene_idx
                                ? '1px solid rgba(168, 85, 247, 0.65)'
                                : undefined,
                              boxShadow: sceneEditor?.chapterKey === chapKey && sceneEditor?.sceneIdx === scene.scene_idx
                                ? '0 0 0 1px rgba(168, 85, 247, 0.18) inset'
                                : undefined
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontWeight: '600', color: 'var(--color-purple)' }}>场景 #{scene.scene_idx}</span>
                              <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                                ) : scene.status === 'failed' ? (
                                  '失败'
                                ) : scene.status === 'PROMPT_READY' ? (
                                  <span style={{ color: 'var(--color-purple)', fontWeight: '600' }}>⚡ Prompt 已就绪</span>
                                ) : (
                                  '待处理'
                                )}
                              </span>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: sceneImage ? '168px minmax(0, 1fr)' : '1fr', gap: '14px', alignItems: 'start', marginTop: '10px' }}>
                              {sceneImage && (
                                <img
                                  src={sceneImage}
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

                              <div style={{ minWidth: 0 }}>
                                <div className="scene-trigger" style={{ marginTop: 0 }}>
                                  「 {scene.trigger_sentence} 」
                                </div>

                                <div className="scene-desc" style={{ marginTop: '10px' }}>
                                  {scene.visual_description || scene.scene_desc}
                                </div>

                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
                                  <span className="tag-badge scene" style={{ margin: 0 }}>{scene.nsfw_rating || 'sfw'}</span>
                                  <span className="tag-badge scene" style={{ margin: 0 }}>{sceneCharacterCount} 人</span>
                                  {scene.image_path && <span className="tag-badge scene" style={{ margin: 0 }}>有图</span>}
                                  {(scene.final_prompt || scene.prepared_prompt?.finalPositive) && <span className="tag-badge scene" style={{ margin: 0 }}>Prompt</span>}
                                </div>
                              </div>
                            </div>

                            {/* 单场景重绘操作栏 */}
                            <div 
                              style={{ 
                                marginTop: '14px', 
                                paddingTop: '12px', 
                                borderTop: '1px solid rgba(255,255,255,0.04)', 
                                display: 'flex', 
                                justifyContent: 'flex-end', 
                                gap: '10px' 
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
                                  borderColor: 'rgba(96, 165, 250, 0.45)',
                                  color: '#93c5fd'
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openSceneEditor(chapKey, scene);
                                }}
                                title="查看并编辑完整场景卡与生图参数"
                              >
                                <Pencil size={12} /> 编辑
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
                    ) : chapterContent.paragraphs.map((paragraph, paragraphIndex) => {
                      const scenes = getChapterProgress(selectedChapter.volume, selectedChapter.chapter)?.scenes || [];
                      const paragraphScenes = scenes.filter(scene => scene.status === 'SUCCESS' && scene.image_path && (
                        Number(scene.source_paragraph_index) === paragraphIndex ||
                        String(scene.source_paragraph || '').trim() === paragraph ||
                        (!scene.source_paragraph && scene.trigger_sentence && paragraph.includes(scene.trigger_sentence))
                      ));
                      return (
                        <section key={`${paragraphIndex}-${paragraph.slice(0, 16)}`} className="reader-paragraph-block">
                          <p className="reader-paragraph" data-paragraph-index={paragraphIndex}>{paragraph}</p>
                          {paragraphScenes.map(scene => (
                            <img
                              key={`inline-${scene.scene_idx}`}
                              className="reader-illustration"
                              src={encodeURI(`${API_BASE}/projects/${activeProject}/${scene.image_path}`)}
                              alt=""
                              onClick={() => setPreviewImage(encodeURI(`${API_BASE}/projects/${activeProject}/${scene.image_path}`))}
                            />
                          ))}
                        </section>
                      );
                    })}
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

      {/* 3. 右栏：冷却管理、实时进度与日志 */}
      <div className="app-column status-sidebar">
        {/* 实时流水线日志 */}
        <div className="column-header">
          <h2><Sparkles size={18} /> 流水线实时日志</h2>
          <div
            className={`cooldown-chip ${cooldown > 0 ? 'active' : ''} ${cooldownState.mode === 'degraded' ? 'degraded' : ''}`}
            title={cooldownState.mode === 'degraded'
              ? `429 降级模式：固定 35 秒，成功 ${cooldownState.degradedSuccesses || 0}/5 次后恢复`
              : `基础间隔 ${cooldownState.baseCooldownSeconds || config.nai_cooldown_seconds || 15} 秒`}
          >
            <Timer size={14} />
            <span>{cooldown > 0 ? `${Math.ceil(cooldown)}s` : `${cooldownState.cooldownSeconds || 15}s`}</span>
          </div>
        </div>
        <div className="column-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', minHeight: 0 }}>
          {/* 上半部分：常规/LLM日志 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span>⚙️ 流水线与 LLM 日志</span>
            </div>
            <div className="glass-panel" style={{ flex: 1, overflowY: 'auto', padding: '10px', fontFamily: 'var(--font-title)', fontSize: '0.8rem' }}>
              {logs.map((log, idx) => (
                <div key={idx} style={{ marginBottom: '6px', lineHeight: '1.4', color: log.type === 'error' ? 'var(--color-pink)' : log.type === 'warning' ? 'var(--color-orange)' : log.type === 'success' ? 'var(--color-green)' : 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>[{log.time}]</span>
                  {log.text}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>

          {/* 下半部分：NAI日志 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span>🎨 NovelAI 生图日志</span>
            </div>
            <div className="glass-panel" style={{ flex: 1, overflowY: 'auto', padding: '10px', fontFamily: 'var(--font-title)', fontSize: '0.8rem' }}>
              {naiLogs.map((log, idx) => (
                <div key={idx} style={{ marginBottom: '6px', lineHeight: '1.4', color: log.type === 'error' ? 'var(--color-pink)' : log.type === 'warning' ? 'var(--color-orange)' : log.type === 'success' ? 'var(--color-green)' : 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>[{log.time}]</span>
                  {log.text}
                </div>
              ))}
              <div ref={naiLogsEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* 角色 DNA 切片更新提示 */}
      {dnaUpdatePrompt && (
        <div className="modal-overlay">
          <div className="modal-content glass-panel" style={{ maxWidth: '520px' }}>
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
          <div className="modal-content glass-panel" style={{ maxWidth: '1100px', width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, rgba(24, 28, 56, 0.98), rgba(18, 22, 46, 0.98))', border: '1px solid rgba(148, 163, 184, 0.14)' }}>
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
                    src={encodeURI(`${API_BASE}/projects/${activeProject}/${sceneEditor.imagePath}`)}
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
                <div style={{ ...sceneEditorSectionStyle, gridTemplateColumns: '1fr 150px 120px 120px', gap: '10px' }}>
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
                          return {
                            ...draft,
                            character_names: characterNames,
                            characters: syncSceneCharactersFromNames(characterNames, draft.characters, characters)
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
                      characters: [...draft.characters, { name: '', gender: 'unknown', appearance: '', clothing: '', expression: '', pose: '', position: '' }]
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
                            characters: draft.characters.filter((_, itemIndex) => itemIndex !== index)
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
                          sceneEditor.draft.final_prompt && `正向提示词:\n${sceneEditor.draft.final_prompt}`,
                          sceneEditor.draft.base_prompt && `V4 Base Prompt:\n${sceneEditor.draft.base_prompt}`,
                          sceneEditor.draft.character_prompts && `V4 Character Prompts:\n${sceneEditor.draft.character_prompts}`,
                          sceneEditor.draft.negative_character_prompts && `V4 Character Negative Prompts:\n${sceneEditor.draft.negative_character_prompts}`,
                          sceneEditor.draft.final_negative && `负向提示词:\n${sceneEditor.draft.final_negative}`
                        ].filter(Boolean);
                        navigator.clipboard.writeText(parts.join('\n\n'));
                        addLog(`📋 已复制场景 #${sceneEditor.sceneIdx} 完整生图参数到剪贴板！`, 'success');
                      }}
                    >
                      <Copy size={12} /> 复制参数
                    </button>
                  </div>
                  {[
                    ['final_prompt', 'Final Prompt', 4],
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
          <div className="modal-content glass-panel" style={{ maxWidth: configTab === 'prompts' ? '800px' : '920px', width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
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
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
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
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>每 600 字(默认)生成一个分镜</div>
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
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>每 350 词(默认)生成一个分镜</div>
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
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>1. 分镜场景提取 System Prompt</label>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>用于将小说章节正文切分并提炼为 5-10 个中文分镜描述卡片</div>
                    <textarea 
                      value={config.system_prompt_extract_scenes || ""}
                      onChange={(e) => setConfig({ ...config, system_prompt_extract_scenes: e.target.value })}
                      style={{ width: '100%', height: '170px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>2. 角色设定 DNA 提取 System Prompt</label>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>用于智能扫描全书主要人物，提取常驻的发型、瞳色、服装等固有 DNA 特征</div>
                    <textarea 
                      value={config.system_prompt_character_dna || ""}
                      onChange={(e) => setConfig({ ...config, system_prompt_character_dna: e.target.value })}
                      style={{ width: '100%', height: '170px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>3. 高级生图参数生成 System Prompt（V4.5 自然语言版）</label>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>LLM 使用自然语言句子描述场景和角色。适用于 V4.5 Full / T5 编码器模型。权重上限 1.3。</div>
                    <textarea 
                      value={config.system_prompt_advanced_prompt_nl || ""}
                      onChange={(e) => setConfig({ ...config, system_prompt_advanced_prompt_nl: e.target.value })}
                      style={{ width: '100%', height: '200px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(168,85,247,0.35)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '500' }}>4. NovelAI 画师 / 风格 Prompt 串</label>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                      生图时自动追加到最终正向 Prompt 末尾。支持 NovelAI 权重语法；留空即可关闭画师串注入。
                    </div>
                    <textarea
                      value={config.artistStylePrompt || ""}
                      onChange={(e) => setConfig({ ...config, artistStylePrompt: e.target.value })}
                      placeholder="例如：2.0::artist:name ::, 1.2::cinematic lighting ::"
                      spellCheck={false}
                      style={{ width: '100%', height: '120px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(168,85,247,0.4)', borderRadius: '6px', padding: '8px', color: 'white', fontFamily: 'monospace', fontSize: '0.8rem', lineHeight: '1.4', resize: 'vertical' }}
                    />
                  </div>
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
          <div className="modal-content glass-panel" style={{ maxWidth: '600px' }}>
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
          <div className="modal-content glass-panel" style={{ maxWidth: '460px' }}>
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
