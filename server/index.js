import './utils/terminal-logger.js';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { PipelineManager } from './services/pipeline-manager.js';
import { EPUBBuilder, insertIllustrationsAfterParagraphs } from './services/epub-builder.js';
import { globalCooldownManager } from './utils/cooldown.js';
import { enqueueUniqueJob, removeQueuedJobs } from './utils/job-queue.js';
import { readJson, writeJsonAtomic } from './utils/db.js';
import { parseFile } from './utils/file-parser.js';
import { DEFAULT_EXTRACT_SCENES_PROMPT, DEFAULT_CHARACTER_DNA_PROMPT, DEFAULT_ADVANCED_PROMPT, DEFAULT_ADVANCED_PROMPT_V45_NL } from './utils/default-prompts.js';

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
  artistStylePrompt: "4::masterpiece, best quality ::, 2::official art, year2024, year2025 ::, 2.25::Artist:youngjoo kjy ::, 1.45::artist:nardack ::, 1.25::Artist:rella ::, 1.05::Artist:qiandaiyiyu ::, 1.05::Artist:atdan ::, 0.85::Artist:void_0 ::, 0.65::Artist:stu_dts ::, 0.75::Artist:wo_jiushi_kanbudong ::, 0.75::Artist:nixeu ::, -3::3D ::, 1.35::rim lighting, deep shadows, volumetric lighting, high contrast, cinematic lighting ::, no text",
  nai_url: "https://image.novelai.net",
  system_prompt_extract_scenes: DEFAULT_EXTRACT_SCENES_PROMPT,
  system_prompt_character_dna: DEFAULT_CHARACTER_DNA_PROMPT,
  system_prompt_advanced_prompt_nl: DEFAULT_ADVANCED_PROMPT_V45_NL,
  system_prompt_advanced_prompt: DEFAULT_ADVANCED_PROMPT
};

function normalizeConfig(config = {}) {
  const normalized = { ...DEFAULT_CONFIG, ...config };
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
      const content = await fs.readFile(CONFIG_PATH, 'utf8');
      if (content.trim()) {
        const config = JSON.parse(content);
        if (config.proxy_url) {
          proxyUrl = config.proxy_url;
        }
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

// 静态托管项目资源（可直接通过 /projects/项目名/illustrations/图片名 加载图片）
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

  const config = { ...DEFAULT_CONFIG, ...(await readJson(CONFIG_PATH, {})) };

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
        queue.current = null;
      }
    }
  } finally {
    queue.running = false;
  }
}

function enqueueRedraw(projectName, pipeline, chapterKey, effectiveKey, sceneIdx, mode = 'refresh_prompt') {
  const queue = getRedrawQueue(projectName);
  const key = redrawJobKey(effectiveKey, sceneIdx, mode);
  const result = enqueueUniqueJob(queue, {
    key,
    busy: pipeline.isRunning,
    jobFactory: () => ({
      key,
      chapterKey,
      effectiveKey,
      sceneIdx: Number(sceneIdx),
      mode
    })
  });

  if (result.duplicate) {
    return result;
  }

  broadcastSSE('redraw_queue', {
    projectName,
    chapterKey,
    sceneIdx: Number(sceneIdx),
    state: 'queued',
    position: result.position,
    remaining: queue.items.length,
    priority: pipeline.isRunning
  });
  if (!pipeline.isRunning) {
    void processRedrawQueue(projectName, pipeline, queue);
  }
  return {
    ...result,
    priority: pipeline.isRunning
  };
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

function enqueueChapterGeneration(projectName, pipeline, chapterKey, effectiveKey) {
  const queue = getChapterQueue(projectName);
  const key = chapterJobKey(effectiveKey);
  const result = enqueueUniqueJob(queue, {
    key,
    busy: pipeline.isRunning,
    jobFactory: () => ({
      key,
      chapterKey,
      effectiveKey
    })
  });

  if (result.duplicate) {
    return result;
  }

  broadcastSSE('chapter_queue', {
    projectName,
    chapterKey,
    state: 'queued',
    position: result.position,
    remaining: queue.items.length
  });
  void processChapterQueue(projectName);
  return result;
}

// === 1. 全局配置 API ===

app.get('/api/config', async (req, res) => {
  try {
    const config = normalizeConfig(await readJson(CONFIG_PATH, {}));
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const newConfig = normalizeConfig(req.body);
    await writeJsonAtomic(CONFIG_PATH, newConfig);
    
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
        projects.push({ name, createdAt: stats.birthtime });
      }
    }
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 解析导入小说文件 (.txt, .docx, .epub)
app.post('/api/parse-file', async (req, res) => {
  try {
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
      chapters: pipeline.chapters.map(c => ({ volume: c.volume, chapter: c.chapter, wordCount: c.content.length })),
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
    const chapter = pipeline.chapters.find(item => {
      const key = pipeline.projectProgress.getEffectiveChapKey(item.volume, item.chapter);
      return pipeline.projectProgress.normalizeKey(key) === pipeline.projectProgress.normalizeKey(chapterKey);
    });
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
      broadcastSSE('characters_completed', dict);
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

// 覆盖更新指定角色结构化 DNA 特征
app.put('/api/projects/:projectName/characters/:characterName/features', async (req, res) => {
  try {
    const { projectName, characterName } = req.params;
    const features = req.body?.features || {};
    const pipeline = await getPipeline(projectName);

    if (!characterName) {
      return res.status(400).json({ error: "角色名不能为空" });
    }

    const updated = pipeline.projectProgress.setCharacterDNAFeatures(characterName, features);
    if (!updated) {
      return res.status(404).json({ error: `未找到角色「${characterName}」` });
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

// 启动生图流水线
app.post('/api/projects/:projectName/pipeline/start', async (req, res) => {
  try {
    const { projectName } = req.params;
    const pipeline = await getPipeline(projectName);

    if (pipeline.isRunning) {
      return res.json({ success: false, message: "流水线已在运行中，请勿重复启动" });
    }

    // 后台异步跑流水线，避免网关请求超时
    pipeline.processPipeline(null, { autoUpdateCharacterDna: true }).then((result) => {
      if (!result?.paused) {
        broadcastSSE('pipeline_completed', { projectName });
      }
    }).catch(err => {
      broadcastSSE('pipeline_failed', { message: err.message });
    });

    res.json({ success: true, message: "批量生图流水线已启动..." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 停止生图流水线
app.post('/api/projects/:projectName/pipeline/stop', async (req, res) => {
  try {
    const { projectName } = req.params;
    const pipeline = await getPipeline(projectName);
    pipeline.isRunning = false;
    res.json({ success: true, message: "已向流水线发送停止指令" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 启动单章强制生图流水线
app.post('/api/projects/:projectName/chapters/:chapterKey/generate', async (req, res) => {
  try {
    const { projectName, chapterKey } = req.params;
    const pipeline = await getPipeline(projectName);
    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    const queued = enqueueChapterGeneration(projectName, pipeline, chapterKey, effectiveKey);
    const message = queued.duplicate
      ? `单章 ${chapterKey} 已在队列中`
      : queued.state === 'running'
        ? `单章 ${chapterKey} 已开始执行`
        : `单章 ${chapterKey} 已加入重画队列，当前位置 ${queued.position}`;
    res.json({ success: true, message, ...queued });
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

    const queue = getSelectedScenesQueue(projectName);
    queue.items.push({ chapterKey, selections });

    // 异步执行队列处理
    void processSelectedScenesQueue(projectName);

    res.json({ success: true, message: `已提交 ${selections.length} 处正文选段，已加入生图队列（当前排队位置: ${queue.items.length}）` });
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

    if (pipeline.isRunning) {
      return res.status(400).json({ error: "流水线已在运行中，请先暂停后再进行操作" });
    }

    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
    // 异步执行
    pipeline.regenerateAndRedrawScene(effectiveKey, sceneIdx).catch(err => {
      console.error(`[Server] 单场景重构并重绘异常: ${err.message}`);
    });

    res.json({ success: true, message: `单场景 #${sceneIdx} 描述重构与重绘已在后台启动` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:projectName/chapters/:chapterKey/scenes/:sceneIdx', async (req, res) => {
  try {
    const { projectName, chapterKey, sceneIdx } = req.params;
    const pipeline = await getPipeline(projectName);

    if (pipeline.isRunning) {
      return res.status(400).json({ error: "流水线正在运行中，请先暂停后再编辑场景" });
    }

    const effectiveKey = pipeline.projectProgress.getEffectiveChapKeyByRaw(chapterKey);
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
    const result = await pipeline.deleteScene(effectiveKey, sceneIdx);
    res.json({ success: true, message: `场景 #${sceneIdx} 已删除`, removedQueuedRedraws, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 查询当前状态
app.get('/api/projects/:projectName/pipeline/status', async (req, res) => {
  try {
    const { projectName } = req.params;
    const pipeline = await getPipeline(projectName);
    res.json({
      isRunning: pipeline.isRunning,
      projectName: pipeline.projectName,
      remainingCooldown: globalCooldownManager.getRemainingSeconds(),
      cooldown: globalCooldownManager.getState(),
      redrawQueue: {
        running: Boolean(redrawQueues.get(projectName)?.running),
        pending: redrawQueues.get(projectName)?.items.length || 0,
        current: redrawQueues.get(projectName)?.current
          ? {
              chapterKey: redrawQueues.get(projectName).current.chapterKey,
              sceneIdx: redrawQueues.get(projectName).current.sceneIdx
            }
          : null
      },
      chapterQueue: {
        running: Boolean(chapterQueues.get(projectName)?.running),
        pending: chapterQueues.get(projectName)?.items.length || 0,
        pendingChapterKeys: chapterQueues.get(projectName)?.items.map(item => item.chapterKey) || [],
        current: chapterQueues.get(projectName)?.current
          ? {
              chapterKey: chapterQueues.get(projectName).current.chapterKey
            }
          : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === 4. EPUB 打包编译 API ===

app.post('/api/projects/:projectName/build-epub', async (req, res) => {
  try {
    const { projectName } = req.params;
    const pipeline = await getPipeline(projectName);

    console.log(`[Server] 开始为项目 ${projectName} 构建 EPUB 电子书...`);

    // 1. 生成带插图正文
    const illustratedText = await pipeline.buildNovelWithIllustrations();

    // 2. 实例化 EPUBBuilder
    const outputEpubName = `${projectName}.epub`;
    const outputPath = path.join(pipeline.projBase, outputEpubName);
    
    const builder = new EPUBBuilder(projectName, pipeline.config.author || "AI Illustrator", outputPath);

    // 3. 填入所有章节内容
    for (const chap of pipeline.chapters) {
      const chapKey = pipeline.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
      const progress = pipeline.projectProgress.getCompletedChapters()[chapKey];
      let content = chap.content;

      if (progress && Array.isArray(progress.scenes)) {
        const insertions = [];
        for (const scene of progress.scenes) {
          if (scene.status === 'SUCCESS' && scene.image_path) {
            const imgName = path.basename(scene.image_path);
            const imgBytes = await fs.readFile(path.join(pipeline.projBase, scene.image_path));
            const epubImgName = await builder.addImage(imgName, imgBytes);
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
    }

    // 4. 执行打包输出
    await builder.build();

    res.json({
      success: true,
      downloadUrl: `/projects/${projectName}/${outputEpubName}`,
      outputPath
    });

  } catch (error) {
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

// 启动监听
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 NovelAI Illustrator 后端服务器已启动！`);
  console.log(`🔗 本地 API 访问地址: http://localhost:${PORT}`);
  console.log(`📁 数据根目录: ${BASE_DIR}`);
  console.log(`====================================================`);
});
