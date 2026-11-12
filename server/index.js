import './utils/terminal-logger.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { PipelineManager } from './services/pipeline-manager.js';
import { EPUBBuilder, insertIllustrationsAfterParagraphs, readEpubImage } from './services/epub-builder.js';
import { globalCooldownManager } from './utils/cooldown.js';
import { enqueueUniqueJob, removeQueuedJobs } from './utils/job-queue.js';
import { readConfig, writeConfig } from './utils/config-store.js';
import { resolveLlmRetryLimits } from './utils/llm-retry.js';
import { LLM_POOL_STATS_VERSION } from './utils/llm-pool.js';
import { clampNaiSteps, clampNaiScale } from './utils/nai-params.js';
import { parseFile } from './utils/file-parser.js';
import { getProjectSummary } from './utils/project-summary.js';
import { epubExportDir, copyToDir } from './utils/export-copy.js';
import { DEFAULT_EXTRACT_SCENES_PROMPT, DEFAULT_CHARACTER_DNA_PROMPT, DEFAULT_ADVANCED_PROMPT, DEFAULT_ADVANCED_PROMPT_V45_NL } from './utils/default-prompts.js';
import { normalizeAdvancedPromptForConfig, normalizeCharacterDnaPromptForConfig } from './utils/advanced-prompt-contract.js';
import { createAgentRouter } from './services/agent-api.js';
import { createAudiobookRouter } from './services/audiobook/router.js';
import { createComicLegacyGuard } from './services/comic-service.js';
import { createThumbnailMiddleware } from './services/thumbnail-service.js';
import { GlobalQueueManager } from './services/global-queue-manager.js';
import { findProxyBindingConflict } from './services/llm-extractor.js';
import { compressFile, listImages, DEFAULT_QUALITY } from './services/image-compress.js';
import os from 'node:os';

const BASE_DIR = process.cwd();
const CONFIG_PATH = path.join(BASE_DIR, 'illustrator_config.json');

const DEFAULT_CONFIG = {
  llm_url: "",
  llm_key: "",
  llm_model: "deepseek-chat",
  llm_preset_id: "",
  llm_stream_enabled: true,
  llm_rate_limit_enabled: true,
  llm_rate_limit_rpm: 3,
  llm_max_retries: 3,
  llm_429_max_retries: 5,
  // 并行数量（前端可调）：章节级 LLM 生产者并发 / 单章内场景 prompt 并发
  llm_concurrency: 2,
  max_scene_prompt_concurrency: 5,
  llm_failover_enabled: true,
  llm_multi_model_enabled: true,
  llm_pool_hop_on_429: true,
  llm_pool_cooldown_seconds: 20,
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
  image_compress_enabled: true,
  image_compress_quality: 85,
  image_compress_sidecar: true,
  cjk_scene_divisor: 600,
  english_scene_divisor: 350,
  max_scenes_per_request: 5,
  proxy_url: "",
  useVibeTransfer: false,
  vibeBundlePath: "2026-06-04.naiv4vibebundle",
  vibeStrength: 0.45,
  vibeInfoExtracted: 1.0,
  vibeNormalizeStrengths: true,
  artistStylePrompt: "4::masterpiece, best quality ::, 2::official art, year2024, year2025 ::, 2.25::Artist:youngjoo kjy ::, 1.45::artist:nardack ::, 1.25::Artist:rella ::, 1.05::Artist:qiandaiyiyu ::, 1.05::Artist:atdan ::, 0.85::Artist:void_0 ::, 0.65::Artist:stu_dts ::, 0.75::Artist:wo_jiushi_kanbudong ::, 0.75::Artist:nixeu ::, -3::3D ::, 1.35::rim lighting, deep shadows, volumetric lighting, high contrast, cinematic lighting ::, no text",
  nai_url: "https://image.novelai.net",
  system_prompt_extract_scenes: DEFAULT_EXTRACT_SCENES_PROMPT,
  system_prompt_character_dna: DEFAULT_CHARACTER_DNA_PROMPT,
  system_prompt_advanced_prompt_nl: DEFAULT_ADVANCED_PROMPT_V45_NL,
  system_prompt_advanced_prompt: DEFAULT_ADVANCED_PROMPT,
  artist_presets: []
};

/** 并行数量归一化：1-8 的整数，非法值回落到默认值 */
function clampConcurrency(value, fallback = 2) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' || typeof value === 'boolean') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.min(8, Math.floor(num)));
}

function normalizeConfig(config = {}) {
  const normalized = { ...DEFAULT_CONFIG, ...config };
  normalized.artist_presets = Array.isArray(config.artist_presets) ? config.artist_presets : [];
  normalized.max_scenes_per_request = Number.isInteger(Number(config.max_scenes_per_request)) && Number(config.max_scenes_per_request) > 0 ? Math.min(20, Number(config.max_scenes_per_request)) : 5;
  const retryLimits = resolveLlmRetryLimits(normalized);
  normalized.llm_max_retries = retryLimits.maxRetries;
  normalized.llm_429_max_retries = retryLimits.max429Retries;
  normalized.llm_concurrency = clampConcurrency(normalized.llm_concurrency, 2);
  normalized.max_scene_prompt_concurrency = clampConcurrency(normalized.max_scene_prompt_concurrency, 5);
  // 生图参数锁在免费档：steps > 28 会按倍数扣点数，scale 超出 NAI 上限会被上游拒掉
  normalized.steps = clampNaiSteps(normalized.steps, 28);
  normalized.scale = clampNaiScale(normalized.scale, 5.5);
  const promptDefaults = {
    system_prompt_extract_scenes: DEFAULT_EXTRACT_SCENES_PROMPT,
    system_prompt_character_dna: DEFAULT_CHARACTER_DNA_PROMPT,
    system_prompt_advanced_prompt_nl: DEFAULT_ADVANCED_PROMPT_V45_NL,
    system_prompt_advanced_prompt: DEFAULT_ADVANCED_PROMPT
  };

  for (const [field, fallback] of Object.entries(promptDefaults)) {
    if (!String(normalized[field] || '').trim()) {
      normalized[field] = fallback;
    }
  }

  normalized.system_prompt_character_dna = normalizeCharacterDnaPromptForConfig(normalized.system_prompt_character_dna);
  normalized.system_prompt_advanced_prompt = normalizeAdvancedPromptForConfig(normalized.system_prompt_advanced_prompt);

  return normalized;
}

function runningInDocker() {
  return existsSync('/.dockerenv');
}

function normalizeProxyUrl(proxyUrl) {
  if (!proxyUrl) return proxyUrl;

  try {
    const parsed = new URL(proxyUrl);
    const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if (runningInDocker() && isLoopback) {
      parsed.hostname = 'host.docker.internal';
      console.warn(`[Proxy] 检测到 Docker 内使用本机回环代理，已自动改写为: ${parsed.toString()}`);
    }
    return parsed.toString();
  } catch (error) {
    console.warn(`[Proxy] 代理地址解析失败，保持原值: ${error.message}`);
    return proxyUrl;
  }
}

// Configure global proxy dispatcher for global fetch
function applyProxy(proxyUrl) {
  if (proxyUrl) {
    try {
      const effectiveProxyUrl = normalizeProxyUrl(proxyUrl);
      const proxyAgent = new ProxyAgent(effectiveProxyUrl);
      setGlobalDispatcher(proxyAgent);
      console.log(`[Proxy] 已成功加载全局 Fetch 代理: ${effectiveProxyUrl}`);
    } catch (err) {
      console.error(`[Proxy] 载入代理失败: ${err.message}`);
    }
  }
}

// 尝试从环境变量和配置文件中加载代理
(async () => {
  try {
    let proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (existsSync(CONFIG_PATH)) {
      const config = await readConfig(CONFIG_PATH);
      if (config.proxy_url) {
        proxyUrl = config.proxy_url;
      }
    }
    if (proxyUrl) {
      applyProxy(proxyUrl);
    }
  } catch (err) {
    console.error(`[Proxy] 初始化代理失败: ${err.message}`);
  }
})();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 兼容层：历史数据可能残留 .png 引用，而实际文件已压缩为 .webp。
// 请求的 .png 不存在但同名 .webp 存在时，302 重写到 .webp，避免预览 404。
const pngToWebpCache = new Map();
app.use('/projects', (req, res, next) => {
  if (!/\.png$/i.test(req.path)) return next();
  try {
    const decoded = decodeURIComponent(req.path);
    const absPath = path.join(BASE_DIR, 'projects', decoded);
    if (existsSync(absPath)) return next();
    let remap = pngToWebpCache.get(absPath);
    if (remap === undefined) {
      remap = existsSync(absPath.replace(/\.png$/i, '.webp'));
      if (pngToWebpCache.size > 4096) pngToWebpCache.clear();
      pngToWebpCache.set(absPath, remap);
    }
    if (!remap) return next();
    return res.redirect(302, req.originalUrl.replace(/\.png(?=$|\?)/i, '.webp'));
  } catch {
    return next();
  }
});

// 缩略图服务（当请求携带 ?w= 或 ?width= 时动态生成/提供轻量 WebP 缩略图与长效缓存）
app.use('/projects', createThumbnailMiddleware({ projectsDir: path.join(BASE_DIR, 'projects') }));

// 静态托管项目资源（可直接通过 /projects/项目名/illustrations/图片名 加载图片原图）
app.use('/projects', express.static(path.join(BASE_DIR, 'projects')));

// 自动检测并静态托管前端构建好的网页资源，以便 Docker 单容器部署
const CLIENT_DIST = path.join(BASE_DIR, 'client', 'dist');
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  console.log(`[Static] 已激活前端静态资源托管: ${CLIENT_DIST}`);
}

// 缓存全局活动中的 Pipeline 实例
const activePipelines = {};
const redrawQueues = new Map();
const chapterQueues = new Map();

// 全局两级调度队列管理器（Prompt LLM 队列与 Image NAI 队列完全解耦，支持跨项目排队）
const globalQueueManager = new GlobalQueueManager({
  getPipeline,
  broadcastSSE,
  cooldownManager: globalCooldownManager,
  getActiveLlmInfo: collectActiveLlmInfo
});

/**
 * 当前实际在用的 LLM 连接（供前端展示「现在用的是哪个模型」）。
 * 优先取正在跑 Prompt 阶段的项目，否则取任意已加载的 pipeline。
 */
function collectActiveLlmInfo() {
  const runningProject = globalQueueManager?.promptQueue?.current?.projectName;
  // 先精确匹配；找不到时按归一化名称（去空格 / 大小写）再找一次。
  // 以前只有精确匹配，一旦 key 有细微差异就会默默回退到「任意已加载项目」，
  // 前端于是展示另一个项目（统计全 0）的池，看上去就像统计坏了。
  const pickRunning = () => {
    if (!runningProject) return null;
    if (activePipelines[runningProject]) return activePipelines[runningProject];
    const normalize = value => String(value || '').replace(/[\s_]+/g, '').toLowerCase();
    const target = normalize(runningProject);
    const hitKey = Object.keys(activePipelines).find(key => normalize(key) === target);
    return hitKey ? activePipelines[hitKey] : null;
  };
  const candidates = [
    pickRunning(),
    ...Object.values(activePipelines)
  ].filter(Boolean);
  for (const pipeline of candidates) {
    if (typeof pipeline.getActiveLlmInfo === 'function') return pipeline.getActiveLlmInfo();
  }
  return null;
}

async function safeProjectPath(projectName) {
  const projectsDir = path.resolve(BASE_DIR, 'projects');
  if (!projectName || projectName.includes('/') || projectName.includes('\\') || projectName.startsWith('.')) {
    throw new Error("无效的项目名称");
  }

  const projectPath = path.resolve(projectsDir, projectName);
  const relative = path.relative(projectsDir, projectPath);
  if (!projectName || relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new Error("无效的项目名称");
  }
  return { projectsDir, projectPath };
}

// SSE 客户端连接集合
const sseClients = new Set();

// 广播 SSE 消息给所有连接的客户端
function broadcastSSE(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// 全局订阅冷却计时器，并实时推送到前端
globalCooldownManager.onTick((remaining, state) => {
  broadcastSSE('cooldown', state);
});

/**
 * 获取或创建 PipelineManager 实例
 */
async function getPipeline(projectName) {
  if (activePipelines[projectName]) {
    return activePipelines[projectName];
  }

  const rawConfig = await readConfig(CONFIG_PATH);
  const config = normalizeConfig(rawConfig);
  if (rawConfig.system_prompt_character_dna && rawConfig.system_prompt_character_dna !== config.system_prompt_character_dna) {
    writeConfig(CONFIG_PATH, config).catch(() => {});
  }

  const pipeline = new PipelineManager({ ...config, projectName });
  await pipeline.initialize();

  // 绑定进度实时同步回调
  pipeline.uiProgressCallback = (progressData) => {
    broadcastSSE('progress', progressData);
  };
  pipeline.uiCooldownCallback = () => {
    broadcastSSE('cooldown_start', globalCooldownManager.getState());
  };
  pipeline.uiLogCallback = (text, type, options = {}) => {
    broadcastSSE('log', { text, type, ...options });
  };
  pipeline.priorityJobRunner = async () => {
    const queue = getRedrawQueue(projectName);
    if (queue.items.length > 0) {
      await processRedrawQueue(projectName, pipeline, queue, { interleaved: true });
    }
  };

  activePipelines[projectName] = pipeline;
  return pipeline;
}

function getRedrawQueue(projectName) {
  if (!redrawQueues.has(projectName)) {
    redrawQueues.set(projectName, {
      running: false,
      current: null,
      items: []
    });
  }
  return redrawQueues.get(projectName);
}

// 仅判断该场景此刻是否正在被处理（队列里等待不算），用于放行编辑其他/等待中的场景
function isSceneRunningInRedrawQueue(projectName, chapterKey, sceneIdx) {
  if (globalQueueManager.isSceneRunning(projectName, chapterKey, sceneIdx)) {
    return true;
  }
  const queue = getRedrawQueue(projectName);
  const normalizedChapterKey = String(chapterKey || '').trim();
  const normalizedSceneIdx = Number(sceneIdx);
  const current = queue.current;
  return Boolean(current
    && String(current.effectiveKey || '').trim() === normalizedChapterKey
    && Number(current.sceneIdx) === normalizedSceneIdx);
}

function getChapterQueue(projectName) {
  if (!chapterQueues.has(projectName)) {
    chapterQueues.set(projectName, {
      running: false,
      current: null,
      items: []
    });
  }
  return chapterQueues.get(projectName);
}

function redrawJobKey(chapterKey, sceneIdx, mode) {
  return `${chapterKey}::${sceneIdx}::${mode}`;
}

function chapterJobKey(chapterKey) {
  return chapterKey;
}

async function processRedrawQueue(projectName, pipeline, queue, { interleaved = false } = {}) {
  if (queue.running) return;
  queue.running = true;

  try {
    while (queue.items.length > 0) {
      const job = queue.items.shift();
      queue.current = job;
      broadcastSSE('redraw_queue', {
        projectName,
        chapterKey: job.chapterKey,
        sceneIdx: job.sceneIdx,
        state: 'running',
        remaining: queue.items.length
      });

      let generationError = null;
      try {
        if (job.mode === 'nai_only') {
          await pipeline.redrawSceneWithSavedPrompt(job.effectiveKey, job.sceneIdx, { interleaved });
        } else {
          await pipeline.redrawScene(job.effectiveKey, job.sceneIdx, { interleaved });
        }
        broadcastSSE('redraw_queue', {
          projectName,
          chapterKey: job.chapterKey,
          sceneIdx: job.sceneIdx,
          state: 'completed',
          remaining: queue.items.length,
          pipelineRunning: pipeline.isRunning
        });
      } catch (error) {
        generationError = error;
        console.error(`[Server] 队列重绘异常: ${error.message}`);
        broadcastSSE('redraw_queue', {
          projectName,
          chapterKey: job.chapterKey,
          sceneIdx: job.sceneIdx,
          state: 'failed',
          message: error.message,
          remaining: queue.items.length,
          pipelineRunning: pipeline.isRunning
        });
      } finally {
        try { await job.onFinished?.(generationError); }
        catch { console.error('[Agent] 任务回执保存失败；需要核查生成结果。'); }
        queue.current = null;
      }
    }
  } finally {
    queue.running = false;
  }
}

function enqueueRedraw(projectName, pipeline, chapterKey, effectiveKey, sceneIdx, mode = 'refresh_prompt', agentOptions = {}) {
  const normChapKey = effectiveKey || chapterKey;
  if (mode === 'nai_only') {
    return globalQueueManager.enqueueImageJob({
      projectName,
      chapterKey: normChapKey,
      sceneIdx: Number(sceneIdx),
      mode: 'nai_only',
      priority: true,
      agentOptions
    });
  } else {
    return globalQueueManager.enqueuePromptJob({
      projectName,
      type: 'redraw_prompt',
      chapterKey: normChapKey,
      payload: { sceneIdx: Number(sceneIdx), mode, ...agentOptions },
      priority: true
    });
  }
}

async function processChapterQueue(projectName) {
  const queue = getChapterQueue(projectName);
  if (queue.running) return;
  queue.running = true;

  let pipeline;
  try {
    pipeline = await getPipeline(projectName);

    while (queue.items.length > 0) {
      if (pipeline.isRunning) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      const job = queue.items.shift();
      queue.current = job;
      broadcastSSE('chapter_queue', {
        projectName,
        chapterKey: job.chapterKey,
        state: 'running',
        remaining: queue.items.length
      });

      try {
        pipeline.projectProgress.setChapterStatus(job.effectiveKey, 'pending', []);
        await pipeline.projectProgress.save();

        broadcastSSE('pipeline_started', {
          projectName,
          chapterKey: job.chapterKey,
          type: 'chapter_generate'
        });

        const result = await pipeline.processPipeline(job.effectiveKey, { autoUpdateCharacterDna: false });
        if (result?.paused) {
          broadcastSSE('chapter_queue', {
            projectName,
            chapterKey: job.chapterKey,
            state: 'paused',
            remaining: queue.items.length
          });
          break;
        }

        const chapterProgress = pipeline.projectProgress.getCompletedChapters()?.[job.effectiveKey];
        if (chapterProgress?.status === 'failed') {
          const message = chapterProgress.error || `章节「${job.chapterKey}」场景生成失败`;
          broadcastSSE('chapter_queue', {
            projectName,
            chapterKey: job.chapterKey,
            state: 'failed',
            message,
            remaining: queue.items.length
          });
          broadcastSSE('pipeline_failed', {
            projectName,
            chapterKey: job.chapterKey,
            type: 'chapter_generate',
            message
          });
          continue;
        }

        broadcastSSE('chapter_queue', {
          projectName,
          chapterKey: job.chapterKey,
          state: 'completed',
          remaining: queue.items.length
        });

        if (queue.items.length === 0) {
          broadcastSSE('pipeline_completed', {
            projectName,
            chapterKey: job.chapterKey,
            type: 'chapter_generate'
          });
        } else {
          broadcastSSE('log', {
            text: `🟢 单章「${job.chapterKey}」已完成，队列中还剩 ${queue.items.length} 个单章任务等待执行...`,
            type: 'info'
          });
        }
      } catch (error) {
        console.error(`[Queue] 单章重画任务异常:`, error);
        broadcastSSE('chapter_queue', {
          projectName,
          chapterKey: job.chapterKey,
          state: 'failed',
          message: error.message,
          remaining: queue.items.length
        });
        broadcastSSE('pipeline_failed', {
          projectName,
          chapterKey: job.chapterKey,
          type: 'chapter_generate',
          message: error.message
        });
      } finally {
        queue.current = null;
      }
    }
  } catch (err) {
    console.error(`[Queue] 单章重画队列执行异常:`, err);
  } finally {
    queue.running = false;
    if (pipeline) {
      const redrawQueue = getRedrawQueue(projectName);
      if (redrawQueue && redrawQueue.items.length > 0 && !pipeline.isRunning) {
        void processRedrawQueue(projectName, pipeline, redrawQueue);
      }
    }
  }
}

function enqueueChapterGeneration(projectName, pipeline, chapterKey, effectiveKey, mode = 'complete') {
  const normChapKey = effectiveKey || chapterKey;
  return globalQueueManager.enqueuePromptJob({
    projectName,
    type: 'chapter_generate',
    chapterKey: normChapKey,
    payload: { mode }
  });
}

// === 1. 全局配置 API ===

app.get('/api/config', async (req, res) => {
  try {
    const rawConfig = await readConfig(CONFIG_PATH);
    const config = normalizeConfig(rawConfig);
    if (rawConfig.system_prompt_character_dna && rawConfig.system_prompt_character_dna !== config.system_prompt_character_dna) {
      await writeConfig(CONFIG_PATH, config).catch(() => {});
    }
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config/default-prompts', (req, res) => {
  res.json({
    system_prompt_extract_scenes: DEFAULT_EXTRACT_SCENES_PROMPT,
    system_prompt_character_dna: DEFAULT_CHARACTER_DNA_PROMPT,
    system_prompt_advanced_prompt: DEFAULT_ADVANCED_PROMPT,
    system_prompt_advanced_prompt_nl: DEFAULT_ADVANCED_PROMPT_V45_NL
  });
});

app.post('/api/config', async (req, res) => {
  try {
    const submitted = normalizeConfig(req.body);
    await writeConfig(CONFIG_PATH, submitted);
    // 前端可能未回传密钥（或只改了画风词），统一读回合并后的完整配置再下发
    const newConfig = normalizeConfig(await readConfig(CONFIG_PATH));
    
    // 动态应用网络代理配置
    if (newConfig.proxy_url) {
      applyProxy(newConfig.proxy_url);
    }
    
    globalCooldownManager.setBaseCooldownSeconds(newConfig.nai_cooldown_seconds ?? 15);

    // 动态同步更新所有已激活的管道配置
    for (const pipeline of Object.values(activePipelines)) {
      pipeline.updateConfig(newConfig);
    }

    res.json({ success: true, message: "配置保存并同步成功！" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取所有可用的聊天模型列表 (支持传入临时的 url 和 key)
app.get('/api/config/llm-models', async (req, res) => {
  try {
    const llm_url = req.query.llm_url || "";
    const llm_key = req.query.llm_key || "";
    
    if (!llm_key) {
      return res.status(400).json({ error: "请先填写 API Key" });
    }

    const { LLMExtractor } = await import('./services/llm-extractor.js');
    const extractor = new LLMExtractor({
      baseUrl: llm_url || "https://api.openai.com/v1",
      apiKey: llm_key
    });

    const models = await extractor.getAvailableModels();
    res.json({ success: true, models });
  } catch (error) {
    console.error("[Server] 获取 LLM 模型列表失败:", error);
    res.status(500).json({ error: error.message });
  }
});

// LLM 调用统计诊断：用来确认服务端跑的是带统计的新代码，以及各模型真实调用量
app.get('/api/llm/stats', (req, res) => {
  try {
    const info = collectActiveLlmInfo();
    res.json({
      success: true,
      // 拿到该字段且 >= 2 才说明后端是新代码；缺失说明跑的是旧版本
      statsVersion: LLM_POOL_STATS_VERSION,
      runningProject: globalQueueManager?.promptQueue?.current?.projectName || null,
      loadedPipelines: Object.keys(activePipelines),
      llmConcurrency: info?.llmConcurrency ?? null,
      scenePromptConcurrency: info?.scenePromptConcurrency ?? null,
      poolStats: info?.poolStats || [],
      pools: {
        scene: info?.scene?.pool || null,
        characterDna: info?.characterDna?.pool || null,
        naiTags: info?.naiTags?.pool || null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === 2. 项目管理 API ===

// 获取所有项目列表
app.get('/api/projects', async (req, res) => {
  try {
    const projectsDir = path.join(BASE_DIR, 'projects');
    if (!existsSync(projectsDir)) {
      return res.json([]);
    }
    
    const dirs = await fs.readdir(projectsDir);
    const projects = [];

    for (const name of dirs) {
      if (name.startsWith('.')) continue;
      const stats = await fs.stat(path.join(projectsDir, name));
      if (stats.isDirectory()) {
        let progress = null;
        try {
          progress = await getProjectSummary(name, projectsDir);
        } catch (err) {
          console.warn(`[Server] 生成项目「${name}」进度摘要失败:`, err.message);
        }
        const pendingImages = await countPendingImages(name).catch(() => 0);
        projects.push({ name, createdAt: stats.birthtime, progress, pendingImages });
      }
    }
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 插画批量压缩（旧图一键压缩 + 多路并行）
// ============================================================
const compressJobs = new Map();
let compressJobSeq = 0;

function estimateConcurrency(requested) {
  const cpus = os.cpus()?.length || 4;
  const fallback = Math.max(2, Math.min(6, cpus - 1));
  const n = Number(requested);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(8, Math.floor(n))) : fallback;
}

/** 收集要压缩的目录：项目插画 + 漫画候选切片（递归） */
async function collectCompressTargets(projectName) {
  const projectsDir = path.join(BASE_DIR, 'projects');
  const targets = [];
  const add = (dir, recursive = false) => {
    if (existsSync(dir)) targets.push({ dir, recursive });
  };
  if (projectName) {
    add(path.join(projectsDir, projectName, 'illustrations'));
    add(path.join(projectsDir, projectName, 'comic', 'assets'), true);
    return targets;
  }
  const dirs = await fs.readdir(projectsDir).catch(() => []);
  for (const name of dirs) {
    if (name.startsWith('.')) continue;
    const st = await fs.stat(path.join(projectsDir, name)).catch(() => null);
    if (!st?.isDirectory()) continue;
    add(path.join(projectsDir, name, 'illustrations'));
    add(path.join(projectsDir, name, 'comic', 'assets'), true);
  }
  return targets;
}

/** 待压缩图片计数（只列目录不 stat，带短 TTL 缓存，供前端置灰用） */
const pendingScanCache = new Map();
const PENDING_SCAN_TTL = 5000;

async function countPendingImages(projectName) {
  const cached = pendingScanCache.get(projectName);
  if (cached && Date.now() - cached.at < PENDING_SCAN_TTL) return cached.count;
  const base = path.join(BASE_DIR, 'projects', projectName);
  let count = 0;
  const dirs = [
    [path.join(base, 'illustrations'), false],
    [path.join(base, 'comic', 'assets'), true]
  ];
  for (const [dir, recursive] of dirs) {
    count += (await listImages(dir, { recursive }).catch(() => [])).length;
  }
  pendingScanCache.set(projectName, { at: Date.now(), count });
  return count;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    projectName: job.projectName,
    quality: job.quality,
    concurrency: job.concurrency,
    dryRun: job.dryRun,
    total: job.total,
    done: job.done,
    failed: job.failed,
    skipped: job.skipped,
    before: job.before,
    after: job.after,
    savedBytes: Math.max(0, job.before - job.after),
    percent: job.total ? Math.round((job.done + job.failed) / job.total * 100) : 0,
    current: job.current,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null,
    errors: job.errors.slice(0, 20)
  };
}

async function runCompressJob(job) {
  const targets = await collectCompressTargets(job.projectName);
  const files = [];
  for (const t of targets) {
    files.push(...await listImages(t.dir, { recursive: t.recursive }));
  }
  job.total = files.length;
  job.status = 'running';
  broadcastSSE('compress_progress', publicJob(job));

  if (job.dryRun || files.length === 0) {
    for (const f of files) {
      const s = await fs.stat(f).catch(() => null);
      if (s) job.before += s.size;
    }
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    broadcastSSE('compress_progress', publicJob(job));
    return job;
  }

  let cursor = 0;
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit > 400) {
      lastEmit = now;
      broadcastSSE('compress_progress', publicJob(job));
    }
  };

  async function worker() {
    while (cursor < files.length) {
      if (job.cancelRequested) return;
      const f = files[cursor++];
      job.current = path.basename(f);
      try {
        const r = await compressFile(f, { quality: job.quality, replace: job.replace, sidecar: job.sidecar });
        job.done++;
        if (r.skipped) job.skipped++;
        job.before += r.before;
        job.after += r.after;
      } catch (err) {
        job.failed++;
        if (job.errors.length < 50) job.errors.push({ file: f, error: String(err?.message || err) });
      }
      emit();
    }
  }

  await Promise.all(Array.from({ length: job.concurrency }, worker));
  job.status = job.cancelRequested ? 'cancelled' : 'done';
  job.finishedAt = new Date().toISOString();
  job.current = '';
  pendingScanCache.clear();
  emit(true);
  return job;
}

app.post('/api/compress-images/start', async (req, res) => {
  try {
    const running = [...compressJobs.values()].find(j => j.status === 'running' || j.status === 'scanning');
    if (running) {
      return res.status(409).json({ error: '已有压缩任务在运行，请等待完成', job: publicJob(running) });
    }
    const { projectName = null, quality = DEFAULT_QUALITY, concurrency, replace = true, sidecar = true, dryRun = false } = req.body || {};
    const q = Number(quality);
    if (!Number.isFinite(q) || q < 30 || q > 100) {
      return res.status(400).json({ error: 'quality 需在 30~100 之间' });
    }
    const job = {
      id: `cmp_${Date.now()}_${++compressJobSeq}`,
      projectName: projectName || null,
      quality: Math.round(q),
      concurrency: estimateConcurrency(concurrency),
      replace: replace !== false,
      sidecar: sidecar !== false,
      dryRun: !!dryRun,
      status: 'scanning',
      total: 0, done: 0, failed: 0, skipped: 0,
      before: 0, after: 0,
      current: '',
      errors: [],
      cancelRequested: false,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    compressJobs.set(job.id, job);
    runCompressJob(job).catch(err => {
      job.status = 'failed';
      job.error = String(err?.message || err);
      job.finishedAt = new Date().toISOString();
      broadcastSSE('compress_progress', publicJob(job));
    });
    res.json(publicJob(job));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/compress-images/status', (req, res) => {
  const jobs = [...compressJobs.values()]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 5)
    .map(publicJob);
  res.json({ jobs, cpus: os.cpus()?.length || 4, defaultConcurrency: estimateConcurrency() });
});

app.post('/api/compress-images/cancel', (req, res) => {
  const { jobId } = req.body || {};
  const job = jobId ? compressJobs.get(jobId) : [...compressJobs.values()].find(j => j.status === 'running');
  if (!job) return res.status(404).json({ error: '未找到进行中的压缩任务' });
  job.cancelRequested = true;
  res.json(publicJob(job));
});

// 解析导入小说文件 (.txt, .docx, .epub)
app.post('/api/parse-file', async (req, res) => {  try {
    const { filename, base64Data } = req.body;
    if (!filename || !base64Data) {
      return res.status(400).json({ error: "文件名或文件内容不能为空" });
    }

    let cleanBase64 = base64Data;
    if (base64Data.includes(';base64,')) {
      cleanBase64 = base64Data.split(';base64,').pop();
    }

    const buffer = Buffer.from(cleanBase64, 'base64');
    const text = await parseFile(filename, buffer);
    const suggestedName = filename.replace(/\.[^/.]+$/, "");

    res.json({
      success: true,
      text,
      suggestedName
    });
  } catch (error) {
    console.error("[Server] 解析导入文件失败:", error);
    res.status(500).json({ error: error.message });
  }
});

// 创建新项目
app.post('/api/projects', async (req, res) => {
  try {
    const { projectName, bookText } = req.body;
    if (!projectName || !bookText) {
      return res.status(400).json({ error: "项目名称和小说内容不能为空" });
    }

    const projDir = path.join(BASE_DIR, 'projects', projectName);
    await fs.mkdir(projDir, { recursive: true });
    
    // 写入小说正文 book.txt
    await fs.writeFile(path.join(projDir, 'book.txt'), bookText, 'utf-8');

    // 初始化管道
    const pipeline = await getPipeline(projectName);
    await pipeline.initialize();

    res.json({ success: true, message: `项目 ${projectName} 创建成功` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除项目：deleteFiles=true 直接删除目录；false 则移动到 projects/.trash 归档
app.delete('/api/projects/:projectName', async (req, res) => {
  try {
    const { projectName } = req.params;
    const deleteFiles = req.query.deleteFiles === 'true' || req.body?.deleteFiles === true;
    const pipeline = activePipelines[projectName];
    if (pipeline?.isRunning) {
      return res.status(400).json({ error: "项目流水线正在运行，请先停止后再删除" });
    }

    const { projectPath } = await safeProjectPath(projectName);
    if (!existsSync(projectPath)) {
      return res.status(404).json({ error: "项目不存在" });
    }

    delete activePipelines[projectName];

    if (deleteFiles) {
      await fs.rm(projectPath, { recursive: true, force: true });
      return res.json({ success: true, message: `项目「${projectName}」及项目文件已删除` });
    }

    const trashDir = path.join(BASE_DIR, 'projects', '.trash');
    await fs.mkdir(trashDir, { recursive: true });
    const safeName = projectName.replace(/[\\/:*?"<>|]/g, '_');
    const trashPath = path.join(trashDir, `${safeName}_${Date.now()}`);
    await fs.rename(projectPath, trashPath);
    res.json({ success: true, message: `项目「${projectName}」已移至回收区`, archivedPath: trashPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取项目详情 (进度 + 章节)
app.get('/api/projects/:projectName', async (req, res) => {
  try {
    const { projectName } = req.params;
    const pipeline = await getPipeline(projectName);
    
    res.json({
      projectName: pipeline.projectName,
      chapters: pipeline.chapters.map(c => ({
        volume: c.volume,
        chapter: c.chapter,
        wordCount: c.content.length,
        chapterKey: c.chapterKey,
        ordinal: c.ordinal
      })),
      progress: pipeline.projectProgress.data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:projectName/chapters/:chapterKey/content', async (req, res) => {
  try {
    const { projectName, chapterKey } = req.params;
    const pipeline = await getPipeline(projectName);
    // 同名章节靠 chapterKey（带 #序号 后缀）精确定位，先精确匹配再回退归一化匹配
    const decodedKey = decodeURIComponent(chapterKey || '');
    let chapter = pipeline.chapters.find(item => item.chapterKey === decodedKey);
    if (!chapter) {
      chapter = pipeline.chapters.find(item => {
        const key = pipeline.projectProgress.getEffectiveChapKey(item.volume, item.chapter, item.ordinal);
        return pipeline.projectProgress.normalizeKey(key) === pipeline.projectProgress.normalizeKey(decodedKey);
      });
    }
    if (!chapter) return res.status(404).json({ error: "章节不存在" });
    res.json({
      volume: chapter.volume,
      chapter: chapter.chapter,
      content: chapter.content,
      paragraphs: chapter.content.split(/\r?\n/).map(text => text.trim()).filter(Boolean)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === 3. 流水线核心操作 API ===

// 一键提炼全书主要角色 DNA
app.post('/api/projects/:projectName/extract-characters', async (req, res) => {
  try {
    const { projectName } = req.params;
    const pipeline = await getPipeline(projectName);
    
    // 异步提炼，不阻塞请求
    pipeline.extractGlobalCharacters().then((dict) => {
      broadcastSSE('characters_completed', {
        projectName,
        characters: dict
      });
    }).catch(err => {
      broadcastSSE('error', { message: `角色 DNA 提取异常: ${err.message}` });
    });

    res.json({ success: true, message: "全局角色 DNA 提取后台流水线已启动..." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新指定 10 章角色 DNA 切片
app.post('/api/projects/:projectName/character-dna-slices/:sliceIndex/update', async (req, res) => {
  try {
    const { projectName, sliceIndex } = req.params;
    const { continuePipeline = false, targetChapterKey = null } = req.body || {};
    const pipeline = await getPipeline(projectName);

    if (pipeline.isRunning) {
      return res.status(400).json({ error: "流水线已在运行中，请稍后再更新角色 DNA" });
    }

    const numericSliceIndex = Number(sliceIndex);
    if (!Number.isInteger(numericSliceIndex) || numericSliceIndex < 0) {
      return res.status(400).json({ error: "无效的角色 DNA 切片索引" });
    }

    pipeline.extractCharacterDnaSlice(numericSliceIndex, { force: true }).then((dict) => {
      broadcastSSE('characters_completed', {
        projectName,
        sliceIndex: numericSliceIndex,
        characters: dict
      });

      if (continuePipeline) {
        pipeline.projectProgress.setPipelinePause(null);
        pipeline.projectProgress.save().then(() => {
          pipeline.processPipeline(targetChapterKey, { autoUpdateCharacterDna: false }).then((result) => {
            if (!result?.paused) {
              broadcastSSE('pipeline_completed', { projectName });
            }
          }).catch(err => {
            broadcastSSE('pipeline_failed', { message: err.message });
          });
        }).catch(err => {
          broadcastSSE('pipeline_failed', { message: err.message });
        });
      }
    }).catch(err => {
      broadcastSSE('error', { message: `角色 DNA 切片更新异常: ${err.message}` });
    });

    res.json({
      success: true,
      message: `角色 DNA 切片 #${numericSliceIndex + 1} 更新已启动...`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 覆盖更新指定角色 DNA 外貌短语（保留旧路由以兼容已有前端/项目数据）
app.put('/api/projects/:projectName/characters/:characterName/tags', async (req, res) => {
  try {
    const { projectName, characterName } = req.params;
    const tags = String(req.body?.tags || '');
    const pipeline = await getPipeline(projectName);

    if (!characterName) {
      return res.status(400).json({ error: "角色名不能为空" });
    }

    const updated = pipeline.projectProgress.setCharacterDNATags(characterName, tags);
    if (!updated) {
      return res.status(404).json({ error: `未找到角色「${characterName}」` });
    }

    await pipeline.projectProgress.save();
    res.json({
      success: true,
      message: `角色「${characterName}」DNA 外貌短语已更新`,
      character: pipeline.projectProgress.getGlobalCharacters()[characterName]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 覆盖更新指定角色结构化 DNA 特征（可同时包含 proxy_character）
app.put('/api/projects/:projectName/characters/:characterName/features', async (req, res) => {
  try {
    const { projectName, characterName } = req.params;
    const features = req.body?.features || {};
    const pipeline = await getPipeline(projectName);

    if (!characterName) {
      return res.status(400).json({ error: "角色名不能为空" });
    }

    // 全书脸模唯一 + 性别匹配校验（人物不得重复、男女要匹配）；force=true 可跳过
    if (req.body?.proxy_character !== undefined) {
      const conflictError = findProxyBindingConflict(
        pipeline.projectProgress.getGlobalCharacters(),
        characterName,
        req.body.proxy_character,
        { force: req.body?.force === true }
      );
      if (conflictError) {
        return res.status(409).json({ error: conflictError });
      }
    }

    const updated = pipeline.projectProgress.setCharacterDNAFeatures(characterName, features);
    if (!updated) {
      return res.status(404).json({ error: `未找到角色「${characterName}」` });
    }

    if (req.body?.proxy_character !== undefined) {
      pipeline.projectProgress.setCharacterDNAProxy(characterName, req.body.proxy_character);
    }

    await pipeline.projectProgress.save();
    res.json({
      success: true,
      message: `角色「${characterName}」结构化 DNA 已更新`,
      character: pipeline.projectProgress.getGlobalCharacters()[characterName]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 单独更新或清除指定角色的同人脸模代理
app.put('/api/projects/:projectName/characters/:characterName/proxy', async (req, res) => {
  try {
    const { projectName, characterName } = req.params;
    const proxyCharacter = req.body?.proxy_character ?? null;
    const pipeline = await getPipeline(projectName);

    if (!characterName) {
      return res.status(400).json({ error: "角色名不能为空" });
    }

    // 全书脸模唯一 + 性别匹配校验（人物不得重复、男女要匹配）；force=true 可跳过
    const conflictError = findProxyBindingConflict(
      pipeline.projectProgress.getGlobalCharacters(),
      characterName,
      proxyCharacter,
      { force: req.body?.force === true }
    );
    if (conflictError) {
      return res.status(409).json({ error: conflictError });
    }

    const updated = pipeline.projectProgress.setCharacterDNAProxy(characterName, proxyCharacter);
    if (!updated) {
      return res.status(404).json({ error: `未找到角色「${characterName}」` });
    }

    await pipeline.projectProgress.save();
    res.json({
      success: true,
      message: `角色「${characterName}」同人脸模代理已更新`,
      character: pipeline.projectProgress.getGlobalCharacters()[characterName]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:projectName/characters/:characterName/dna-versions/:versionId', async (req, res) => {
  try {
    const { projectName, characterName, versionId } = req.params;
    const pipeline = await getPipeline(projectName);
    const versions = pipeline.projectProgress.getCharacterDnaVersions()?.[characterName] || [];
    const existing = versions.find(version => version.id === versionId);
    if (!existing) return res.status(404).json({ error: `未找到角色「${characterName}」的外观版本` });
    const updated = pipeline.projectProgress.upsertCharacterDnaVersion(characterName, {
      ...existing,
      ...req.body,
      id: versionId,
      startChapterIndex: Number(req.body?.startChapterIndex ?? existing.startChapterIndex)
    });
    if (!updated) return res.status(400).json({ error: '外观版本数据无效' });
    await pipeline.projectProgress.save();
    res.json({ success: true, versions: pipeline.projectProgress.getCharacterDnaVersions()[characterName] || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:projectName/characters/:characterName/dna-versions/:versionId', async (req, res) => {
  try {
    const { projectName, characterName, versionId } = req.params;
    const pipeline = await getPipeline(projectName);
    const deleted = pipeline.projectProgress.deleteCharacterDnaVersion(characterName, versionId);
    if (!deleted) return res.status(400).json({ error: '至少保留一个外观版本，或检查版本是否存在' });
    await pipeline.projectProgress.save();
    res.json({ success: true, versions: pipeline.projectProgress.getCharacterDnaVersions()[characterName] || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use('/api/projects/:projectName', createComicLegacyGuard(getPipeline));

// 启动生图流水线
app.post('/api/projects/:projectName/pipeline/start', async (req, res) => {
  try {
    const { projectName } = req.params;
    const queued = globalQueueManager.enqueuePromptJob({
      projectName,
      type: 'pipeline',
      payload: { autoUpdateCharacterDna: true }
    });

    const message = queued.duplicate
      ? "流水线已在队列中，请勿重复启动"
      : queued.state === 'starting'
        ? "批量生图流水线已启动..."
        : `批量生图流水线已进入全局队列，当前排在第 ${queued.position} 位`;

    res.json({ success: true, message, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 停止生图流水线（瞬时硬刹车 + 队列清空）
app.post('/api/projects/:projectName/pipeline/start-llm-only', async (req, res) => {
  try {
    const { projectName } = req.params;
    // 仅提炼：只跑 LLM 阶段（分镜 + 角色 DNA + Prompt 组装），不进 NAI 生图队列。
    // 场景 Prompt 落盘为 PROMPT_READY，之后可用「仅生图」继续出图。
    const queued = globalQueueManager.enqueuePromptJob({
      projectName,
      type: 'pipeline_llm_only',
      payload: { autoUpdateCharacterDna: true }
    });

    const message = queued.duplicate
      ? "LLM 提炼已在队列中，请勿重复启动"
      : queued.state === 'starting'
        ? "LLM 提炼已启动（仅提炼，不生图）..."
        : `LLM 提炼已进入全局队列（仅提炼，不生图），当前排在第 ${queued.position} 位`;

    res.json({ success: true, message, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:projectName/pipeline/stop', async (req, res) => {
  try {
    const { projectName } = req.params;
    await globalQueueManager.cancelProjectJobs(projectName);
    agentRouter.stopComicProduction(projectName);

    // 清空老队列记录（兼容旧读取）
    const chapterQ = getChapterQueue(projectName);
    if (chapterQ) {
      chapterQ.items = [];
      chapterQ.current = null;
      chapterQ.running = false;
    }
    const redrawQ = getRedrawQueue(projectName);
    if (redrawQ) {
      redrawQ.items = [];
      redrawQ.current = null;
      redrawQ.running = false;
    }
    const selectedQ = getSelectedScenesQueue(projectName);
    if (selectedQ) {
      selectedQ.items = [];
      selectedQ.running = false;
    }

    res.json({ success: true, message: "流水线已瞬时停止，所有任务已安全暂停" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 批量仅生图（将已就绪 Prompt 但未出图的场景全部推入 NAI 生图队列）
app.post('/api/projects/:projectName/pipeline/render-ready', async (req, res) => {
  try {
    const { projectName } = req.params;
    const { chapterKey = null } = req.body || {};
    const pipeline = await getPipeline(projectName);

    if (pipeline.isRunning) {
      return res.status(400).json({ error: "流水线已在运行中，请先暂停后再排队生图" });
    }

    await pipeline.initialize();
    const completedChapters = pipeline.projectProgress.getCompletedChapters();
    let candidateChapterKeys = [];

    if (chapterKey) {
      const targetNormalized = pipeline.projectProgress.normalizeKey(chapterKey);
      const foundKey = Object.keys(completedChapters).find(k =>
        pipeline.projectProgress.normalizeKey(k) === targetNormalized
      ) || pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
      candidateChapterKeys = [foundKey];
    } else {
      if (Array.isArray(pipeline.chapters)) {
        for (const c of pipeline.chapters) {
          const ck = pipeline.projectProgress.getEffectiveChapKey(c.volume, c.chapter, c.ordinal);
          if (completedChapters[ck]) {
            candidateChapterKeys.push(ck);
          }
        }
      }
      for (const k of Object.keys(completedChapters)) {
        if (!candidateChapterKeys.includes(k)) {
          candidateChapterKeys.push(k);
        }
      }
    }

    const queuedScenes = [];
    for (const chapKey of candidateChapterKeys) {
      const chapterData = completedChapters[chapKey];
      if (!chapterData || !Array.isArray(chapterData.scenes)) continue;

      for (const scene of chapterData.scenes) {
        const hasPrompt = Boolean(
          scene.final_prompt?.trim() ||
          scene.prepared_prompt?.finalPositive?.trim() ||
          scene.prepared_prompt?.basePrompt?.trim()
        );
        const needsRender = !scene.image_path || scene.image_path === 'failed' || scene.status !== 'SUCCESS';

        if (hasPrompt && needsRender) {
          const queued = enqueueRedraw(projectName, pipeline, chapKey, chapKey, scene.scene_idx, 'nai_only');
          queuedScenes.push({
            chapterKey: chapKey,
            sceneIdx: scene.scene_idx,
            duplicate: queued.duplicate,
            position: queued.position
          });
        }
      }
    }

    if (queuedScenes.length === 0) {
      return res.json({
        success: true,
        message: "没有找到待生图的就绪场景",
        count: 0,
        queued: []
      });
    }

    const addedCount = queuedScenes.filter(s => !s.duplicate).length;
    broadcastSSE('log', {
      text: `🎨 已将 ${addedCount} 个就绪场景加入 NAI 生图队列${chapterKey ? `（章节: ${chapterKey}）` : ''}...`,
      type: 'info'
    });

    res.json({
      success: true,
      message: `已将 ${addedCount} 个场景排入生图队列`,
      count: addedCount,
      total: queuedScenes.length,
      queued: queuedScenes
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 启动单章强制生图流水线
app.post('/api/projects/:projectName/chapters/:chapterKey/generate', async (req, res) => {
  try {
    const { projectName, chapterKey } = req.params;
    const mode = req.body?.mode === 'redraw' ? 'redraw' : 'complete';
    const pipeline = await getPipeline(projectName);
    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    const queued = enqueueChapterGeneration(projectName, pipeline, chapterKey, effectiveKey, mode);
    const actionLabel = mode === 'redraw' ? '清空重绘' : '补完';
    const message = queued.duplicate
      ? `单章 ${chapterKey} 已在队列中`
      : queued.state === 'running'
        ? `单章 ${chapterKey} 已开始${actionLabel}`
        : `单章 ${chapterKey} 已加入${actionLabel}队列，当前位置 ${queued.position}`;
    res.json({ success: true, mode, message, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const selectedScenesQueues = new Map();

function getSelectedScenesQueue(projectName) {
  if (!selectedScenesQueues.has(projectName)) {
    selectedScenesQueues.set(projectName, {
      running: false,
      items: []
    });
  }
  return selectedScenesQueues.get(projectName);
}

async function processSelectedScenesQueue(projectName) {
  const queue = getSelectedScenesQueue(projectName);
  if (queue.running) return;
  queue.running = true;

  let pipeline;
  try {
    pipeline = await getPipeline(projectName);

    while (queue.items.length > 0) {
      if (pipeline.isRunning) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      const job = queue.items.shift();
      try {
        console.log(`[Queue] 开始处理排队中的选段生图任务 (项目: ${projectName}, 章节: ${job.chapterKey})`);
        broadcastSSE('pipeline_started', { projectName });
        const result = await pipeline.appendSelectedParagraphScenes(job.chapterKey, job.selections);
        if (queue.items.length === 0) {
          broadcastSSE('pipeline_completed', { projectName, type: 'selected_scenes', ...result });
        } else {
          broadcastSSE('log', { text: `🟢 选段生图任务已完成，队列中还剩 ${queue.items.length} 个任务等待执行...`, type: 'info' });
        }
      } catch (error) {
        console.error(`[Queue] 选段生图任务异常:`, error);
        if (queue.items.length === 0) {
          broadcastSSE('pipeline_failed', { projectName, message: error.message });
        } else {
          broadcastSSE('log', { text: `❌ 选段生图任务失败: ${error.message}，将继续处理下一个排队任务。`, type: 'error' });
        }
      }
    }
  } catch (err) {
    console.error(`[Queue] 选段生成队列执行异常:`, err);
  } finally {
    queue.running = false;
    if (pipeline) {
      const redrawQueue = getRedrawQueue(projectName);
      if (redrawQueue && redrawQueue.items.length > 0 && !pipeline.isRunning) {
        void processRedrawQueue(projectName, pipeline, redrawQueue);
      }
    }
  }
}

app.post('/api/projects/:projectName/chapters/:chapterKey/selected-scenes', async (req, res) => {
  try {
    const { projectName, chapterKey } = req.params;
    const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
    if (selections.length === 0) {
      return res.status(400).json({ error: "请至少选择一段正文" });
    }

    const queued = globalQueueManager.enqueuePromptJob({
      projectName,
      type: 'selected_scenes',
      chapterKey,
      payload: { selections }
    });

    res.json({
      success: true,
      message: `已提交 ${selections.length} 处正文选段，已加入全局队列（当前排队位置: ${queued.position}）`,
      ...queued
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 单场景重绘 (只重发 NAI)
app.post('/api/projects/:projectName/chapters/:chapterKey/scenes/:sceneIdx/redraw', async (req, res) => {
  try {
    const { projectName, chapterKey, sceneIdx } = req.params;
    const pipeline = await getPipeline(projectName);

    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    const queued = enqueueRedraw(projectName, pipeline, chapterKey, effectiveKey, sceneIdx, 'refresh_prompt');
    const message = queued.duplicate
      ? `场景 #${sceneIdx} 已在重绘队列中`
      : queued.priority
        ? `场景 #${sceneIdx} 已加入插队队列，将在当前生图完成后优先重算 Prompt`
      : `场景 #${sceneIdx} 已加入重绘队列，当前位置 ${queued.position}`;
    res.json({ success: true, message, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 仅使用已保存 Prompt 的 NAI 重绘
app.post('/api/projects/:projectName/chapters/:chapterKey/scenes/:sceneIdx/redraw-nai', async (req, res) => {
  try {
    const { projectName, chapterKey, sceneIdx } = req.params;
    const pipeline = await getPipeline(projectName);
    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    const queued = enqueueRedraw(projectName, pipeline, chapterKey, effectiveKey, sceneIdx, 'nai_only');
    const message = queued.duplicate
      ? `场景 #${sceneIdx} 的仅 NAI 重绘已在队列中`
      : queued.priority
        ? `场景 #${sceneIdx} 已加入插队队列，将在当前生图完成后优先执行仅 NAI 重绘`
      : `场景 #${sceneIdx} 已加入仅 NAI 重绘队列，当前位置 ${queued.position}`;
    res.json({ success: true, message, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 单场景描述重构并重绘 (LLM 重构描述 + NAI 生图)
app.post('/api/projects/:projectName/chapters/:chapterKey/scenes/:sceneIdx/regenerate', async (req, res) => {
  try {
    const { projectName, chapterKey, sceneIdx } = req.params;
    const pipeline = await getPipeline(projectName);
    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);

    // 走全局 Prompt 队列（插队）：先重写分镜描述并重建 Prompt，再以优先级进入串行生图队列
    const queued = globalQueueManager.enqueuePromptJob({
      projectName,
      type: 'regenerate_scene',
      chapterKey: effectiveKey,
      payload: { sceneIdx: Number(sceneIdx) },
      priority: true
    });

    const message = queued.duplicate
      ? `场景 #${sceneIdx} 的重构任务已在全局队列中`
      : `场景 #${sceneIdx} 已加入全局队列（插队）：先重构描述与 Prompt，再优先出图`;

    res.json({ success: true, message, ...queued });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:projectName/chapters/:chapterKey/scenes/:sceneIdx', async (req, res) => {
  try {
    const { projectName, chapterKey, sceneIdx } = req.params;
    const pipeline = await getPipeline(projectName);

    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    // 只有该场景此刻正在被处理时才拒绝编辑；仅排队等待的场景允许编辑
    if (pipeline.isSceneProcessing(effectiveKey, sceneIdx)
      || isSceneRunningInRedrawQueue(projectName, effectiveKey, sceneIdx)) {
      return res.status(409).json({ error: "该场景正在处理中，完成后再编辑" });
    }
    const result = await pipeline.updateSceneCard(effectiveKey, sceneIdx, req.body || {});
    res.json({ success: true, message: `场景 #${sceneIdx} 已保存`, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:projectName/chapters/:chapterKey/scenes/:sceneIdx', async (req, res) => {
  try {
    const { projectName, chapterKey, sceneIdx } = req.params;
    const pipeline = await getPipeline(projectName);

    if (pipeline.isRunning) {
      return res.status(400).json({ error: "流水线正在运行中，请先暂停后再删除场景" });
    }

    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    const removedQueuedRedraws = removeQueuedJobs(
      getRedrawQueue(projectName),
      job => pipeline.projectProgress.normalizeKey(job.effectiveKey) === pipeline.projectProgress.normalizeKey(effectiveKey)
        && Number(job.sceneIdx) === Number(sceneIdx)
    );
    globalQueueManager.removeQueuedScene(projectName, effectiveKey, sceneIdx);
    const result = await pipeline.deleteScene(effectiveKey, sceneIdx);
    res.json({ success: true, message: `场景 #${sceneIdx} 已删除`, removedQueuedRedraws, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 查询当前项目流水线与队列状态
app.get('/api/projects/:projectName/pipeline/status', async (req, res) => {
  try {
    const { projectName } = req.params;
    const state = globalQueueManager.getProjectQueueState(projectName);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 查询全局 Prompt 与 Image 双队列状态快照
app.get('/api/global-queue/status', (req, res) => {
  try {
    res.json(globalQueueManager.getGlobalState());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === 4. EPUB 打包编译 API ===

const epubJobs = new Map();
app.get('/api/projects/:projectName/epub-status', (req, res) => {
  res.json(epubJobs.get(req.params.projectName) || { status: 'idle' });
});

app.post('/api/projects/:projectName/build-epub', async (req, res) => {
  const { projectName } = req.params;
  if (epubJobs.get(projectName)?.status === 'running') {
    return res.status(409).json({ error: '该项目的 EPUB 正在打包' });
  }
  const job = { status: 'running', phase: '准备章节', done: 0, total: 0, percent: 0 };
  epubJobs.set(projectName, job);
  try {
    const pipeline = await getPipeline(projectName);

    console.log(`[Server] 开始为项目 ${projectName} 构建 EPUB 电子书...`);

    // 刷新章节和进度；插图正文在下方按章节直接生成。
    await pipeline.initialize();
    job.phase = '处理章节和插图';
    job.total = pipeline.chapters.length;

    // 2. 实例化 EPUBBuilder
    const outputEpubName = `${projectName}.epub`;
    const outputPath = path.join(pipeline.projBase, outputEpubName);
    
    const builder = new EPUBBuilder(projectName, pipeline.config.author || "AI Illustrator", outputPath);

    // 3. 填入所有章节内容
    for (const chap of pipeline.chapters) {
      const chapKey = pipeline.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter, chap.ordinal);
      const progress = pipeline.projectProgress.getCompletedChapters()[chapKey];
      let content = chap.content;

      if (progress && Array.isArray(progress.scenes)) {
        const insertions = [];
        for (const scene of progress.scenes) {
          if (scene.status === 'SUCCESS' && scene.image_path) {
            const image = await readEpubImage(pipeline.projBase, scene.image_path);
            const epubImgName = await builder.addImage(image.name, image.data);
            insertions.push({
              imageName: epubImgName,
              paragraph: String(scene.source_paragraph || '').trim(),
              trigger: String(scene.trigger_sentence || '').trim()
            });
          }
        }

        content = insertIllustrationsAfterParagraphs(content, insertions);
      }

      builder.addChapter(chap.volume, chap.chapter, content);
      job.done++;
    }

    // 4. 执行打包输出
    job.phase = '压缩并写入电子书';
    await builder.build(percent => { job.percent = Math.floor(percent); });

    // 5. 自动复制到挂载出来的导出目录（NAS 上直接可见）；失败不影响下载
    let exportedTo = '';
    try {
      exportedTo = await copyToDir(outputPath, epubExportDir(BASE_DIR));
      console.log(`[EPUB] 已复制到导出目录: ${exportedTo}`);
    } catch (err) {
      console.warn(`[EPUB] 复制到导出目录失败（项目内文件仍可下载）: ${err.message}`);
    }
    if (exportedTo) job.exportPath = exportedTo;

    Object.assign(job, { status: 'done', phase: '打包完成', percent: 100, downloadUrl: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(outputEpubName)}` });

    res.json({
      success: true,
      downloadUrl: `/projects/${projectName}/${outputEpubName}`,
      outputPath,
      exportPath: exportedTo || undefined
    });

  } catch (error) {
    Object.assign(job, { status: 'failed', phase: '打包失败', error: error.message });
    console.error("[Server] EPUB 构建异常:", error);
    res.status(500).json({ error: error.message });
  }
});

// === 5. SSE 实时事件推送接口 ===

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`[SSE] 新客户端已连接，当前活跃链接数: ${sseClients.size}`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] 客户端连接已关闭，当前活跃链接数: ${sseClients.size}`);
  });
});

// Agent facade uses the same managers and queues as the web UI.
const agentRouter = createAgentRouter({
  baseDir: BASE_DIR,
  getPipeline,
  enqueueRedraw,
  notify: broadcastSSE,
  queueState(projectName) {
    return globalQueueManager.getProjectQueueState(projectName);
  },
  stopQueues(projectName) {
    void globalQueueManager.cancelProjectJobs(projectName);
    const queues = [getRedrawQueue(projectName), getChapterQueue(projectName), getSelectedScenesQueue(projectName)];
    const actionIds = queues.flatMap(q => q.items.map(j => j.agentActionId).filter(Boolean));
    const removed = queues.reduce((sum, q) => sum + q.items.length, 0);
    for (const q of queues) q.items = [];
    return { removed, actionIds };
  }
});
app.use('/api/agent', agentRouter);
app.use('/api/comic', agentRouter.humanRouter);

// 有声书生产管线（独立于生图管线，复用书籍/章节数据）
app.use('/api/audiobook', createAudiobookRouter({
  baseDir: BASE_DIR,
  getPipeline,
  safeProjectPath
}));

// 启动监听
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 NovelAI Illustrator 后端服务器已启动！`);
  console.log(`🔗 本地 API 访问地址: http://localhost:${PORT}`);
  console.log(`📁 数据根目录: ${BASE_DIR}`);
  console.log(`====================================================`);
});
