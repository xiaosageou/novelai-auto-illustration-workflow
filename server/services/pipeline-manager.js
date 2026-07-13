import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ProjectProgress } from '../utils/db.js';
import { getSceneCountMetrics, inferSceneInteractionActions, LLMExtractor } from './llm-extractor.js';
import { NovelAIClient } from './nai-client.js';
import { buildFinalImagePrompt } from './prompt-builder.js';
import { loadVibeBundleForModel } from '../utils/vibe-bundle.js';
import { normalizeSceneCard, serializeSceneForMatching } from '../utils/scene-structure.js';
import { findOriginalTriggerSentence } from '../utils/prompt-cleaner.js';
import { globalCooldownManager } from '../utils/cooldown.js';
import { extractChapterScenesInBatches } from '../utils/chapter-scene-batching.js';

const CHARACTER_DNA_LONG_CHAPTER_THRESHOLD = 5000;
const CHARACTER_DNA_LONG_CHAPTER_BATCH_SIZE = 5;
const VERSIONED_DNA_FEATURE_KEYS = ['发型标签', '发色标签', '服装基底标签', '特殊特征标签'];

function normalizedFeatureValues(features = {}, keys = VERSIONED_DNA_FEATURE_KEYS) {
  return keys.flatMap(key => Array.isArray(features?.[key]) ? features[key] : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function hasPersistentAppearanceChange(previous = null, next = {}) {
  if (!previous) return true;
  const oldValues = normalizedFeatureValues(previous.features);
  const nextValues = normalizedFeatureValues(next.features);
  return oldValues.join('|') !== nextValues.join('|');
}

function buildSupersededAppearanceNegative(previous = null, next = {}) {
  if (!previous) return '';
  const nextValues = new Set(normalizedFeatureValues(next.features));
  return normalizedFeatureValues(previous.features)
    .filter(value => !nextValues.has(value))
    .join(', ');
}

function resolveAppearanceVersionStartIndex(version = {}, info, batchSourceChapters = []) {
  const requested = String(version?.start_chapter || version?.startChapter || '').trim();
  if (!requested) return info.startIndex;
  const allChapterLabels = info.chapters.map((chapter, index) => ({
    index: info.startIndex + index,
    labels: [`${chapter.volume}_${chapter.chapter}`, chapter.chapter, `${chapter.volume} / ${chapter.chapter}`]
  }));
  return allChapterLabels.find(item => item.labels.some(label => label === requested))?.index
    ?? info.startIndex + Math.max(0, batchSourceChapters.indexOf(requested));
}

function normalizePresetList(presets = []) {
  return (Array.isArray(presets) ? presets : []).map(preset => ({
    ...preset,
    rateLimitEnabled: preset?.rateLimitEnabled !== false,
    rateLimitRpm: Number(preset?.rateLimitRpm) || 3
  }));
}

function normalizeCharacterPromptInteractionEntry(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const role = String(raw?.role || '').trim();
  const action = String(raw?.action || '').trim();
  const target = String(raw?.target || '').trim();
  if (!role || !action || !target) return null;
  return { role, action, target };
}

function normalizeCharacterPromptInteractionList(raw = null) {
  if (Array.isArray(raw)) {
    return raw
      .map(item => normalizeCharacterPromptInteractionEntry(item))
      .filter(Boolean);
  }
  const nested = Array.isArray(raw?.interactions) ? raw.interactions : null;
  if (nested) {
    return nested
      .map(item => normalizeCharacterPromptInteractionEntry(item))
      .filter(Boolean);
  }
  const single = normalizeCharacterPromptInteractionEntry(raw);
  return single ? [single] : [];
}

export function resolveTaskLlmConfig(config = {}, task = 'scene') {
  const prefixMap = {
    characterDna: 'llm_character_dna',
    scene: 'llm_scene',
    naiTags: 'llm_nai_tags',
    trim: 'llm_trim'
  };
  const prefix = prefixMap[task] || prefixMap.scene;
  const presets = normalizePresetList(config.llm_api_presets);
  const defaultPreset = presets.find(preset => preset.id === config.llm_preset_id);
  const taskPreset = presets.find(preset => preset.id === config[`${prefix}_preset_id`]);
  const hasDirectOverride = Boolean(
    String(config[`${prefix}_url`] || '').trim()
    || String(config[`${prefix}_key`] || '').trim()
  );
  const activePreset = taskPreset || defaultPreset || null;

  if (activePreset && !hasDirectOverride) {
    return {
      baseUrl: activePreset.url || "",
      apiKey: activePreset.key || "",
      model: config[`${prefix}_model`] || activePreset.model || config.llm_model || "deepseek-chat",
      streamEnabled: config.llm_stream_enabled !== false,
      rateLimitEnabled: activePreset.rateLimitEnabled !== false,
      rateLimitRpm: Number(activePreset.rateLimitRpm) || 3,
      rateLimitKey: `preset:${activePreset.id}`
    };
  }

  return {
    baseUrl: config[`${prefix}_url`] || config.llm_url || "",
    apiKey: config[`${prefix}_key`] || config.llm_key || "",
    model: config[`${prefix}_model`] || config.llm_model || "deepseek-chat",
    streamEnabled: config.llm_stream_enabled !== false,
    rateLimitEnabled: config.llm_rate_limit_enabled !== false,
    rateLimitRpm: Number(config.llm_rate_limit_rpm) || 3,
    rateLimitKey: task === 'scene'
      ? 'direct:scene'
      : task === 'characterDna'
        ? 'direct:character-dna'
        : 'direct:nai-tags'
  };
}

export class PipelineManager {
  constructor(config = {}) {
    this.config = config;
    this.projectName = config.projectName || "默认项目";
    this.baseDir = process.cwd(); // 当前工作目录
    
    // 初始化子组件
    this.naiClient = new NovelAIClient({
      token: this.config.nai_token || "",
      baseUrl: this.config.nai_url || "https://image.novelai.net"
    });
    globalCooldownManager.setBaseCooldownSeconds(this.config.nai_cooldown_seconds ?? 15);
    this.rebuildLlmExtractors();

    this.isRunning = false;
    this.chapters = [];
    this.projectProgress = null;
    this.uiCooldownCallback = null;
    this.uiProgressCallback = null;
    this.uiLogCallback = null;
    this.priorityJobRunner = null;
    this.cachedVibeBundle = null;
    this.cachedVibeBundleKey = "";
    this.dnaSliceSize = Number(config.characterDnaSliceSize) || 10;
    this._pendingDnaSlices = new Set(); // 并行 LLM 处理时，防止同一 DNA 切片被多个 worker 重复提取

    // 自适应切换到对应项目
    this.switchProject(this.projectName);
  }

  writeLog(text, type = 'info', options = {}) {
    if (type === 'error') {
      console.error(text);
    } else if (type === 'warning') {
      console.warn(text);
    } else {
      console.log(text);
    }
    if (this.uiLogCallback) {
      try {
        this.uiLogCallback(text, type, options);
      } catch (e) {
        console.error("UI Log Callback error:", e);
      }
    }
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.cachedVibeBundle = null;
    this.cachedVibeBundleKey = "";
    this.naiClient.setToken(this.config.nai_token || "");
    this.naiClient.setBaseUrl(this.config.nai_url || "https://image.novelai.net");
    globalCooldownManager.setBaseCooldownSeconds(this.config.nai_cooldown_seconds ?? 15);
    this.rebuildLlmExtractors();
  }

  async runPriorityJobs() {
    if (!this.priorityJobRunner) return;
    await this.priorityJobRunner();
  }

  createLlmExtractor(task) {
    const connection = resolveTaskLlmConfig(this.config, task);
    const trimConnection = resolveTaskLlmConfig(this.config, 'trim');
    return new LLMExtractor({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      system_prompt_extract_scenes: this.config.system_prompt_extract_scenes || "",
      system_prompt_character_dna: this.config.system_prompt_character_dna || "",
      system_prompt_advanced_prompt: this.config.system_prompt_advanced_prompt || "",
      system_prompt_advanced_prompt_nl: this.config.system_prompt_advanced_prompt_nl || "",
      streamEnabled: connection.streamEnabled,
      rateLimitEnabled: connection.rateLimitEnabled,
      rateLimitRpm: connection.rateLimitRpm,
      rateLimitKey: connection.rateLimitKey,
      trimUrl: trimConnection.baseUrl,
      trimKey: trimConnection.apiKey,
      trimModel: trimConnection.model
    });
  }

  rebuildLlmExtractors() {
    this.characterDnaExtractor = this.createLlmExtractor('characterDna');
    this.sceneExtractor = this.createLlmExtractor('scene');
    this.naiTagsExtractor = this.createLlmExtractor('naiTags');
    // Keep the legacy property for external callers that may still reference it.
    this.llmExtractor = this.sceneExtractor;
  }

  /**
   * 动态切换项目目录并加载项目数据
   */
  switchProject(name) {
    this.projectName = name;
    this.projBase = path.join(this.baseDir, 'projects', name);
    this.novelPath = path.join(this.projBase, 'book.txt');
    this.illustrationsDir = path.join(this.projBase, 'illustrations');
    
    // 实例化进度管理
    this.projectProgress = new ProjectProgress(this.projBase);
    this.chapters = [];
  }

  /**
   * 初始化项目（解析小说正文 + 加载进度）
   */
  async initialize() {
    // 确保项目目录及插画目录存在
    await fs.mkdir(this.projBase, { recursive: true });
    await fs.mkdir(this.illustrationsDir, { recursive: true });

    // 加载进度
    await this.projectProgress.load();
    // 解析小说
    await this.parseNovel();
  }

  /**
   * 智能分卷分章解析小说正文 book.txt
   */
  async parseNovel() {
    if (!existsSync(this.novelPath)) {
      this.chapters = [];
      return;
    }

    try {
      const text = await fs.readFile(this.novelPath, 'utf-8');
      const lines = text.split(/\r?\n/);
      
      this.chapters = [];
      let currentVolume = "第一卷";
      let currentChapter = "正文";
      let currentContent = [];

      const numberPattern = '[一二三四五六七八九十百千万两〇零\\d]+';
      const volPattern = new RegExp(`^\\s*(第\\s*${numberPattern}\\s*[卷篇部集])\\s*(.*)$`);
      const strictChapPattern = new RegExp(`^\\s*(第\\s*${numberPattern}\\s*(?:[:：]\\s*)?[章节回节])\\s*(.*)$`);
      const prefixedChapPattern = new RegExp(`^\\s*(.{1,40}?)\\s+(第\\s*${numberPattern}\\s*(?:[:：]\\s*)?[章节回节])\\s*(.*)$`);
      const specialChapPattern = /^\s*(?:正文\s+)?(序章|楔子|引子|序幕|尾声|后记|结局|终章|番外(?:篇)?(?:\s*[:：]?\s*.*)?)\s*$/;
      const prefixedSpecialChapPattern = /^\s*(.{1,40}?)\s+(序章|楔子|引子|序幕|尾声|后记|结局|终章|番外(?:篇)?(?:\s*[:：]?\s*.*)?)\s*$/;
      const westernChapPattern = /^\s*(?:chapter|chap\.?)\s*\d+\b[\s:：.-]*(.*)$/i;
      const parenthesesChapPattern = new RegExp(`^\\s*([（(]\\s*${numberPattern}\\s*[）)])\\s*(.*)$`);

      const parseChapterHeading = (stripped) => {
        if (!stripped || stripped.length > 100) return null;
        const strict = stripped.match(strictChapPattern);
        if (strict) return stripped;

        const parens = stripped.match(parenthesesChapPattern);
        if (parens) return stripped;

        const prefixed = stripped.match(prefixedChapPattern);
        if (prefixed) {
          const prefix = prefixed[1].trim();
          // 常见来源站点行或正文长句不应被当成章节；书名 + 第X章 这种短标题允许。
          if (/[,，。！？!?；;：“”"'、]/.test(prefix)) return null;
          return `${prefixed[2].replace(/\s+/g, '')}${prefixed[3] ? ` ${prefixed[3].trim()}` : ''}`.trim();
        }

        const special = stripped.match(specialChapPattern);
        if (special) return special[1].trim();

        const prefixedSpecial = stripped.match(prefixedSpecialChapPattern);
        if (prefixedSpecial) {
          const prefix = prefixedSpecial[1].trim();
          if (/[,，。！？!?；;：“”"'、]/.test(prefix)) return null;
          return prefixedSpecial[2].trim();
        }

        if (westernChapPattern.test(stripped)) return stripped;
        return null;
      };

      const saveChapter = (volume, chapter, contentLines) => {
        if (contentLines.length > 0) {
          this.chapters.push({
            volume,
            chapter,
            content: contentLines.join("\n").trim()
          });
        }
      };

      for (const line of lines) {
        const stripped = line.trim();
        if (!stripped) continue;

        const chapterHeading = parseChapterHeading(stripped);

        if (volPattern.test(stripped) && !chapterHeading) {
          saveChapter(currentVolume, currentChapter, currentContent);
          currentContent = [];
          currentVolume = stripped;
          currentChapter = "卷导言";
        } else if (chapterHeading) {
          saveChapter(currentVolume, currentChapter, currentContent);
          currentContent = [];
          currentChapter = chapterHeading;
        } else {
          currentContent.push(line);
        }
      }

      saveChapter(currentVolume, currentChapter, currentContent);

    } catch (error) {
      console.error("[Pipeline] 解析小说文本失败:", error);
    }
  }

  /**
   * 智能提取全书主要角色及其外貌 DNA 词典
   */
  async extractGlobalCharacters() {
    await this.initialize();
    
    if (this.chapters.length === 0) {
      return {};
    }

    console.log("[Pipeline] 启动全书角色 DNA 分切片智能提取流水线...");

    const totalSlices = Math.ceil(this.chapters.length / this.dnaSliceSize);
    for (let sliceIdx = 0; sliceIdx < totalSlices; sliceIdx++) {
      try {
        await this.extractCharacterDnaSlice(sliceIdx, { force: true });
      } catch (error) {
        console.error(`[Pipeline] 切片 ${sliceIdx + 1} 角色 DNA 提取异常:`, error);
      }
    }

    console.log("[Pipeline] 全书全局角色 DNA 大辞典构建完成！");
    return this.projectProgress.getGlobalCharacters();
  }

  getCharacterDnaSliceInfoByChapterIndex(chapterIndex) {
    const sliceIndex = Math.floor(chapterIndex / this.dnaSliceSize);
    const startIndex = sliceIndex * this.dnaSliceSize;
    const endIndex = Math.min(startIndex + this.dnaSliceSize, this.chapters.length);
    const chapters = this.chapters.slice(startIndex, endIndex);
    return {
      sliceIndex,
      sliceKey: `slice_${sliceIndex + 1}`,
      startIndex,
      endIndex,
      chapters,
      label: `第 ${startIndex + 1}-${endIndex} 章`
    };
  }

  async extractCharacterDnaSlice(sliceIndex, { force = false } = {}) {
    await this.initialize();
    const info = this.getCharacterDnaSliceInfoByChapterIndex(sliceIndex * this.dnaSliceSize);
    if (!force && this.projectProgress.isCharacterDnaSliceCompleted(info.sliceKey)) {
      return this.projectProgress.getGlobalCharacters();
    }

    const model = resolveTaskLlmConfig(this.config, 'characterDna').model;
    const sourceChapters = info.chapters.map(c => `${c.volume}_${c.chapter}`);
    const chapterCharCounts = info.chapters.map(c => String(c.content || '').replace(/\s/g, '').length);
    const averageChapterChars = chapterCharCounts.length > 0
      ? Math.round(chapterCharCounts.reduce((sum, count) => sum + count, 0) / chapterCharCounts.length)
      : 0;
    const batchSize = averageChapterChars > CHARACTER_DNA_LONG_CHAPTER_THRESHOLD
      ? CHARACTER_DNA_LONG_CHAPTER_BATCH_SIZE
      : info.chapters.length;
    const chapterBatches = [];
    for (let start = 0; start < info.chapters.length; start += batchSize) {
      chapterBatches.push(info.chapters.slice(start, start + batchSize));
    }

    this.writeLog(`[Pipeline] 正在更新角色 DNA 切片 ${info.label}... 平均每章约 ${averageChapterChars} 字，本次按每批 ${batchSize} 章发送。`);
    this.projectProgress.setCharacterDnaSliceStatus(info.sliceKey, {
      status: 'processing',
      sliceIndex: info.sliceIndex,
      startIndex: info.startIndex,
      endIndex: info.endIndex,
      chapters: sourceChapters,
      averageChapterChars,
      batchSize,
      batchCount: chapterBatches.length
    });
    await this.projectProgress.save();

    const allExtractedCharacters = [];
    for (let batchIndex = 0; batchIndex < chapterBatches.length; batchIndex++) {
      const batchChapters = chapterBatches[batchIndex];
      const batchSourceChapters = batchChapters.map(c => `${c.volume}_${c.chapter}`);
      const batchText = batchChapters
        .map(c => `【章节】: ${c.volume} / ${c.chapter}\n【正文】:\n${c.content}`)
        .join("\n\n---\n\n");

      if (chapterBatches.length > 1) {
        this.writeLog(`[Pipeline] 角色 DNA 切片 ${info.label} 第 ${batchIndex + 1}/${chapterBatches.length} 批：${batchSourceChapters.join(", ")}`);
      }

      const list = await this.characterDnaExtractor.extractCharacterDNA(batchText, model, {
        knownCharacters: this.projectProgress.getGlobalCharacters(),
        sourceChapters: batchSourceChapters
      });

      for (const char of list) {
        if (char && char.name && char.name.length >= 2) {
          allExtractedCharacters.push(char);
          this.projectProgress.updateCharacterDNA(char.name, {
            tags: char.tags || "",
            features: char.features,
            aliases: char.aliases || [],
            gender: char.gender || "",
            role_type: char.role_type || "",
            evidence: char.evidence || [],
            confidence: char.confidence || 0,
            height_class: char.height_class || "",
            body_proportion: char.body_proportion || "",
            source_chapters: char.source_chapters || batchSourceChapters,
            source_text_summary: char.source_text_summary || ""
          });

          const appearanceVersions = Array.isArray(char.appearance_versions) && char.appearance_versions.length > 0
            ? char.appearance_versions
            : [{
                start_chapter: batchSourceChapters[0],
                tags: char.tags || '',
                features: char.features || {},
                evidence: char.evidence || [],
                confidence: char.confidence || 0,
                persistent_change: false
          }];
          for (const appearanceVersion of appearanceVersions) {
            const startChapterIndex = resolveAppearanceVersionStartIndex(appearanceVersion, info, batchSourceChapters);
            const current = this.projectProgress.getCharacterDNAForChapter(char.name, startChapterIndex);
            const hasExistingVersions = Array.isArray(this.projectProgress.getCharacterDnaVersions()?.[char.name])
              && this.projectProgress.getCharacterDnaVersions()[char.name].length > 0;
            const isExplicitPersistentChange = appearanceVersion.persistent_change === true;
            if (hasExistingVersions && !isExplicitPersistentChange && !hasPersistentAppearanceChange(current, appearanceVersion)) {
              continue;
            }
            if (hasExistingVersions && !isExplicitPersistentChange && hasPersistentAppearanceChange(current, appearanceVersion)) {
              // A snapshot without a specific persistence assertion must not overwrite a prior visual state.
              continue;
            }
            this.projectProgress.upsertCharacterDnaVersion(char.name, {
              startChapterIndex,
              tags: appearanceVersion.tags || char.tags || '',
              features: appearanceVersion.features || char.features || {},
              evidence: appearanceVersion.evidence || char.evidence || [],
              confidence: appearanceVersion.confidence ?? char.confidence ?? 0,
              sourceSliceKey: info.sliceKey,
              sourceChapters: batchSourceChapters,
              supersededNegative: buildSupersededAppearanceNegative(current, appearanceVersion)
            });
          }
        }
      }

      await this.projectProgress.save();
    }

    this.projectProgress.setCharacterDnaSliceStatus(info.sliceKey, {
      status: 'completed',
      sliceIndex: info.sliceIndex,
      startIndex: info.startIndex,
      endIndex: info.endIndex,
      chapters: sourceChapters,
      averageChapterChars,
      batchSize,
      batchCount: chapterBatches.length,
      characterCount: new Set(allExtractedCharacters.filter(char => char?.name).map(char => char.name)).size
    });
    await this.projectProgress.save();
    this.writeLog(`[Pipeline] 角色 DNA 切片 ${info.label} 更新完成。`);
    return this.projectProgress.getGlobalCharacters();
  }

  /**
   * 自动在描述和文本中用正则匹配人物姓名，联动返回其 DNA 标签
   */
  autoMatchCharacterDNA(sceneInput, chapContent, chapterIndex = 0) {
    const globalChars = this.projectProgress.getGlobalCharacters();
    const sceneText = typeof sceneInput === 'string' ? sceneInput : serializeSceneForMatching(sceneInput);
    const combinedText = sceneText.toLowerCase();
    const sceneCharacterNames = Array.isArray(sceneInput?.character_names) ? sceneInput.character_names : [];
    const structuredCharacterNames = Array.isArray(sceneInput?.characters)
      ? sceneInput.characters.map(char => char?.name || '')
      : [];
    const explicitNames = new Set([...sceneCharacterNames, ...structuredCharacterNames]
      .map(name => String(name || '').split('(')[0].trim().toLowerCase())
      .filter(Boolean));

    const matchedAnchors = [];

    for (const [name, charData] of Object.entries(globalChars)) {
      // 剥离括号，获取纯姓名 (如 "夏洛特 (猫娘女仆)" -> "夏洛特")
      const aliases = Array.isArray(charData.aliases) ? charData.aliases : [];
      const namesToMatch = [name, ...aliases]
        .map(item => String(item || '').split("(")[0].trim().toLowerCase())
        .filter(Boolean);
      const cleanName = namesToMatch[0];
      if (!cleanName) continue;

      // 如果结构化角色名单、正文或描述命中了该角色
      if (namesToMatch.some(candidate => explicitNames.has(candidate) || combinedText.includes(candidate))) {
        const effectiveDna = typeof this.projectProgress.getCharacterDNAForChapter === 'function'
          ? (this.projectProgress.getCharacterDNAForChapter(name, chapterIndex) || charData)
          : charData;
        this.writeLog(`[Pipeline] 🎯 自动命中角色 DNA: ${name}`);
        matchedAnchors.push({
          name,
          aliases,
          正面提示词: effectiveDna.tags || "",
          负面提示词: effectiveDna.supersededNegative || "",
          结构化特征: effectiveDna.features,
          身高等级: effectiveDna.height_class || charData.height_class || "",
          身体比例: effectiveDna.body_proportion || charData.body_proportion || ""
        });
      }
    }

    return matchedAnchors;
  }

  async getVibeBundleForModel(model) {
    const useVibe = Boolean(this.config.useVibeTransfer || this.config.use_vibe);
    if (!useVibe) return null;

    const bundlePath = this.config.vibeBundlePath || this.config.vibe_bundle_path || "2026-06-04.naiv4vibebundle";
    const cacheKey = `${bundlePath}::${model}`;
    if (this.cachedVibeBundle && this.cachedVibeBundleKey === cacheKey) {
      return this.cachedVibeBundle;
    }

    const parsed = await loadVibeBundleForModel(bundlePath, model, this.baseDir);
    this.cachedVibeBundle = parsed;
    this.cachedVibeBundleKey = cacheKey;
    this.writeLog(`[Pipeline] ✨ 已加载 Vibe Transfer bundle: ${bundlePath}，提取 ${parsed.encodings.length} 个编码 (${parsed.names.join(", ")})`);
    return parsed;
  }

  /**
   * 批量流水线核心循环。
   * - 单章模式（targetChapterKey 非空）：LLM 生成 Prompt + NAI 线性生图，两条流水线解耦。
   * - 批量模式：LLM 2 并发生成 Prompt（完成即持久化）+ NAI 线性生图，两条流水线解耦。
   */
  async processPipeline(targetChapterKey = null, options = {}) {
    this.isRunning = true;
    await this.initialize();
    this.chapterIndexMap = new Map(this.chapters.map((c, index) => [
      this.projectProgress.getEffectiveChapKey(c.volume, c.chapter),
      index
    ]));
    const autoUpdateCharacterDna = Boolean(options.autoUpdateCharacterDna);

    this.writeLog(`[Pipeline] 启动配图流水线... 全书共解析到 ${this.chapters.length} 章节` + (targetChapterKey ? ` (目标单章: ${targetChapterKey})` : ""));

    const sceneModel = resolveTaskLlmConfig(this.config, 'scene').model;
    const naiTagsModel = resolveTaskLlmConfig(this.config, 'naiTags').model;
    const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";

    // ── 批量模式：LLM 双线 + NAI 线性并行 ──────────────────────────────────
    if (!targetChapterKey) {
      this.writeLog("[Pipeline] 启动双线并行模式：LLM 2 并发生成 Prompt + NAI 线性生图...");
      this._pendingDnaSlices = new Set();

      const naiQueue = []; // 共享 NAI 队列：{ chap, scene, scenes, chapKey }
      let llmDone = false;

      // 先启动 NAI 消费者（后台运行）
      const naiConsumerPromise = this._runNaiConsumerLinear(naiQueue, () => llmDone, naiModel);

      // 运行 LLM 生产者（2 并发）
      const llmResult = await this._runLlmProducerWithConcurrency(
        this.chapters, sceneModel, naiTagsModel, naiQueue, 2, autoUpdateCharacterDna
      );

      // LLM 全部完成，通知 NAI 消费者在队列耗尽后退出
      llmDone = true;

      // 等待 NAI 消费者处理完所有剩余任务
      await naiConsumerPromise;

      this.isRunning = false;
      await this.runPriorityJobs();
      console.log("[Pipeline] 批量流水线全部执行完毕！");
      return llmResult && llmResult.paused ? llmResult : { completed: true };
    }

    // ── 单章模式：同样使用 LLM → NAI 队列解耦 ───────────────────────────
    for (let idx = 0; idx < this.chapters.length; idx++) {
      if (!this.isRunning) {
        this.writeLog("[Pipeline] 流水线已被用户主动暂停。", "warning");
        break;
      }

      const chap = this.chapters[idx];
      const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);

      if (this.projectProgress.normalizeKey(chapKey) !== this.projectProgress.normalizeKey(targetChapterKey)) {
        continue;
      }

      const dnaSlice = this.getCharacterDnaSliceInfoByChapterIndex(idx);
      if (!this.projectProgress.isCharacterDnaSliceCompleted(dnaSlice.sliceKey)) {
        if (autoUpdateCharacterDna) {
          this.writeLog(`[Pipeline] ${dnaSlice.label} 尚未更新角色 DNA，自动更新后继续流水线...`, "warning");
          await this.extractCharacterDnaSlice(dnaSlice.sliceIndex, { force: true });
          this.projectProgress.setPipelinePause(null);
          await this.projectProgress.save();
        } else {
          this.isRunning = false;
          const pauseInfo = {
            reason: 'character_dna_required',
            projectName: this.projectName,
            targetChapterKey,
            chapterIndex: idx,
            chapterKey: chapKey,
            chapter: chap.chapter,
            sliceIndex: dnaSlice.sliceIndex,
            sliceKey: dnaSlice.sliceKey,
            sliceLabel: dnaSlice.label,
            chapters: dnaSlice.chapters.map(c => ({ volume: c.volume, chapter: c.chapter }))
          };
          this.projectProgress.setPipelinePause(pauseInfo);
          await this.projectProgress.save();
          this.writeLog(`[Pipeline] 进入 ${dnaSlice.label} 前需要先更新角色 DNA，流水线已暂停。`, "warning");
          if (this.uiProgressCallback) {
            this.uiProgressCallback({ type: 'character_dna_required', ...pauseInfo });
          }
          await this.runPriorityJobs();
          return { paused: true, pauseInfo };
        }
      }

      const completedChapters = this.projectProgress.getCompletedChapters();
      const currentProgress = completedChapters[chapKey];

      this.writeLog(`\n[Pipeline] ➔ 正在处理章节: ${chap.chapter}`);

      let scenes = [];
      try {
        if (Array.isArray(currentProgress?.scenes) && currentProgress.scenes.length > 0) {
          scenes = currentProgress.scenes.map(s => ({ ...s, ...normalizeSceneCard(s), status: s.status || 'PENDING' }));
          this.writeLog(`[Pipeline] 检测到该章节已有提炼好的 ${scenes.length} 个分镜场景，直接恢复断点场景...`);
        } else {
          const naiQueue = [];
          let llmDone = false;
          const preparePromises = [];
          const naiConsumerPromise = this._runNaiConsumerLinear(naiQueue, () => llmDone, naiModel);
          try {
            scenes = await this._extractChapterScenesIncrementally(chap, chapKey, sceneModel, '[Pipeline]', async (newScenes, allScenes) => {
              for (const scene of newScenes) {
                const preparePromise = (async () => {
                  await this.runPriorityJobs();
                  if (!this.isRunning) return;
                  await this._prepareSceneForNaiQueue(chap, scene, allScenes, chapKey, naiTagsModel, naiQueue);
                })();
                preparePromises.push(preparePromise);
              }
            });
            await Promise.all(preparePromises);
          } finally {
            llmDone = true;
            await naiConsumerPromise;
          }
          continue;
        }

        await this._prepareScenesAndRunNaiQueue(chap, scenes, scenes, chapKey, naiTagsModel, naiModel);

        if (this.isRunning) {
          const allDone = scenes.every(s => s.status === 'SUCCESS');
          if (allDone) {
            this.projectProgress.setChapterStatus(chapKey, 'completed', scenes);
            await this.projectProgress.save();
            this.writeLog(`[Pipeline] 章节「${chap.chapter}」所有多图配图已锁定。`);
          }
        }
      } catch (error) {
        this.writeLog(`[Pipeline] 章节「${chap.chapter}」发生异常中断: ${error.message}`, "error");
        this.projectProgress.setChapterFailed(chapKey, error.message, scenes);
        await this.projectProgress.save();
        await this.runPriorityJobs();
      }
      break; // 已找到并处理完目标章节
    }

    this.isRunning = false;
    await this.runPriorityJobs();
    console.log("[Pipeline] 批量流水线全部执行完毕！");
    return { completed: true };
  }

  /**
   * 生成单个分镜场景（生图核心步骤提取）
   */
  async generateSingleScene(chap, scene, scenes, chapKey, llmModel, naiModel) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.generateSingleSceneAttempt(
          chap,
          scene,
          scenes,
          chapKey,
          llmModel,
          naiModel,
          attempt
        );
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          this.writeLog(
            `  [场景 ${scene.scene_idx}] 第 ${attempt}/3 次执行失败，将完整重试场景流程: ${error.message}`,
            "warning"
          );
        }
      }
    }

    const finalErrorMessage = `场景 ${scene.scene_idx} 连续 3 次执行失败: ${lastError?.message || "未知错误"}`;
    this.writeLog(`  [场景 ${scene.scene_idx}] ${finalErrorMessage}，已跳过当前场景继续流水线。`, "warning");
    scene.status = 'FAILED';
    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();
    this.uiProgressCallback?.({
      chapter: chap.chapter,
      chapterKey: chapKey,
      sceneIdx: scene.scene_idx,
      totalScenes: scenes.length,
      imagePath: 'failed',
      phase: 'scene'
    });
    return false;
  }

  /**
   * 单场景完整生成尝试（供 generateSingleScene 重试包装器调用）。
   * 每次 attempt 均重新执行 LLM + NAI 两个阶段，确保 retry 时使用最新数据。
   */
  async generateSingleSceneAttempt(chap, scene, scenes, chapKey, llmModel, naiModel, attempt) {
    this.writeLog(`  [场景 ${scene.scene_idx}] 正在生图 -> 描述: ${scene.scene_desc || scene.visual_description}`);
    this.writeLog(`  [场景 ${scene.scene_idx}] 正在调用大模型生成高级生图参数（场景尝试 ${attempt}/3，含角色DNA与互动供体/受体）...`);

    // LLM 阶段：每次 attempt 均重新执行，覆盖旧的 prepared_prompt
    await this.prepareSingleScenePrompt(chap, scene, scenes, chapKey, llmModel);

    // NAI 生图阶段
    await this.generateSingleSceneFromPrompt(chap, scene, scenes, chapKey, naiModel);
  }

  _emitChapterScenesExtracted(chap, chapKey, scenes) {
    this.uiProgressCallback?.({
      type: 'chapter_scenes_extracted',
      chapter: chap.chapter,
      chapterKey: chapKey,
      totalScenes: scenes.length,
      scenes,
      fullProgress: this.projectProgress.data
    });
  }

  _normalizeExtractedSceneBatch(chap, rawScenes = [], existingScenes = []) {
    const baseIndex = existingScenes.length;
    return (Array.isArray(rawScenes) ? rawScenes : []).map((scene, index) => {
      const normalizedScene = normalizeSceneCard(scene);
      const originalTrigger = findOriginalTriggerSentence(chap.content, normalizedScene.trigger_sentence);
      return {
        ...normalizedScene,
        scene_idx: baseIndex + index + 1,
        trigger_sentence: originalTrigger,
        status: normalizedScene.status || 'PENDING'
      };
    });
  }

  async _persistChapterScenes(chap, chapKey, scenes) {
    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();
    this._emitChapterScenesExtracted(chap, chapKey, scenes);
  }

  async _recordSceneExtractionBatchFailure(chap, chapKey, scenes, error, batchInfo = {}) {
    const chapterProgress = this.projectProgress.getCompletedChapters?.()?.[chapKey] || {};
    const existingFailures = Array.isArray(chapterProgress.scene_extraction_failures)
      ? chapterProgress.scene_extraction_failures
      : [];
    const failure = {
      batch_index: Number(batchInfo.batchIndex) + 1,
      total_batches: Number(batchInfo.totalBatches) || 1,
      requested_scene_count: Number(batchInfo.requestedSceneCount) || 0,
      chapter_title: batchInfo.chapterTitle || chap.chapter,
      source_char_count: String(batchInfo.sourceText || '').length,
      source_preview: String(batchInfo.sourceText || '').slice(0, 300),
      error: String(error?.message || error || '未知错误'),
      failed_at: Date.now()
    };
    const failures = [
      ...existingFailures.filter(item => Number(item?.batch_index) !== failure.batch_index),
      failure
    ].sort((a, b) => Number(a.batch_index) - Number(b.batch_index));

    this.projectProgress.setChapterSceneExtractionFailures(chapKey, failures);
    await this.projectProgress.save();
    this._emitChapterScenesExtracted(chap, chapKey, scenes);
    this.writeLog(
      `[Pipeline] 章节「${chap.chapter}」第 ${failure.batch_index}/${failure.total_batches} 段提炼失败已记录；其余分段继续处理。`,
      'error'
    );
  }

  async _extractChapterScenesIncrementally(chap, chapKey, sceneModel, logPrefix, onBatchReady = null) {
    const countMetrics = getSceneCountMetrics(
      chap.content,
      this.config.cjk_scene_divisor || 600,
      this.config.english_scene_divisor || 350
    );
    const requestedSceneCount = countMetrics.sceneCount;
    const countDescription = countMetrics.language === 'english'
      ? `英文总词数 ${countMetrics.count}，按 ceil(词数 / ${countMetrics.divisor})`
      : `有效字符数 ${countMetrics.count}，按 ceil(字数 / ${countMetrics.divisor})`;
    this.writeLog(`${logPrefix} 章节「${chap.chapter}」${countDescription} 计算为 ${requestedSceneCount} 个分镜场景。`);

    const scenes = [];
    await extractChapterScenesInBatches({
      chapterTitle: chap.chapter,
      text: chap.content,
      model: sceneModel,
      sceneExtractor: this.sceneExtractor,
      onProgressLog: (logMsg, type, options) => this.writeLog(logMsg, type, options),
      onBatchExtracted: async (batchScenes, batchInfo) => {
        const normalizedBatch = this._normalizeExtractedSceneBatch(chap, batchScenes, scenes);
        if (normalizedBatch.length === 0) return;
        scenes.push(...normalizedBatch);
        await this._persistChapterScenes(chap, chapKey, scenes);
        await onBatchReady?.(normalizedBatch, scenes);
      },
      onBatchFailed: async (error, batchInfo) => {
        await this._recordSceneExtractionBatchFailure(chap, chapKey, scenes, error, batchInfo);
      },
      requestedSceneCount,
      sceneCountOptions: {
        cjkDivisor: this.config.cjk_scene_divisor,
        englishDivisor: this.config.english_scene_divisor
      }
    });

    this.writeLog(`${logPrefix} 章节「${chap.chapter}」成功提炼 ${scenes.length} 幅插画场景。`);
    return scenes;
  }

  // ====== 双线并行流水线 — 新增方法 ======

  /**
   * LLM 阶段（步骤 A-D）：
   * 匹配角色 DNA → 生成 advancedParams → 构图裁决 → buildFinalImagePrompt。
   * 结果持久化到 scene.prepared_prompt，状态更新为 PROMPT_READY。
   */
  async prepareSingleScenePrompt(chap, scene, scenes, chapKey, llmModel) {
    // A. 智能命中角色 DNA 标签组
    const chapterIndex = this.chapterIndexMap?.get(chapKey)
      ?? this.chapters.findIndex(item => item.volume === chap.volume && item.chapter === chap.chapter);
    const matchedAnchors = this.autoMatchCharacterDNA(scene, chap.content, Math.max(0, chapterIndex));

    // B. 高级参数生成
    const advancedParams = await this.naiTagsExtractor.generateScenePromptAdvanced(
      scene,
      matchedAnchors,
      llmModel,
      (logMsg, type, options = {}) => this.writeLog(
        options.appendToPrevious ? logMsg : `  [场景 ${scene.scene_idx}] ${logMsg}`,
        type,
        options
      )
    );
    this.writeLog(`  [场景 ${scene.scene_idx}] 高级参数生成完成 → orientation=${advancedParams.orientation}`);

    // C. 根据结构化场景二次裁决构图，避免 LLM 把多人/大全景误判成单人竖图
    const sceneCharacters = Array.isArray(scene.characters) ? scene.characters : [];
    const sceneText = [
      scene.visual_description,
      scene.environment,
      scene.cinematography,
      scene.interactions
    ].filter(Boolean).join(' ');
    const wantsWideScene = /远景|大全景|广角|全景|宏大|山水|战斗|对峙|舞剑|雪夜|环境|wide|landscape|panorama|establishing/i.test(sceneText);
    const wantsCloseup = /特写|近景|半身|局部|close-up|closeup|macro|upper body/i.test(sceneText);
    const hasDirectInteraction = /牵|抱|拥|吻|压|抓|握|扶|搂|接触|交合|性交|手交|对视|贴近|touch|hold|hug|kiss|embrace|sex|penetration|handjob|contact|close distance/i.test(sceneText);
    let resolvedOrientation = advancedParams.orientation;
    if (sceneCharacters.length >= 2) {
      // Wide canvases plus separate character descriptions strongly encourage
      // side-by-side character cards. Interactive multi-person scenes use a
      // square canvas unless the source explicitly requires a wide vista.
      resolvedOrientation = wantsWideScene && !wantsCloseup && !hasDirectInteraction
        ? 'landscape'
        : 'square';
    } else if (wantsWideScene) {
      resolvedOrientation = 'landscape';
    } else if (wantsCloseup) {
      resolvedOrientation = 'portrait';
    }

    const compositionMap = {
      portrait: "立绘",
      landscape: "场景",
      square: sceneCharacters.length >= 2 ? "场景" : "半身",
      default: matchedAnchors.length > 1 ? "场景" : (matchedAnchors.length === 1 ? "立绘" : "场景")
    };
    const composition = compositionMap[resolvedOrientation] || "场景";
    const requestedSize = resolvedOrientation === 'square' ? '1024x1024' : '';
    if (resolvedOrientation !== advancedParams.orientation) {
      this.writeLog(`  [场景 ${scene.scene_idx}] 构图纠正: ${advancedParams.orientation} → ${resolvedOrientation}`);
    }

    // D. 提示词装配与净化
    // 互动方向统一来自场景卡自身的 interaction_actions，若缺失则仅从场景文本做本地推断，
    // 不再依赖 LLM 返回的 per-character interaction 结构。
    const mergedInteractionActions = (scene.interaction_actions || []).length > 0
      ? scene.interaction_actions
      : inferSceneInteractionActions(scene);

    const promptResult = buildFinalImagePrompt(advancedParams.base_prompt || advancedParams.prompt, {
      composition,
      size: requestedSize,
      extraPositive: this.config.extra_prompt || "",
      extraNegative: [this.config.negative_prompt || "", advancedParams.negative_prompt || ""].filter(Boolean).join(", "),
      characterAnchors: matchedAnchors,
      sceneCharacters: scene.characters || [],
      sceneNsfwRating: scene.nsfw_rating || 'sfw',
      sceneEnvironment: scene.environment || '',
      sceneDescription: scene.visual_description || scene.scene_desc || '',
      sceneInteractions: scene.interactions || '',
      sceneInteractionActions: mergedInteractionActions,
      structuredCharacterPrompts: advancedParams.character_prompts || [],
      sceneMustShow: scene.must_show || [],
      sceneMustNotShow: scene.must_not_show || [],
      artistStylePrompt: this.config.artistStylePrompt || "",
      useCharacterSegments: true,
      useNaturalLanguage: false
    });

    // 将完整 Prompt 参数持久化到场景卡片
    scene.prepared_prompt = {
      finalPositive: promptResult.finalPositive,
      finalNegative: promptResult.finalNegative,
      basePrompt: promptResult.basePrompt,
      characterPrompts: promptResult.characterPrompts,
      negativeCharacterPrompts: promptResult.negativeCharacterPrompts,
      characterPromptInteractions: (advancedParams.character_prompts || []).map(item => ({
        name: String(item?.name || '').trim(),
        interactions: normalizeCharacterPromptInteractionList(item?.interaction)
      })),
      characterCenters: promptResult.characterCenters,
      width: promptResult.width,
      height: promptResult.height
    };
    scene.status = 'PROMPT_READY';
    scene.prepared_at = new Date().toISOString();

    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();
    this.writeLog(`  [场景 ${scene.scene_idx}] Prompt 已就绪并持久化，等待 NAI 生图队列。`);

    if (this.uiProgressCallback) {
      this.uiProgressCallback({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: 'prompt_ready',
        fullProgress: this.projectProgress.data
      });
    }
  }

  /**
   * NAI 阶段（步骤 E-H）：
   * 从 scene.prepared_prompt 读取完整参数，调用 NAI 生图并保存结果。
   * 可独立于 LLM 阶段调用，实现两条流水线解耦。
   */
  async generateSingleSceneFromPrompt(chap, scene, scenes, chapKey, naiModel) {
    const pp = scene.prepared_prompt;
    if (!pp || !pp.finalPositive) {
      throw new Error(`场景 ${scene.scene_idx} 缺少持久化的 Prompt 数据，请先执行 LLM 处理阶段`);
    }

    this.writeLog(`  [场景 ${scene.scene_idx}] [NAI] 开始生图 → ${String(pp.finalPositive).slice(0, 80)}...`);

    // E. 更新 UI 冷却通知回调
    if (this.uiCooldownCallback) {
      this.uiCooldownCallback();
    }

    // F. 调用 NAI 生图
    const vibeBundle = await this.getVibeBundleForModel(naiModel);
    const result = await this.naiClient.generateImage(pp.finalPositive, {
      model: naiModel,
      negativePrompt: pp.finalNegative,
      width: pp.width,
      height: pp.height,
      steps: Number(this.config.steps) || 28,
      scale: Number(this.config.scale) || 5.5,
      sampler: this.config.sampler || "k_euler_ancestral",
      noiseSchedule: this.config.noiseSchedule || "karras",
      basePrompt: pp.basePrompt,
      characterPrompts: pp.characterPrompts,
      negativeCharacterPrompts: pp.negativeCharacterPrompts,
      characterCenters: pp.characterCenters,
      useStructuredCharacterCaptions: (pp.characterPrompts || []).length > 0,
      vibeEncodings: vibeBundle?.encodings || null,
      vibeStrengths: vibeBundle ? vibeBundle.encodings.map(() => Number(this.config.vibeStrength) || 0.45) : null,
      vibeInfoExtracted: vibeBundle ? vibeBundle.informationExtracted.map(value => Number.isFinite(value) ? value : (Number(this.config.vibeInfoExtracted) || 1.0)) : null,
      vibeNormalizeStrengths: this.config.vibeNormalizeStrengths !== false,
      seed: null,
      signal: null,
      onRetry: (msg) => this.writeLog(`  [场景 ${scene.scene_idx}] ${msg}`, "warning")
    });

    // G. 保存插图至 illustrations
    const cleanTitle = chap.chapter.replace(/[\\/*?:"<>|]/g, "").trim();
    const timestamp = Date.now();
    const imgName = `${cleanTitle}_scene_${scene.scene_idx}_${timestamp}.png`;
    const savePath = path.join(this.illustrationsDir, imgName);
    await fs.writeFile(savePath, result.imageBytes);
    this.writeLog(`  [场景 ${scene.scene_idx}] 插图已存盘: ${imgName}`);

    // H. 实时更新该场景状态为 SUCCESS 并保存
    scene.status = 'SUCCESS';
    scene.image_path = `illustrations/${imgName}`;
    scene.final_prompt = pp.finalPositive;
    scene.final_negative = pp.finalNegative;
    scene.base_prompt = pp.basePrompt;
    scene.character_prompts = pp.characterPrompts;
    scene.negative_character_prompts = pp.negativeCharacterPrompts;
    scene.character_prompt_interactions = pp.characterPromptInteractions;
    scene.character_centers = pp.characterCenters;
    scene.width = pp.width;
    scene.height = pp.height;

    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();

    if (this.uiProgressCallback) {
      this.uiProgressCallback({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: `/projects/${this.projectName}/illustrations/${imgName}`
      });
    }
  }

  async _prepareSceneForNaiQueue(chap, scene, scenes, chapKey, naiTagsModel, naiQueue) {
    if (scene.status === 'SUCCESS' && scene.image_path && existsSync(path.join(this.projBase, scene.image_path))) {
      this.writeLog(`  [场景 ${scene.scene_idx}] 插画已存在，跳过 LLM 处理。`);
      return;
    }

    if (scene.status === 'PROMPT_READY' && scene.prepared_prompt?.finalPositive) {
      this.writeLog(`  [场景 ${scene.scene_idx}] Prompt 已就绪（断点续传），直接推入 NAI 队列。`);
      naiQueue.push({ chap, scene, scenes, chapKey });
      return;
    }

    let prepared = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!this.isRunning) break;
      try {
        await this.prepareSingleScenePrompt(chap, scene, scenes, chapKey, naiTagsModel);
        prepared = true;
        break;
      } catch (error) {
        if (attempt < 3) {
          this.writeLog(`  [场景 ${scene.scene_idx}] LLM 处理第 ${attempt}/3 次失败，将重试: ${error.message}`, "warning");
        } else {
          this.writeLog(`  [场景 ${scene.scene_idx}] LLM 处理连续 3 次失败，跳过该场景: ${error.message}`, "warning");
          scene.status = 'FAILED';
          this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
          await this.projectProgress.save();
          this.uiProgressCallback?.({
            chapter: chap.chapter,
            chapterKey: chapKey,
            sceneIdx: scene.scene_idx,
            totalScenes: scenes.length,
            imagePath: 'failed',
            phase: 'llm'
          });
        }
      }
    }

    if (prepared) {
      naiQueue.push({ chap, scene, scenes, chapKey });
    }
  }

  async _prepareScenesAndRunNaiQueue(chap, targetScenes, scenes, chapKey, naiTagsModel, naiModel) {
    const naiQueue = [];
    let llmDone = false;
    const naiConsumerPromise = this._runNaiConsumerLinear(naiQueue, () => llmDone, naiModel);

    try {
      // 并行启动所有目标场景的 LLM 提示词翻译，并推入生图队列
      const preparePromises = targetScenes.map(async (scene) => {
        if (!this.isRunning) return;
        await this.runPriorityJobs();
        if (!this.isRunning) return;
        await this._prepareSceneForNaiQueue(chap, scene, scenes, chapKey, naiTagsModel, naiQueue);
      });
      await Promise.all(preparePromises);
    } finally {
      llmDone = true;
      await naiConsumerPromise;
    }
  }

  /**
   * LLM 生产者：以指定并发数并行处理各章节的场景提取 + Prompt 生成。
   * JS 单线程保证 idx++ 的原子性，多个 worker 可安全共享同一计数器。
   */
  async _runLlmProducerWithConcurrency(chapters, sceneModel, naiTagsModel, naiQueue, concurrency, autoUpdateCharacterDna) {
    let idx = 0;
    let pauseResult = null;

    const worker = async () => {
      while (this.isRunning) {
        const currentIdx = idx++; // JS 单线程，++ 是原子操作，无竞态
        if (currentIdx >= chapters.length) break;

        const chap = chapters[currentIdx];
        const result = await this._processChapterLlmPhase(
          chap, currentIdx, chapters.length, sceneModel, naiTagsModel, naiQueue, autoUpdateCharacterDna
        );
        if (result && result.paused) {
          pauseResult = result;
          break;
        }
      }
    };

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return pauseResult;
  }

  /**
   * 处理单个章节的 LLM 阶段：
   * 1. DNA 切片检查（带并发锁，防止同一切片被多个 worker 重复提取）
   * 2. 提取或恢复场景卡片
   * 3. 逐场景调用 prepareSingleScenePrompt，完成后推入 naiQueue
   */
  async _processChapterLlmPhase(chap, idx, totalChapters, sceneModel, naiTagsModel, naiQueue, autoUpdateCharacterDna) {
    if (!this.isRunning) return null;

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);

    // ── DNA 切片检查（带并发锁）────────────────────────────────────────────
    const dnaSlice = this.getCharacterDnaSliceInfoByChapterIndex(idx);
    if (!this.projectProgress.isCharacterDnaSliceCompleted(dnaSlice.sliceKey)) {
      if (autoUpdateCharacterDna) {
        // 等待同一切片的其他 worker 完成提取，避免重复调用
        while (this._pendingDnaSlices.has(dnaSlice.sliceKey)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        // 再次确认（可能另一个 worker 已完成）
        if (!this.projectProgress.isCharacterDnaSliceCompleted(dnaSlice.sliceKey)) {
          this._pendingDnaSlices.add(dnaSlice.sliceKey);
          try {
            this.writeLog(`[Pipeline LLM] ${dnaSlice.label} 尚未更新角色 DNA，自动更新后继续流水线...`, "warning");
            await this.extractCharacterDnaSlice(dnaSlice.sliceIndex, { force: true });
            this.projectProgress.setPipelinePause(null);
            await this.projectProgress.save();
          } finally {
            this._pendingDnaSlices.delete(dnaSlice.sliceKey);
          }
        }
      } else {
        this.isRunning = false;
        const pauseInfo = {
          reason: 'character_dna_required',
          projectName: this.projectName,
          targetChapterKey: null,
          chapterIndex: idx,
          chapterKey: chapKey,
          chapter: chap.chapter,
          sliceIndex: dnaSlice.sliceIndex,
          sliceKey: dnaSlice.sliceKey,
          sliceLabel: dnaSlice.label,
          chapters: dnaSlice.chapters.map(c => ({ volume: c.volume, chapter: c.chapter }))
        };
        this.projectProgress.setPipelinePause(pauseInfo);
        await this.projectProgress.save();
        this.writeLog(`[Pipeline LLM] 进入 ${dnaSlice.label} 前需要先更新角色 DNA，流水线已暂停。`, "warning");
        if (this.uiProgressCallback) this.uiProgressCallback({ type: 'character_dna_required', ...pauseInfo });
        await this.runPriorityJobs();
        return { paused: true, pauseInfo };
      }
    }

    if (!this.isRunning) return null;

    const completedChapters = this.projectProgress.getCompletedChapters();
    const currentProgress = completedChapters[chapKey];

    // 跳过已全部完成的章节
    if (currentProgress && currentProgress.status === 'completed') {
      this.writeLog(`[Pipeline LLM] 章节「${chap.chapter}」插画配图已全部完成，跳过。`);
      return null;
    }

    this.writeLog(`\n[Pipeline LLM] ➔ 正在处理第 ${idx + 1}/${totalChapters} 章节: ${chap.chapter}`);

    let scenes = [];
    try {
      // ── 恢复已有场景或重新提取 ────────────────────────────────────────────
      if (Array.isArray(currentProgress?.scenes) && currentProgress.scenes.length > 0) {
        scenes = currentProgress.scenes.map(s => ({ ...s, ...normalizeSceneCard(s), status: s.status || 'PENDING' }));
        this.writeLog(`[Pipeline LLM] 章节「${chap.chapter}」恢复已有 ${scenes.length} 个分镜场景...`);
      } else {
        const preparePromises = [];
        scenes = await this._extractChapterScenesIncrementally(chap, chapKey, sceneModel, '[Pipeline LLM]', async (newScenes, allScenes) => {
          for (const scene of newScenes) {
            const preparePromise = (async () => {
              if (!this.isRunning) return;
              await this.runPriorityJobs();
              if (!this.isRunning) return;
              await this._prepareSceneForNaiQueue(chap, scene, allScenes, chapKey, naiTagsModel, naiQueue);
            })();
            preparePromises.push(preparePromise);
          }
        });
        await Promise.all(preparePromises);
        return null;
      }

      // ── 逐场景 LLM 处理，完成后推入 NAI 队列 ─────────────────────────────
      for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
        if (!this.isRunning) break;
        const scene = scenes[sIdx];

        await this._prepareSceneForNaiQueue(chap, scene, scenes, chapKey, naiTagsModel, naiQueue);
      }
    } catch (error) {
      this.writeLog(`[Pipeline LLM] 章节「${chap.chapter}」LLM 阶段异常: ${error.message}`, "error");
      this.projectProgress.setChapterFailed(chapKey, error.message, scenes);
      await this.projectProgress.save();
    }

    return null;
  }

  /**
   * NAI 消费者：线性处理 naiQueue 中的场景，保持原有冷却节奏。
   * 轮询间隔 500ms，LLM 生产者完成且队列耗尽后退出。
   */
  async _runNaiConsumerLinear(naiQueue, isLlmDone, naiModel) {
    while (true) {
      if (!this.isRunning) break;

      if (naiQueue.length === 0) {
        if (isLlmDone()) break; // LLM 已完成且队列为空，退出
        await new Promise(resolve => setTimeout(resolve, 500)); // 等待 LLM 生产更多场景
        continue;
      }

      // 稳定排序：优先按章节顺序（通过 chapterIndexMap 映射为数组索引），其次按场景索引（scene_idx）
      if (this.chapterIndexMap) {
        naiQueue.sort((a, b) => {
          const idxA = this.chapterIndexMap.get(a.chapKey) ?? 99999;
          const idxB = this.chapterIndexMap.get(b.chapKey) ?? 99999;
          if (idxA !== idxB) return idxA - idxB;
          return a.scene.scene_idx - b.scene.scene_idx;
        });
      }

      const item = naiQueue.shift();
      const { chap, scene, scenes, chapKey } = item;

      await this.runPriorityJobs();
      if (!this.isRunning) break;

      // NAI 消费开始前，通知前端进入加载中状态
      this.uiProgressCallback?.({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: null
      });

      // NAI 生图阶段（带重试）
      let success = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!this.isRunning) break;
        try {
          await this.generateSingleSceneFromPrompt(chap, scene, scenes, chapKey, naiModel);
          success = true;
          break;
        } catch (error) {
          if (attempt < 3) {
            this.writeLog(`  [场景 ${scene.scene_idx}] NAI 生图第 ${attempt}/3 次失败，将重试: ${error.message}`, "warning");
          } else {
            this.writeLog(`  [场景 ${scene.scene_idx}] NAI 生图连续 3 次失败，跳过该场景: ${error.message}`, "warning");
          }
        }
      }

      if (!success) {
        scene.status = 'FAILED';
        this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
        await this.projectProgress.save();
        this.uiProgressCallback?.({
          chapter: chap.chapter, chapterKey: chapKey,
          sceneIdx: scene.scene_idx, totalScenes: scenes.length, imagePath: 'failed', phase: 'nai'
        });
      }

      await this.runPriorityJobs();

      // 若该章节所有场景均已完成，锁定章节状态为 completed
      const allDone = scenes.every(s => s.status === 'SUCCESS');
      if (allDone) {
        this.projectProgress.setChapterStatus(chapKey, 'completed', scenes);
        await this.projectProgress.save();
        this.writeLog(`[Pipeline NAI] 章节「${chap.chapter}」所有多图配图已锁定。`);
      }
    }
  }

  /**
   * 单场景重绘（保留现有分镜描述，仅重新生图）
   */
  async redrawScene(chapterKey, sceneIdx, { interleaved = false } = {}) {
    if (!interleaved) {
      await this.initialize();
    }
    if (this.isRunning && !interleaved) {
      throw new Error("流水线正在运行中，请先暂停流水线再进行操作。");
    }

    const chap = this.chapters.find(c => {
      const ck = this.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
      return this.projectProgress.normalizeKey(ck) === this.projectProgress.normalizeKey(chapterKey);
    });
    if (!chap) throw new Error(`找不到章节: ${chapterKey}`);

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const currentProgress = this.projectProgress.getCompletedChapters()[chapKey];
    if (!currentProgress || !Array.isArray(currentProgress.scenes)) {
      throw new Error(`该章节尚未生成过场景卡片，请先整体生成。`);
    }

    const scenes = currentProgress.scenes;
    const scene = scenes.find(s => s.scene_idx === parseInt(sceneIdx));
    if (!scene) throw new Error(`找不到场景索引: ${sceneIdx}`);

    scene.status = 'PENDING';
    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();

    if (this.uiProgressCallback) {
      this.uiProgressCallback({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: null // null 表示开始重画中
      });
    }

    const previousRunningState = this.isRunning;
    this.isRunning = true;
    try {
      const llmModel = resolveTaskLlmConfig(this.config, 'naiTags').model;
      const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";
      this.writeLog(`[Pipeline] 开始单场景重绘: 章节「${chap.chapter}」场景 #${sceneIdx}`);
      await this._prepareScenesAndRunNaiQueue(chap, [scene], scenes, chapKey, llmModel, naiModel);
      this.writeLog(`[Pipeline] 单场景重绘成功: 章节「${chap.chapter}」场景 #${sceneIdx}`);
      return { chapter: chap.chapter, chapterKey: chapKey, sceneIdx: scene.scene_idx };
    } catch (err) {
      this.writeLog(`[Pipeline] 单场景重绘失败: ${err.message}`, "error");
      scene.status = 'FAILED';
      this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
      await this.projectProgress.save();
      if (this.uiProgressCallback) {
        this.uiProgressCallback({
          chapter: chap.chapter,
          chapterKey: chapKey,
          sceneIdx: scene.scene_idx,
          totalScenes: scenes.length,
          imagePath: 'failed',
          phase: 'scene'
        });
      }
      throw err;
    } finally {
      this.isRunning = previousRunningState;
    }
  }

  /**
   * 仅使用场景已保存的最终 Prompt 重绘，不调用 LLM。
   */
  async redrawSceneWithSavedPrompt(chapterKey, sceneIdx, { interleaved = false } = {}) {
    if (!interleaved) {
      await this.initialize();
    }
    if (this.isRunning && !interleaved) {
      throw new Error("流水线正在运行中，请先暂停流水线再进行操作。");
    }

    const chap = this.chapters.find(c => {
      const ck = this.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
      return this.projectProgress.normalizeKey(ck) === this.projectProgress.normalizeKey(chapterKey);
    });
    if (!chap) throw new Error(`找不到章节: ${chapterKey}`);

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const currentProgress = this.projectProgress.getCompletedChapters()[chapKey];
    if (!currentProgress || !Array.isArray(currentProgress.scenes)) {
      throw new Error("该章节尚未生成过场景卡片，请先整体生成。");
    }

    const scenes = currentProgress.scenes;
    const scene = scenes.find(s => s.scene_idx === parseInt(sceneIdx));
    if (!scene) throw new Error(`找不到场景索引: ${sceneIdx}`);
    if (!String(scene.final_prompt || '').trim()) {
      throw new Error("该场景没有已保存的最终 Prompt，请先执行一次普通重绘");
    }

    scene.status = 'PENDING';
    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();
    this.uiProgressCallback?.({
      chapter: chap.chapter,
      chapterKey: chapKey,
      sceneIdx: scene.scene_idx,
      totalScenes: scenes.length,
      imagePath: null
    });

    const previousRunningState = this.isRunning;
    this.isRunning = true;
    try {
      const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";
      const characterPrompts = Array.isArray(scene.character_prompts) ? scene.character_prompts : [];
      const negativeCharacterPrompts = Array.isArray(scene.negative_character_prompts)
        ? scene.negative_character_prompts
        : [];
      const characterCenters = Array.isArray(scene.character_centers) ? scene.character_centers : [];
      const basePrompt = String(scene.base_prompt || scene.final_prompt).trim();
      const finalPrompt = String(scene.final_prompt).trim();
      const finalNegative = String(scene.final_negative || '').trim();
      const width = Number(scene.width) || 1024;
      const height = Number(scene.height) || 1024;

      this.writeLog(`[Pipeline] 开始仅 NAI 重绘: 章节「${chap.chapter}」场景 #${sceneIdx}`);
      this.uiCooldownCallback?.();
      const vibeBundle = await this.getVibeBundleForModel(naiModel);
      const result = await this.naiClient.generateImage(finalPrompt, {
        model: naiModel,
        negativePrompt: finalNegative,
        width,
        height,
        steps: Number(this.config.steps) || 28,
        scale: Number(this.config.scale) || 5.5,
        sampler: this.config.sampler || "k_euler_ancestral",
        noiseSchedule: this.config.noiseSchedule || "karras",
        basePrompt,
        characterPrompts,
        negativeCharacterPrompts,
        characterCenters,
        useStructuredCharacterCaptions: characterPrompts.length > 0,
        vibeEncodings: vibeBundle?.encodings || null,
        vibeStrengths: vibeBundle ? vibeBundle.encodings.map(() => Number(this.config.vibeStrength) || 0.45) : null,
        vibeInfoExtracted: vibeBundle
          ? vibeBundle.informationExtracted.map(value => Number.isFinite(value) ? value : (Number(this.config.vibeInfoExtracted) || 1.0))
          : null,
        vibeNormalizeStrengths: this.config.vibeNormalizeStrengths !== false,
        seed: null,
        signal: null,
        onRetry: (msg) => this.writeLog(`  [场景 ${scene.scene_idx}] ${msg}`, "warning")
      });

      const cleanTitle = chap.chapter.replace(/[\\/*?:"<>|]/g, "").trim();
      const imgName = `${cleanTitle}_scene_${scene.scene_idx}_${Date.now()}.png`;
      await fs.writeFile(path.join(this.illustrationsDir, imgName), result.imageBytes);

      scene.status = 'SUCCESS';
      scene.image_path = `illustrations/${imgName}`;
      this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
      await this.projectProgress.save();
      this.uiProgressCallback?.({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: `/projects/${this.projectName}/illustrations/${imgName}`
      });
      this.writeLog(`[Pipeline] 仅 NAI 重绘成功: 章节「${chap.chapter}」场景 #${sceneIdx}`);
      return { chapter: chap.chapter, chapterKey: chapKey, sceneIdx: scene.scene_idx };
    } catch (err) {
      scene.status = 'FAILED';
      this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
      await this.projectProgress.save();
      this.uiProgressCallback?.({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: 'failed',
        phase: 'nai'
      });
      this.writeLog(`[Pipeline] 仅 NAI 重绘失败: ${err.message}`, "error");
      throw err;
    } finally {
      this.isRunning = previousRunningState;
    }
  }

  /**
   * 单场景描述重构并重绘（LLM重写描述，然后再重绘）
   */
  async regenerateAndRedrawScene(chapterKey, sceneIdx) {
    await this.initialize();
    if (this.isRunning) {
      throw new Error("流水线正在运行中，请先暂停流水线再进行操作。");
    }

    const chap = this.chapters.find(c => {
      const ck = this.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
      return this.projectProgress.normalizeKey(ck) === this.projectProgress.normalizeKey(chapterKey);
    });
    if (!chap) throw new Error(`找不到章节: ${chapterKey}`);

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const currentProgress = this.projectProgress.getCompletedChapters()[chapKey];
    if (!currentProgress || !Array.isArray(currentProgress.scenes)) {
      throw new Error(`该章节尚未生成过场景卡片，请先整体生成。`);
    }

    const scenes = currentProgress.scenes;
    const scene = scenes.find(s => s.scene_idx === parseInt(sceneIdx));
    if (!scene) throw new Error(`找不到场景索引: ${sceneIdx}`);

    scene.status = 'PENDING';
    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();

    if (this.uiProgressCallback) {
      this.uiProgressCallback({
        chapter: chap.chapter,
        chapterKey: chapKey,
        sceneIdx: scene.scene_idx,
        totalScenes: scenes.length,
        imagePath: null // null 表示重构并绘制中
      });
    }

    // 后台异步执行并广播
    this.isRunning = true;
    (async () => {
      try {
        const sceneModel = resolveTaskLlmConfig(this.config, 'scene').model;
        const naiTagsModel = resolveTaskLlmConfig(this.config, 'naiTags').model;
        const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";
        this.writeLog(`[Pipeline] 开始重构分镜画面描述: 章节「${chap.chapter}」场景 #${sceneIdx}`);

        // 调用大模型重新提炼描述卡片
        const newSceneCard = await this.sceneExtractor.regenerateSingleSceneCard(
          chap.chapter,
          chap.content,
          scene.scene_idx,
          scene.trigger_sentence,
          sceneModel,
          '',
          (logMsg, type, options = {}) => this.writeLog(
            options.appendToPrevious ? logMsg : `  [场景 ${scene.scene_idx}] ${logMsg}`,
            type,
            options
          )
        );

        // 把新卡片属性融合到原有 scene 中，重设 status 和清除老图
        Object.assign(scene, newSceneCard, { status: 'PENDING', image_path: null });
        this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
        await this.projectProgress.save();

        this.writeLog(`[Pipeline] 描述重构完成，开始重绘场景 #${sceneIdx}...`);
        await this._prepareScenesAndRunNaiQueue(chap, [scene], scenes, chapKey, naiTagsModel, naiModel);
        if (scene.status === 'SUCCESS') {
          this.writeLog(`[Pipeline] 单场景重构并重绘成功: 章节「${chap.chapter}」场景 #${sceneIdx}`);
        } else {
          this.writeLog(`[Pipeline] 单场景重构并重绘失败后已跳过: 章节「${chap.chapter}」场景 #${sceneIdx}`, "warning");
        }
      } catch (err) {
        this.writeLog(`[Pipeline] 单场景重构并重绘失败: ${err.message}`, "error");
        scene.status = 'FAILED';
        this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
        await this.projectProgress.save();
        if (this.uiProgressCallback) {
          this.uiProgressCallback({
            chapter: chap.chapter,
            sceneIdx: scene.scene_idx,
            totalScenes: scenes.length,
            imagePath: 'failed',
            phase: 'scene'
          });
        }
      } finally {
        this.isRunning = false;
      }
    })();
  }

  /**
   * 删除单个场景，并清理对应图片与后续编号
   */
  async deleteScene(chapterKey, sceneIdx) {
    await this.initialize();
    if (this.isRunning) {
      throw new Error("流水线正在运行中，请先暂停后再删除场景。");
    }

    const chap = this.chapters.find(c => {
      const ck = this.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
      return this.projectProgress.normalizeKey(ck) === this.projectProgress.normalizeKey(chapterKey);
    });
    if (!chap) throw new Error(`找不到章节: ${chapterKey}`);

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const currentProgress = this.projectProgress.getCompletedChapters()[chapKey];
    if (!currentProgress || !Array.isArray(currentProgress.scenes)) {
      throw new Error(`该章节尚未生成过场景卡片，无法删除场景。`);
    }

    const scenes = currentProgress.scenes;
    const targetIdx = scenes.findIndex(scene => scene.scene_idx === parseInt(sceneIdx));
    if (targetIdx === -1) {
      throw new Error(`找不到场景索引: ${sceneIdx}`);
    }

    const [removedScene] = scenes.splice(targetIdx, 1);
    if (removedScene?.image_path) {
      const projectRoot = path.resolve(this.projBase);
      const imagePath = path.resolve(projectRoot, removedScene.image_path);
      const relative = path.relative(projectRoot, imagePath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && existsSync(imagePath)) {
        await fs.unlink(imagePath);
      }
    }

    scenes.forEach((scene, index) => {
      scene.scene_idx = index + 1;
    });

    const nextStatus = scenes.length === 0
      ? 'pending'
      : (scenes.every(scene => scene.status === 'SUCCESS') ? 'completed' : 'generating');

    this.projectProgress.setChapterStatus(chapKey, nextStatus, scenes);
    await this.projectProgress.save();

    this.writeLog(`[Pipeline] 已删除场景: 章节「${chap.chapter}」场景 #${sceneIdx}`);
    return {
      chapter: chap.chapter,
      chapterKey: chapKey,
      deletedSceneIdx: parseInt(sceneIdx),
      remainingScenes: scenes.length
    };
  }

  async updateSceneCard(chapterKey, sceneIdx, updates = {}) {
    await this.initialize();
    if (this.isRunning) {
      throw new Error("流水线正在运行中，请先暂停后再编辑场景。");
    }

    const chap = this.chapters.find(c => {
      const ck = this.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
      return this.projectProgress.normalizeKey(ck) === this.projectProgress.normalizeKey(chapterKey);
    });
    if (!chap) throw new Error(`找不到章节: ${chapterKey}`);

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const currentProgress = this.projectProgress.getCompletedChapters()[chapKey];
    if (!currentProgress || !Array.isArray(currentProgress.scenes)) {
      throw new Error('该章节尚未生成过场景卡片，无法编辑。');
    }

    const scenes = currentProgress.scenes;
    const targetIdx = scenes.findIndex(scene => Number(scene.scene_idx) === Number(sceneIdx));
    if (targetIdx === -1) {
      throw new Error(`找不到场景索引: ${sceneIdx}`);
    }

    const currentScene = scenes[targetIdx];
    const stringifyComparable = (value) => JSON.stringify(value ?? null);
    const comparableText = (value) => String(value || '').trim();
    const comparableStringList = (value) => (
      Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean)
        : []
    );
    const comparableObjectList = (value) => (
      Array.isArray(value)
        ? value.map(item => stringifyComparable(item))
        : []
    );
    const lightweightFieldsChanged = (
      comparableText(updates.trigger_sentence) !== comparableText(currentScene.trigger_sentence) ||
      comparableText(updates.nsfw_rating) !== comparableText(currentScene.nsfw_rating) ||
      comparableText(updates.visual_description) !== comparableText(currentScene.visual_description || currentScene.scene_desc) ||
      comparableText(updates.core_action) !== comparableText(currentScene.core_action) ||
      stringifyComparable(comparableStringList(updates.character_names)) !== stringifyComparable(comparableStringList(currentScene.character_names))
    );
    const derivedFieldsUnchanged = (
      comparableText(updates.environment) === comparableText(currentScene.environment) &&
      comparableText(updates.cinematography) === comparableText(currentScene.cinematography) &&
      comparableText(updates.interactions) === comparableText(currentScene.interactions) &&
      comparableText(updates.plot_traces) === comparableText(currentScene.plot_traces) &&
      comparableText(updates.text_elements) === comparableText(currentScene.text_elements) &&
      stringifyComparable(comparableStringList(updates.must_show)) === stringifyComparable(comparableStringList(currentScene.must_show)) &&
      stringifyComparable(comparableStringList(updates.must_not_show)) === stringifyComparable(comparableStringList(currentScene.must_not_show)) &&
      stringifyComparable(comparableObjectList(updates.interaction_actions)) === stringifyComparable(comparableObjectList(currentScene.interaction_actions)) &&
      stringifyComparable(comparableObjectList(updates.visual_entities)) === stringifyComparable(comparableObjectList(currentScene.visual_entities)) &&
      stringifyComparable(comparableObjectList(updates.characters)) === stringifyComparable(comparableObjectList(currentScene.characters))
    );
    const normalized = normalizeSceneCard({
      ...currentScene,
      ...updates,
      scene_idx: currentScene.scene_idx
    });
    if (lightweightFieldsChanged && derivedFieldsUnchanged) {
      normalized.environment = '';
      normalized.cinematography = '';
      normalized.interactions = '';
      normalized.plot_traces = '';
      normalized.text_elements = '';
      normalized.must_show = [];
      normalized.must_not_show = [];
      normalized.interaction_actions = [];
      normalized.visual_entities = [];
      normalized.characters = [];
    }

    scenes[targetIdx] = {
      ...currentScene,
      ...normalized,
      scene_idx: currentScene.scene_idx,
      final_prompt: typeof updates.final_prompt === 'string' ? updates.final_prompt.trim() : currentScene.final_prompt,
      base_prompt: typeof updates.base_prompt === 'string' ? updates.base_prompt.trim() : currentScene.base_prompt,
      final_negative: typeof updates.final_negative === 'string' ? updates.final_negative.trim() : currentScene.final_negative,
      character_prompts: Array.isArray(updates.character_prompts)
        ? updates.character_prompts.map(item => String(item || '').trim()).filter(Boolean)
        : currentScene.character_prompts,
      character_prompt_interactions: Array.isArray(updates.character_prompt_interactions)
        ? updates.character_prompt_interactions.map((item, index) => {
            if (!item || typeof item !== 'object') return null;
            const interactions = normalizeCharacterPromptInteractionList(item);
            if (interactions.length === 0) return null;
            return {
              name: String(item?.name || currentScene.characters?.[index]?.name || '').trim(),
              interactions
            };
          })
        : currentScene.character_prompt_interactions,
      negative_character_prompts: Array.isArray(updates.negative_character_prompts)
        ? updates.negative_character_prompts.map(item => String(item || '').trim()).filter(Boolean)
        : currentScene.negative_character_prompts,
      source_context: '',
      width: Number.isFinite(Number(updates.width)) ? Number(updates.width) : currentScene.width,
      height: Number.isFinite(Number(updates.height)) ? Number(updates.height) : currentScene.height
    };

    const nextStatus = scenes.length === 0
      ? 'pending'
      : (scenes.every(scene => scene.status === 'SUCCESS') ? 'completed' : currentProgress.status || 'generating');

    this.projectProgress.setChapterStatus(chapKey, nextStatus, scenes);
    await this.projectProgress.save();
    this.writeLog(`[Pipeline] 已更新场景卡: 章节「${chap.chapter}」场景 #${sceneIdx}`);
    return {
      chapter: chap.chapter,
      chapterKey: chapKey,
      scene: scenes[targetIdx]
    };
  }

  async appendSelectedParagraphScenes(chapterKey, selections = []) {
    await this.initialize();
    if (this.isRunning) {
      throw new Error("流水线正在运行中，请先暂停后再提交正文选段。");
    }

    const chap = this.chapters.find(c => {
      const ck = this.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
      return this.projectProgress.normalizeKey(ck) === this.projectProgress.normalizeKey(chapterKey);
    });
    if (!chap) throw new Error(`找不到章节: ${chapterKey}`);

    const paragraphs = chap.content.split(/\r?\n/).map(text => text.trim()).filter(Boolean);
    const selectedParagraphs = selections
      .map(item => ({
        paragraphIndex: Number(item?.paragraphIndex),
        text: String(item?.text || '').trim(),
        paragraph: String(item?.paragraph || '').trim()
      }))
      .filter(item => {
        const paragraph = paragraphs[item.paragraphIndex];
        return item.text && paragraph && (item.paragraph === paragraph || paragraph.includes(item.text));
      })
      .map(item => ({ ...item, paragraph: paragraphs[item.paragraphIndex] }));
    if (selectedParagraphs.length === 0) {
      throw new Error("没有可用的正文选段，正文可能已变化，请刷新后重试。");
    }

    const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
    const currentProgress = this.projectProgress.getCompletedChapters()[chapKey] || {};
    const scenes = Array.isArray(currentProgress.scenes)
      ? currentProgress.scenes.map(scene => ({ ...scene }))
      : [];
    let nextSceneIdx = scenes.reduce((max, scene) => Math.max(max, Number(scene.scene_idx) || 0), 0) + 1;
    const sceneModel = resolveTaskLlmConfig(this.config, 'scene').model;
    const naiTagsModel = resolveTaskLlmConfig(this.config, 'naiTags').model;
    const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";

    this.isRunning = true;
    try {
      const generatedScenes = await this.sceneExtractor.regenerateSelectedParagraphScenes(
        chap.chapter,
        chap.content,
        selectedParagraphs,
        sceneModel,
        (logMsg, type, options = {}) => this.writeLog(
          options.appendToPrevious ? logMsg : `  [章节 ${chap.chapter}] ${logMsg}`,
          type,
          options
        ),
        {
          cjkDivisor: this.config.cjk_scene_divisor,
          englishDivisor: this.config.english_scene_divisor
        }
      );

      for (let index = 0; index < selectedParagraphs.length; index++) {
        const selection = selectedParagraphs[index];
        const generated = generatedScenes[index] || normalizeSceneCard({
          scene_idx: nextSceneIdx,
          trigger_sentence: selection.text,
          nsfw_rating: 'sfw',
          visual_description: selection.paragraph || selection.text || chap.chapter,
          environment: '',
          cinematography: '',
          characters: [],
          interactions: '',
          plot_traces: '',
          text_elements: ''
        });
        scenes.push({
          ...normalizeSceneCard(generated),
          scene_idx: nextSceneIdx,
          trigger_sentence: selection.text,
          source_paragraph: selection.paragraph,
          source_paragraph_index: selection.paragraphIndex,
          source_selection: selection.text,
          source: 'reader_selection',
          status: 'PENDING'
        });
        nextSceneIdx++;
      }

      this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
      await this.projectProgress.save();
      this._emitChapterScenesExtracted(chap, chapKey, scenes);

      const selectedScenes = scenes.filter(item => item.source === 'reader_selection' && item.status !== 'SUCCESS');
      await this._prepareScenesAndRunNaiQueue(chap, selectedScenes, scenes, chapKey, naiTagsModel, naiModel);

      const status = scenes.every(scene => scene.status === 'SUCCESS') ? 'completed' : 'generating';
      this.projectProgress.setChapterStatus(chapKey, status, scenes);
      await this.projectProgress.save();
      return { chapterKey: chapKey, added: selectedParagraphs.length };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 将生成的插图占位符注入小说文本中，生成插图版正文
   */
  async buildNovelWithIllustrations() {
    await this.initialize();
    const fullTextList = [];
    const completedChapters = this.projectProgress.getCompletedChapters();

    for (const chap of this.chapters) {
      const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);
      const progress = completedChapters[chapKey];
      let content = chap.content;

      if (progress && progress.status === 'completed' && Array.isArray(progress.scenes)) {
        for (const scene of progress.scenes) {
          if (scene.status === 'SUCCESS' && scene.image_path) {
            const imgName = path.basename(scene.image_path);
            const trigger = (scene.trigger_sentence || "").trim();

            if (trigger && content.includes(trigger)) {
              // 精确在触发高潮句下方插入占位符
              content = content.replace(trigger, `${trigger}\n\n[插图：${imgName}]\n`);
            } else {
              // 兜底插入在段落尾部
              content += `\n\n[插图：${imgName}]\n`;
            }
          }
        }
      }

      fullTextList.push(`${chap.volume}\n${chap.chapter}\n\n${content}\n\n`);
    }

    return fullTextList.join("\n");
  }
}
