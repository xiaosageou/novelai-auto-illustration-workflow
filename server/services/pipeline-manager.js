import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ProjectProgress } from '../utils/db.js';
import { LLMExtractor } from './llm-extractor.js';
import { NovelAIClient } from './nai-client.js';
import { buildFinalImagePrompt } from './prompt-builder.js';
import { loadVibeBundleForModel } from '../utils/vibe-bundle.js';
import { normalizeSceneCard, serializeSceneForMatching } from '../utils/scene-structure.js';
import { findOriginalTriggerSentence } from '../utils/prompt-cleaner.js';

const CHARACTER_DNA_LONG_CHAPTER_THRESHOLD = 5000;
const CHARACTER_DNA_LONG_CHAPTER_BATCH_SIZE = 5;

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
    this.llmExtractor = new LLMExtractor({
      baseUrl: this.config.llm_url || "",
      apiKey: this.config.llm_key || "",
      system_prompt_extract_scenes: this.config.system_prompt_extract_scenes || "",
      system_prompt_character_dna: this.config.system_prompt_character_dna || "",
      system_prompt_advanced_prompt: this.config.system_prompt_advanced_prompt || "",
      danbooru_mcp_url: this.config.danbooru_mcp_url || ""
    });

    this.isRunning = false;
    this.chapters = [];
    this.projectProgress = null;
    this.uiCooldownCallback = null;
    this.uiProgressCallback = null;
    this.uiLogCallback = null;
    this.cachedVibeBundle = null;
    this.cachedVibeBundleKey = "";
    this.dnaSliceSize = Number(config.characterDnaSliceSize) || 10;

    // 自适应切换到对应项目
    this.switchProject(this.projectName);
  }

  writeLog(text, type = 'info') {
    if (type === 'error') {
      console.error(text);
    } else if (type === 'warning') {
      console.warn(text);
    } else {
      console.log(text);
    }
    if (this.uiLogCallback) {
      try {
        this.uiLogCallback(text, type);
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
    this.llmExtractor.updateConfig(
      this.config.llm_url || "",
      this.config.llm_key || "",
      this.config.system_prompt_extract_scenes,
      this.config.system_prompt_character_dna,
      this.config.system_prompt_advanced_prompt,
      undefined,
      this.config.danbooru_mcp_url
    );
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

      const parseChapterHeading = (stripped) => {
        if (!stripped || stripped.length > 100) return null;
        const strict = stripped.match(strictChapPattern);
        if (strict) return stripped;

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

    const model = this.config.llm_model || "deepseek-chat";
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

      const list = await this.llmExtractor.extractCharacterDNA(batchText, model, {
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
  autoMatchCharacterDNA(sceneInput, chapContent) {
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
        this.writeLog(`[Pipeline] 🎯 自动命中角色 DNA: ${name}`);
        matchedAnchors.push({
          name,
          正面提示词: charData.tags || "",
          结构化特征: charData.features,
          身高等级: charData.height_class || "",
          身体比例: charData.body_proportion || ""
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
   * 批量流水线核心循环（带场景级细粒度断点续传）
   */
  async processPipeline(targetChapterKey = null, options = {}) {
    this.isRunning = true;
    await this.initialize();
    const autoUpdateCharacterDna = Boolean(options.autoUpdateCharacterDna);

    this.writeLog(`[Pipeline] 启动配图流水线... 全书共解析到 ${this.chapters.length} 章节` + (targetChapterKey ? ` (目标单章: ${targetChapterKey})` : ""));

    const llmModel = this.config.llm_model || "deepseek-chat";
    const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";

    for (let idx = 0; idx < this.chapters.length; idx++) {
      if (!this.isRunning) {
        this.writeLog("[Pipeline] 流水线已被用户主动暂停。", "warning");
        break;
      }

      const chap = this.chapters[idx];
      const chapKey = this.projectProgress.getEffectiveChapKey(chap.volume, chap.chapter);

      // 若指定了目标章节，跳过其他所有章节
      if (targetChapterKey && this.projectProgress.normalizeKey(chapKey) !== this.projectProgress.normalizeKey(targetChapterKey)) {
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
            this.uiProgressCallback({
              type: 'character_dna_required',
              ...pauseInfo
            });
          }
          return { paused: true, pauseInfo };
        }
      }
      
      // 获取该章节当前进度
      const completedChapters = this.projectProgress.getCompletedChapters();
      const currentProgress = completedChapters[chapKey];

      // 检查章节级是否已完全完成（若为单章强制重画，则不跳过）
      if (!targetChapterKey && currentProgress && currentProgress.status === 'completed') {
        this.writeLog(`[Pipeline] 章节「${chap.chapter}」插画配图已全部完成，跳过。`);
        continue;
      }

      this.writeLog(`\n[Pipeline] ➔ 正在处理第 ${idx + 1}/${this.chapters.length} 章节: ${chap.chapter}`);

      try {
        let scenes = [];
        
        // 1. 如果该章节已有提取记录，并且不是指定的单章强制生成，直接复用已提取的场景卡片（实现场景级恢复的第一步）
        if (!targetChapterKey && currentProgress && Array.isArray(currentProgress.scenes) && currentProgress.scenes.length > 0) {
          scenes = currentProgress.scenes.map(scene => ({ ...scene, ...normalizeSceneCard(scene), status: scene.status || 'PENDING' }));
          this.writeLog(`[Pipeline] 检测到该章节已有提炼好的 ${scenes.length} 个分镜场景，直接恢复断点场景...`);
        } else {
          // 否则，调用 LLM 重新提取 5-10 个场景
          this.writeLog(`[Pipeline] 正在调用大模型提炼章节「${chap.chapter}」的 5-10 个分镜场景，请稍候...`);
          scenes = await this.llmExtractor.extractChapterScenes(
            chap.chapter,
            chap.content,
            llmModel,
            (logMsg) => this.writeLog(logMsg)
          );
          this.writeLog(`[Pipeline] 成功提炼本章共 ${scenes.length} 幅插画场景。`);
          
          // 初始化场景状态为 PENDING，并先写盘落库
          const initialScenes = scenes.map(s => {
            const normalizedScene = normalizeSceneCard(s);
            const originalTrigger = findOriginalTriggerSentence(chap.content, normalizedScene.trigger_sentence);
            return {
              ...normalizedScene,
              trigger_sentence: originalTrigger,
              status: 'PENDING'
            };
          });
          
          this.projectProgress.setChapterStatus(chapKey, 'generating', initialScenes);
          await this.projectProgress.save();
          scenes = initialScenes;
        }

        // 2. 依次生成各个场景
        for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
          if (!this.isRunning) break;

          const scene = scenes[sIdx];
          
          // 如果该场景状态已为 SUCCESS，说明在之前的运行中已经生好图了，直接跳过 (场景级断点续传的关键！)
          if (scene.status === 'SUCCESS' && scene.image_path && existsSync(path.join(this.projBase, scene.image_path))) {
            this.writeLog(`  [场景 ${scene.scene_idx}] 插画已存在，跳过生成。`);
            continue;
          }

          await this.generateSingleScene(chap, scene, scenes, chapKey, llmModel, naiModel);
        }

        // 3. 所有场景生图完毕后，将该章节标记为 completed
        if (this.isRunning) {
          // 再次检查确认所有场景都为 SUCCESS
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
        this.isRunning = false;
        throw error;
      }
    }

    this.isRunning = false;
    console.log("[Pipeline] 批量流水线全部执行完毕！");
    return { completed: true };
  }

  /**
   * 生成单个分镜场景（生图核心步骤提取）
   */
  async generateSingleScene(chap, scene, scenes, chapKey, llmModel, naiModel) {
    this.writeLog(`  [场景 ${scene.scene_idx}] 正在生图 -> 描述: ${scene.scene_desc || scene.visual_description}`);

    // A. 智能命中角色 DNA 标签组（提前匹配，用于传入LLM参考）
    const matchedAnchors = this.autoMatchCharacterDNA(scene, chap.content);

    // B. 高级参数生成：LLM 感知角色DNA，输出结构化 { orientation, prompt, negative_prompt }
    let advancedParams = null;
    try {
      this.writeLog(`  [场景 ${scene.scene_idx}] 正在调用大模型生成高级生图参数（含角色DNA感知）...`);
      advancedParams = await this.llmExtractor.generateScenePromptAdvanced(
        scene,
        matchedAnchors,
        llmModel,
        (logMsg) => this.writeLog(`  [场景 ${scene.scene_idx}] ${logMsg}`)
      );
      this.writeLog(`  [场景 ${scene.scene_idx}] 高级参数生成完成 → orientation=${advancedParams.orientation}`);
    } catch (e) {
      this.writeLog(`  [场景 ${scene.scene_idx}] 高级参数生成异常，使用兜底: ${e.message}`, "warning");
      advancedParams = {
        orientation: matchedAnchors.length > 0 ? "portrait" : "landscape",
        prompt: matchedAnchors.length > 0 ? "1girl, anime style, detailed background" : "scenery, anime style, detailed background",
        negative_prompt: ""
      };
    }

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

    // D. 提示词装配与净化（融合角色 DNA Segments，LLM已感知但pipeline仍负责权重分段组装）
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
      structuredCharacterPrompts: advancedParams.character_prompts || [],
      sceneMustShow: scene.must_show || [],
      sceneMustNotShow: scene.must_not_show || [],
      artistStylePrompt: this.config.artistStylePrompt || "",
      // API 层使用 V4 结构化角色槽；这里保留扁平 prompt 作为 payload 被端点拒绝时的降级输入。
      useCharacterSegments: false
    });

    // E. 更新 UI 冷却通知回调
    if (this.uiCooldownCallback) {
      this.uiCooldownCallback();
    }

    // F. 调用 NAI 生图
    const vibeBundle = await this.getVibeBundleForModel(naiModel);
    const result = await this.naiClient.generateImage(promptResult.finalPositive, {
      model: naiModel,
      negativePrompt: promptResult.finalNegative,
      width: promptResult.width,
      height: promptResult.height,
      steps: Number(this.config.steps) || 28,
      scale: Number(this.config.scale) || 5.5,
      sampler: this.config.sampler || "k_euler_ancestral",
      noiseSchedule: this.config.noiseSchedule || "karras",
      basePrompt: promptResult.basePrompt,
      characterPrompts: promptResult.characterPrompts,
      // Multi-character interactions are more coherent as one flat caption.
      // Separate V4 character captions often produce side-by-side panels.
      useStructuredCharacterCaptions: promptResult.characterPrompts.length <= 1,
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
    scene.final_prompt = promptResult.finalPositive;
    scene.final_negative = promptResult.finalNegative;
    scene.base_prompt = promptResult.basePrompt;
    scene.character_prompts = promptResult.characterPrompts;
    scene.width = promptResult.width;
    scene.height = promptResult.height;

    this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
    await this.projectProgress.save();

    // 进度更新回调
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

  /**
   * 单场景重绘（保留现有分镜描述，仅重新生图）
   */
  async redrawScene(chapterKey, sceneIdx) {
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
        imagePath: null // null 表示开始重画中
      });
    }

    this.isRunning = true;
    try {
      const llmModel = this.config.llm_model || "deepseek-chat";
      const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";
      this.writeLog(`[Pipeline] 开始单场景重绘: 章节「${chap.chapter}」场景 #${sceneIdx}`);
      await this.generateSingleScene(chap, scene, scenes, chapKey, llmModel, naiModel);
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
          imagePath: 'failed'
        });
      }
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 仅使用场景已保存的最终 Prompt 重绘，不调用 LLM 或 MCP。
   */
  async redrawSceneWithSavedPrompt(chapterKey, sceneIdx) {
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

    this.isRunning = true;
    try {
      const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";
      const characterPrompts = Array.isArray(scene.character_prompts) ? scene.character_prompts : [];
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
        useStructuredCharacterCaptions: characterPrompts.length <= 1,
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
        imagePath: 'failed'
      });
      this.writeLog(`[Pipeline] 仅 NAI 重绘失败: ${err.message}`, "error");
      throw err;
    } finally {
      this.isRunning = false;
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
        const llmModel = this.config.llm_model || "deepseek-chat";
        const naiModel = this.config.nai_model || "nai-diffusion-4-5-full";
        this.writeLog(`[Pipeline] 开始重构分镜画面描述: 章节「${chap.chapter}」场景 #${sceneIdx}`);

        // 调用大模型重新提炼描述卡片
        const newSceneCard = await this.llmExtractor.regenerateSingleSceneCard(
          chap.chapter,
          chap.content,
          scene.scene_idx,
          scene.trigger_sentence,
          llmModel
        );

        // 把新卡片属性融合到原有 scene 中，重设 status 和清除老图
        Object.assign(scene, newSceneCard, { status: 'PENDING', image_path: null });
        this.projectProgress.setChapterStatus(chapKey, 'generating', scenes);
        await this.projectProgress.save();

        this.writeLog(`[Pipeline] 描述重构完成，开始重绘场景 #${sceneIdx}...`);
        await this.generateSingleScene(chap, scene, scenes, chapKey, llmModel, naiModel);
        this.writeLog(`[Pipeline] 单场景重构并重绘成功: 章节「${chap.chapter}」场景 #${sceneIdx}`);
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
            imagePath: 'failed'
          });
        }
      } finally {
        this.isRunning = false;
      }
    })();
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
