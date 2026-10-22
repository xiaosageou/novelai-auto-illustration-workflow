import { EventEmitter } from 'events';

/**
 * GlobalQueueManager - 全局跨项目两级调度队列管理器
 * 
 * 核心架构：
 * 1. Prompt 队列 (LLM 阶段)：
 *    - 负责分镜切分、视觉描写提取、角色 DNA 绑定、NovelAI Prompt 组装。
 *    - 跨项目 FIFO 排队。当 Project A 的 Prompt 阶段跑完后，Prompt 队列立即接管 Project B 的任务。
 *    - 每当一个场景的 Prompt 准备完毕 (PROMPT_READY)，立即推入 Image 队列！
 * 
 * 2. Image 队列 (NovelAI 生图阶段)：
 *    - 负责从 scene.prepared_prompt 读取就绪提示词，调用 NovelAIClient 生成图片，并存盘落库。
 *    - 严格串行单例（遵守全局 15s/35s 冷却，杜绝 API 429 报错与并发冲突）。
 *    - 跨项目连续消费：画完 Project A 的场景无缝接着画 Project B 的场景。
 *    - 支持单场景重绘 (priority: true) 插队消费。
 */
export class GlobalQueueManager extends EventEmitter {
  constructor({ getPipeline, broadcastSSE, cooldownManager }) {
    super();
    this.getPipeline = getPipeline;
    this.broadcastSSE = broadcastSSE;
    this.cooldownManager = cooldownManager;

    // Prompt 队列 (LLM)
    this.promptQueue = {
      running: false,
      current: null, // { id, projectName, type, chapterKey, payload, abortController }
      items: []
    };

    // Image 队列 (NovelAI)
    this.imageQueue = {
      running: false,
      current: null, // { id, projectName, chapterKey, sceneIdx, mode, priority }
      priorityItems: [], // 手动单图重绘插队队列
      items: []          // 常规批量场景生图队列
    };

    // 选段提炼会重写整章的 scenes 数组；与在途生图的落盘互斥，
    // 避免生图结果用旧数组覆盖刚新增的选段场景。
    this.imageJobActive = false;
    this.sceneMutationLock = false;

    this._jobSeq = 0;
  }

  _generateJobId(prefix = 'job') {
    this._jobSeq = (this._jobSeq + 1) % 1000000;
    return `${prefix}_${Date.now()}_${this._jobSeq}`;
  }

  // ==================== 1. Prompt 队列管理 ====================

  /**
   * 推入 Prompt 任务
   * @param {Object} param
   * @param {string} param.projectName 项目名称
   * @param {'pipeline'|'chapter_generate'|'selected_scenes'|'redraw_prompt'} param.type 任务类型
   * @param {string|null} param.chapterKey 章节 Key（单章或单场景时有效）
   * @param {Object} param.payload 附带参数（如 selections、autoUpdateCharacterDna、sceneIdx 等）
   * @param {boolean} param.priority 是否高优插队（单场景 Prompt 重绘可插队）
   */
  enqueuePromptJob({ projectName, type = 'pipeline', chapterKey = null, payload = {}, priority = false }) {
    const normalizedChapterKey = chapterKey ? String(chapterKey).trim() : null;
    const key = `${projectName}::${type}::${normalizedChapterKey || 'all'}::${payload.sceneIdx ?? ''}::${payload.mode || ''}`;

    // 检查是否已经在执行或排队中（去重）
    const isCurrent = this.promptQueue.current && this.promptQueue.current.key === key;
    const existingIndex = this.promptQueue.items.findIndex(item => item.key === key);

    if (isCurrent) {
      return { duplicate: true, state: 'running', position: 0, key };
    }
    if (existingIndex !== -1) {
      return { duplicate: true, state: 'queued', position: existingIndex + 1, key };
    }

    const job = {
      id: this._generateJobId('prompt'),
      key,
      projectName,
      type,
      chapterKey: normalizedChapterKey,
      payload,
      createdAt: Date.now()
    };

    if (priority) {
      this.promptQueue.items.unshift(job);
    } else {
      this.promptQueue.items.push(job);
    }

    const position = priority ? 1 : this.promptQueue.items.length;
    this.notifyStateChange();

    // 场景级 Prompt 任务：同步广播排队状态，前端据此点亮该场景的 loading
    if (payload && payload.sceneIdx != null) {
      this.broadcastSSE?.('redraw_queue', {
        projectName,
        chapterKey: normalizedChapterKey,
        sceneIdx: Number(payload.sceneIdx),
        state: 'queued',
        priority: Boolean(priority),
        position,
        remaining: this.getProjectPendingImageCount(projectName),
        message: type === 'regenerate_scene' ? '等待重构描述与 Prompt' : '等待重新提炼 Prompt'
      });
    }

    // 异步触发调度
    void this._processPromptQueue();

    return {
      success: true,
      jobId: job.id,
      duplicate: false,
      state: this.promptQueue.current ? 'queued' : 'starting',
      position,
      key
    };
  }

  async _processPromptQueue() {
    if (this.promptQueue.running) return;
    this.promptQueue.running = true;

    try {
      while (this.promptQueue.items.length > 0) {
        const job = this.promptQueue.items.shift();
        this.promptQueue.current = job;
        this.notifyStateChange();

        this.broadcastSSE?.('pipeline_started', {
          projectName: job.projectName,
          chapterKey: job.chapterKey,
          type: job.type
        });

        let pipeline = null;
        try {
          pipeline = await this.getPipeline(job.projectName);
          if (pipeline.isPausedByUser) {
            pipeline.isPausedByUser = false;
          }

          if (job.type === 'pipeline') {
            // 全书批量流水线：仅跑 Prompt 提炼，每就绪一个 scene 立即推入全局 Image 队列
            await pipeline.processPromptPhase(null, {
              autoUpdateCharacterDna: Boolean(job.payload?.autoUpdateCharacterDna),
              onScenePromptReady: ({ chapKey, scene }) => {
                this.enqueueImageJob({
                  projectName: job.projectName,
                  chapterKey: chapKey,
                  sceneIdx: scene.scene_idx,
                  mode: 'pipeline_scene'
                });
              }
            });
          } else if (job.type === 'chapter_generate') {
            // 单章生成：complete = 保留分镜补齐；redraw = 清空分镜与旧图后重新提炼
            await pipeline.processPromptPhase(job.chapterKey, {
              autoUpdateCharacterDna: Boolean(job.payload?.autoUpdateCharacterDna),
              resetScenes: job.payload?.mode === 'redraw',
              onScenePromptReady: ({ chapKey, scene }) => {
                this.enqueueImageJob({
                  projectName: job.projectName,
                  chapterKey: chapKey,
                  sceneIdx: scene.scene_idx,
                  mode: 'pipeline_scene'
                });
              }
            });
          } else if (job.type === 'selected_scenes') {
            // 选段场景提炼：与在途生图互斥，避免生图落盘时用旧 scenes 覆盖新增选段
            this.sceneMutationLock = true;
            try {
              if (this.imageJobActive || pipeline.isRunning) {
                this.broadcastSSE?.('log', {
                  text: '⏳ 正文选段等待当前生图落盘后再提炼...',
                  type: 'info'
                });
              }
              const waitDeadline = Date.now() + 10 * 60 * 1000;
              while (this.imageJobActive || pipeline.isRunning) {
                if (Date.now() > waitDeadline) {
                  throw new Error('当前仍有生图任务在运行，请稍后再提交正文选段。');
                }
                await new Promise(resolve => setTimeout(resolve, 200));
              }

              const result = await pipeline.appendSelectedParagraphScenes(job.chapterKey, job.payload.selections, {
                onScenePromptReady: ({ chapKey, scene }) => {
                  this.enqueueImageJob({
                    projectName: job.projectName,
                    chapterKey: chapKey,
                    sceneIdx: scene.scene_idx,
                    mode: 'pipeline_scene'
                  });
                }
              });
              this.broadcastSSE?.('log', {
                text: `🟢 选段 Prompt 提取完毕，已为项目「${job.projectName}」排入生图队列`,
                type: 'info'
              });
            } finally {
              this.sceneMutationLock = false;
            }
          } else if (job.type === 'redraw_prompt') {
            // 单场景 Prompt 重新提炼
            await pipeline.prepareSingleSceneForRedraw(job.chapterKey, job.payload.sceneIdx);
            // Prompt 刷新完毕后推入 Image 队列插队出图
            this.enqueueImageJob({
              projectName: job.projectName,
              chapterKey: job.chapterKey,
              sceneIdx: job.payload.sceneIdx,
              mode: 'nai_only',
              priority: true
            });
          } else if (job.type === 'regenerate_scene') {
            // 单场景描述重构：先重写分镜卡片并重建 Prompt，再插队进入串行生图队列
            await pipeline.regenerateScenePromptOnly(job.chapterKey, job.payload.sceneIdx);
            this.enqueueImageJob({
              projectName: job.projectName,
              chapterKey: job.chapterKey,
              sceneIdx: job.payload.sceneIdx,
              mode: 'nai_only',
              priority: true
            });
            this.broadcastSSE?.('log', {
              text: `🟢 场景 #${job.payload.sceneIdx} 描述与 Prompt 重构完成，已插入生图队列最前`,
              type: 'info'
            });
          }
        } catch (error) {
          console.error(`[GlobalQueue] Prompt 任务执行异常 (${job.projectName} / ${job.type}):`, error);
          // 场景级 Prompt 任务失败时补发场景终态，避免前端 loading 永久卡住
          if (job.payload && job.payload.sceneIdx != null) {
            this.broadcastSSE?.('redraw_queue', {
              projectName: job.projectName,
              chapterKey: job.chapterKey,
              sceneIdx: Number(job.payload.sceneIdx),
              state: 'failed',
              message: error.message,
              remaining: this.getProjectPendingImageCount(job.projectName),
              pipelineRunning: this.isProjectActive(job.projectName)
            });
          }
          this.broadcastSSE?.('pipeline_failed', {
            projectName: job.projectName,
            chapterKey: job.chapterKey,
            type: job.type,
            message: error.message
          });
        } finally {
          this.promptQueue.current = null;
          this.notifyStateChange();
        }
      }
    } finally {
      this.promptQueue.running = false;
      this.notifyStateChange();
    }
  }

  // ==================== 2. Image 队列管理 (NovelAI) ====================

  /**
   * 推入 Image 生图任务
   * @param {Object} param
   * @param {string} param.projectName 项目名
   * @param {string} param.chapterKey 章节 Key
   * @param {number} param.sceneIdx 场景序号
   * @param {'pipeline_scene'|'nai_only'} param.mode 生图模式
   * @param {boolean} param.priority 是否插队（单场景手动重绘优先）
   * @param {Function} param.onFinished 完成回调
   */
  enqueueImageJob({
    projectName,
    chapterKey,
    sceneIdx,
    mode = 'pipeline_scene',
    priority = false,
    onFinished = null,
    agentOptions = {}
  }) {
    const normalizedChapterKey = String(chapterKey || '').trim();
    const normalizedSceneIdx = Number(sceneIdx);
    const key = `${projectName}::${normalizedChapterKey}::${normalizedSceneIdx}`;

    // 去重检查
    const isCurrent = this.imageQueue.current && this.imageQueue.current.key === key;
    if (isCurrent) {
      return { duplicate: true, state: 'running', position: 0, key };
    }

    const inPriority = this.imageQueue.priorityItems.findIndex(i => i.key === key);
    if (inPriority !== -1) {
      return { duplicate: true, state: 'queued', position: inPriority + 1, priority: true, key };
    }

    const inNormal = this.imageQueue.items.findIndex(i => i.key === key);
    if (inNormal !== -1) {
      return {
        duplicate: true,
        state: 'queued',
        position: this.imageQueue.priorityItems.length + inNormal + 1,
        priority: false,
        key
      };
    }

    const job = {
      id: this._generateJobId('img'),
      key,
      projectName,
      chapterKey: normalizedChapterKey,
      sceneIdx: normalizedSceneIdx,
      mode,
      priority: Boolean(priority),
      onFinished,
      ...agentOptions,
      createdAt: Date.now()
    };

    if (priority) {
      this.imageQueue.priorityItems.push(job);
    } else {
      this.imageQueue.items.push(job);
    }

    const position = priority
      ? this.imageQueue.priorityItems.length
      : this.imageQueue.priorityItems.length + this.imageQueue.items.length;

    this.notifyStateChange();

    // 触发针对特定项目的 redraw_queue SSE 广播（兼容老前端）
    this.broadcastSSE?.('redraw_queue', {
      projectName,
      chapterKey: normalizedChapterKey,
      sceneIdx: normalizedSceneIdx,
      state: 'queued',
      position,
      remaining: this.getProjectPendingImageCount(projectName),
      priority
    });

    // 异步触发消费
    void this._processImageQueue();

    return {
      success: true,
      jobId: job.id,
      duplicate: false,
      state: 'queued',
      position,
      priority,
      key
    };
  }

  async _processImageQueue() {
    if (this.imageQueue.running) return;
    this.imageQueue.running = true;

    try {
      while (this.imageQueue.priorityItems.length > 0 || this.imageQueue.items.length > 0) {
        // 选段提炼期间暂停取新图，等它写完 scenes 再继续
        while (this.sceneMutationLock) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        // 优先消费插队队列
        const job = this.imageQueue.priorityItems.length > 0
          ? this.imageQueue.priorityItems.shift()
          : this.imageQueue.items.shift();

        this.imageJobActive = true;
        this.imageQueue.current = job;
        this.notifyStateChange();

        // 广播当前场景开始生图
        this.broadcastSSE?.('redraw_queue', {
          projectName: job.projectName,
          chapterKey: job.chapterKey,
          sceneIdx: job.sceneIdx,
          state: 'running',
          remaining: this.getProjectPendingImageCount(job.projectName)
        });

        let generationError = null;
        let outcome = 'completed';
        let outcomeMessage = '';
        try {
          const pipeline = await this.getPipeline(job.projectName);

          if (pipeline.isPausedByUser) {
            if (job.priority) {
              // 手动插队重绘是用户的显式操作意图：解除暂停后继续，避免点击无反应
              pipeline.isPausedByUser = false;
              console.log(`[GlobalQueue] 项目「${job.projectName}」处于暂停态，手动重绘场景 #${job.sceneIdx} 已解除暂停`);
            } else {
              outcome = 'skipped';
              outcomeMessage = '项目已暂停，跳过批量出图';
              console.log(`[GlobalQueue] 项目「${job.projectName}」已暂停，跳过场景 #${job.sceneIdx} 的出图`);
            }
          }

          if (outcome === 'completed') {
            // 核心绘制调用：使用已就绪/已保存的 Prompt 出图，严格串行并执行冷却
            const drawResult = await pipeline.redrawSceneWithSavedPrompt(job.chapterKey, job.sceneIdx, { interleaved: true });
            if (drawResult === null) {
              // 绘制过程中被用户暂停：保留 PROMPT_READY，按 skipped 处理而不是 completed
              outcome = 'skipped';
              outcomeMessage = '项目已暂停，出图已中断';
            }
          }

          if (outcome === 'completed') {
            const progress = pipeline.projectProgress.getCompletedChapters()?.[job.chapterKey];
            if (progress && Array.isArray(progress.scenes) && progress.scenes.length > 0) {
              const allSuccess = progress.scenes.every(s => s.status === 'SUCCESS');
              if (allSuccess && progress.status !== 'completed') {
                const chap = pipeline.chapters.find(c => {
                  const ck = pipeline.projectProgress.getEffectiveChapKey(c.volume, c.chapter);
                  return pipeline.projectProgress.normalizeKey(ck) === pipeline.projectProgress.normalizeKey(job.chapterKey);
                });
                const content = String(chap?.content || '').trim();
                pipeline.projectProgress.setChapterStatus(job.chapterKey, 'completed', progress.scenes, {
                  content_length: content.length
                });
                await pipeline.projectProgress.save();
                this.broadcastSSE?.('chapter_queue', {
                  projectName: job.projectName,
                  chapterKey: job.chapterKey,
                  state: 'completed',
                  remaining: 0
                });
              }
            }
          }
        } catch (error) {
          generationError = error;
          outcome = 'failed';
          outcomeMessage = error.message;
          console.error(`[GlobalQueue] 场景生图异常 (${job.projectName} / ${job.chapterKey} / #${job.sceneIdx}):`, error.message);
        } finally {
          this.imageJobActive = false;
          try {
            await job.onFinished?.(generationError);
          } catch (e) {
            console.error('[GlobalQueue] onFinished 回调异常:', e);
          }

          // 先清空 current，再统计剩余量，避免把当前任务重复计入 remaining
          this.imageQueue.current = null;
          const remaining = this.getProjectPendingImageCount(job.projectName);
          const pipelineRunning = this.isProjectActive(job.projectName);

          this.broadcastSSE?.('redraw_queue', {
            projectName: job.projectName,
            chapterKey: job.chapterKey,
            sceneIdx: job.sceneIdx,
            state: outcome,
            ...(outcomeMessage ? { message: outcomeMessage } : {}),
            remaining,
            pipelineRunning
          });
          this.notifyStateChange();

          // 跳过（暂停）不算完成，不能广播 pipeline_completed
          if (outcome === 'completed' && !pipelineRunning) {
            this.broadcastSSE?.('pipeline_completed', {
              projectName: job.projectName,
              chapterKey: job.chapterKey
            });
          } else if (outcome === 'failed' && !pipelineRunning) {
            this.broadcastSSE?.('pipeline_failed', {
              projectName: job.projectName,
              chapterKey: job.chapterKey,
              type: 'image',
              message: outcomeMessage || '场景生图失败'
            });
          }
        }
      }
    } finally {
      this.imageQueue.running = false;
      this.notifyStateChange();
    }
  }

  // ==================== 3. 取消与暂停管理 ====================

  /**
   * 取消指定项目的排队和正在执行的任务
   * @param {string} projectName 项目名称
   */
  async cancelProjectJobs(projectName) {
    let removedPromptCount = 0;
    let removedImageCount = 0;

    // 记录取消前是否有该项目的在途任务；只有真的需要中断时才置暂停
    const promptInFlight = Boolean(this.promptQueue.current && this.promptQueue.current.projectName === projectName);
    const imageInFlight = Boolean(this.imageQueue.current && this.imageQueue.current.projectName === projectName);

    // 1. 从 Prompt 队列中过滤掉该项目的任务
    const originalPromptLen = this.promptQueue.items.length;
    this.promptQueue.items = this.promptQueue.items.filter(item => item.projectName !== projectName);
    removedPromptCount += (originalPromptLen - this.promptQueue.items.length);

    // 2. 如果当前正在执行该项目的 Prompt 任务，触发 pipeline.stop()
    if (this.promptQueue.current && this.promptQueue.current.projectName === projectName) {
      try {
        const pipeline = await this.getPipeline(projectName);
        await pipeline.stop();
      } catch (e) {
        console.error(`[GlobalQueue] 停止项目 ${projectName} 的 Prompt pipeline 失败:`, e);
      }
    }

    // 3. 从 Image 队列中过滤掉该项目的待生图任务
    const origPriorityLen = this.imageQueue.priorityItems.length;
    this.imageQueue.priorityItems = this.imageQueue.priorityItems.filter(item => item.projectName !== projectName);
    removedImageCount += (origPriorityLen - this.imageQueue.priorityItems.length);

    const origNormalLen = this.imageQueue.items.length;
    this.imageQueue.items = this.imageQueue.items.filter(item => item.projectName !== projectName);
    removedImageCount += (origNormalLen - this.imageQueue.items.length);

    // 4. 如果当前正在跑该项目的任务，标记 pipeline 为暂停，完成后不会继续下一个该项目任务
    //    仅排队任务被清空时不需要暂停，否则会让后续手动重绘被静默跳过
    if (promptInFlight || imageInFlight) {
      try {
        const pipeline = await this.getPipeline(projectName);
        pipeline.isPausedByUser = true;
      } catch {}
    }

    this.notifyStateChange();
    this.broadcastSSE?.('pipeline_stopped', { projectName, state: 'paused' });

    return {
      success: true,
      removedPromptCount,
      removedImageCount
    };
  }

  // ==================== 4. 状态查询与通知 ====================

  /**
   * 该场景此刻是否正被处理（Prompt 提炼或生图正在执行）。
   * 仅「正在执行」返回 true；只是在队列里等待、尚未轮到时不返回 true，
   * 这样编辑其他/等待中的场景卡不会被拦截。
   */
  isSceneRunning(projectName, chapterKey, sceneIdx) {
    const normalizedChapterKey = String(chapterKey || '').trim();
    const normalizedSceneIdx = Number(sceneIdx);

    if (this.promptQueue.current
      && this.promptQueue.current.projectName === projectName
      && String(this.promptQueue.current.chapterKey || '').trim() === normalizedChapterKey
      && Number(this.promptQueue.current.payload?.sceneIdx) === normalizedSceneIdx) {
      return true;
    }

    if (this.imageQueue.current
      && this.imageQueue.current.projectName === projectName
      && String(this.imageQueue.current.chapterKey || '').trim() === normalizedChapterKey
      && Number(this.imageQueue.current.sceneIdx) === normalizedSceneIdx) {
      return true;
    }

    return false;
  }

  isSceneInQueue(projectName, chapterKey, sceneIdx) {
    const normalizedChapterKey = String(chapterKey || '').trim();
    const normalizedSceneIdx = Number(sceneIdx);

    // 检查 Prompt 队列中是否有针对该场景的重绘任务
    if (this.promptQueue.current
      && this.promptQueue.current.projectName === projectName
      && String(this.promptQueue.current.chapterKey || '').trim() === normalizedChapterKey
      && Number(this.promptQueue.current.payload?.sceneIdx) === normalizedSceneIdx) {
      return true;
    }
    if (this.promptQueue.items.some(item =>
      item.projectName === projectName
      && String(item.chapterKey || '').trim() === normalizedChapterKey
      && Number(item.payload?.sceneIdx) === normalizedSceneIdx
    )) {
      return true;
    }

    // 检查 Image 队列
    if (this.imageQueue.current
      && this.imageQueue.current.projectName === projectName
      && String(this.imageQueue.current.chapterKey || '').trim() === normalizedChapterKey
      && Number(this.imageQueue.current.sceneIdx) === normalizedSceneIdx) {
      return true;
    }
    const inImage = [...this.imageQueue.priorityItems, ...this.imageQueue.items].some(item =>
      item.projectName === projectName
      && String(item.chapterKey || '').trim() === normalizedChapterKey
      && Number(item.sceneIdx) === normalizedSceneIdx
    );
    return inImage;
  }

  removeQueuedScene(projectName, chapterKey, sceneIdx) {
    const normalizedChapterKey = String(chapterKey || '').trim();
    const normalizedSceneIdx = Number(sceneIdx);
    let removed = 0;

    const origPromptLen = this.promptQueue.items.length;
    this.promptQueue.items = this.promptQueue.items.filter(item =>
      !(item.projectName === projectName
        && String(item.chapterKey || '').trim() === normalizedChapterKey
        && Number(item.payload?.sceneIdx) === normalizedSceneIdx)
    );
    removed += (origPromptLen - this.promptQueue.items.length);

    const origPriLen = this.imageQueue.priorityItems.length;
    this.imageQueue.priorityItems = this.imageQueue.priorityItems.filter(item =>
      !(item.projectName === projectName
        && String(item.chapterKey || '').trim() === normalizedChapterKey
        && Number(item.sceneIdx) === normalizedSceneIdx)
    );
    removed += (origPriLen - this.imageQueue.priorityItems.length);

    const origNormLen = this.imageQueue.items.length;
    this.imageQueue.items = this.imageQueue.items.filter(item =>
      !(item.projectName === projectName
        && String(item.chapterKey || '').trim() === normalizedChapterKey
        && Number(item.sceneIdx) === normalizedSceneIdx)
    );
    removed += (origNormLen - this.imageQueue.items.length);

    if (removed > 0) {
      this.notifyStateChange();
    }
    return removed;
  }

  isProjectActive(projectName) {
    if (this.promptQueue.current && this.promptQueue.current.projectName === projectName) return true;
    if (this.promptQueue.items.some(i => i.projectName === projectName)) return true;
    if (this.imageQueue.current && this.imageQueue.current.projectName === projectName) return true;
    if (this.imageQueue.priorityItems.some(i => i.projectName === projectName)) return true;
    if (this.imageQueue.items.some(i => i.projectName === projectName)) return true;
    return false;
  }

  getProjectPendingImageCount(projectName) {
    let count = 0;
    if (this.imageQueue.current && this.imageQueue.current.projectName === projectName) count++;
    count += this.imageQueue.priorityItems.filter(i => i.projectName === projectName).length;
    count += this.imageQueue.items.filter(i => i.projectName === projectName).length;
    return count;
  }

  /**
   * 获取全局队列的完整状态快照
   */
  getGlobalState() {
    return {
      promptQueue: {
        running: Boolean(this.promptQueue.running || this.promptQueue.current),
        current: this.promptQueue.current ? {
          id: this.promptQueue.current.id,
          projectName: this.promptQueue.current.projectName,
          type: this.promptQueue.current.type,
          chapterKey: this.promptQueue.current.chapterKey
        } : null,
        pendingCount: this.promptQueue.items.length,
        items: this.promptQueue.items.map((item, idx) => ({
          position: idx + 1,
          projectName: item.projectName,
          type: item.type,
          chapterKey: item.chapterKey
        }))
      },
      imageQueue: {
        running: Boolean(this.imageQueue.running || this.imageQueue.current),
        current: this.imageQueue.current ? {
          id: this.imageQueue.current.id,
          projectName: this.imageQueue.current.projectName,
          chapterKey: this.imageQueue.current.chapterKey,
          sceneIdx: this.imageQueue.current.sceneIdx,
          priority: this.imageQueue.current.priority
        } : null,
        priorityPendingCount: this.imageQueue.priorityItems.length,
        normalPendingCount: this.imageQueue.items.length,
        totalPendingCount: this.imageQueue.priorityItems.length + this.imageQueue.items.length,
        items: [
          ...this.imageQueue.priorityItems.map((item, idx) => ({
            position: idx + 1,
            projectName: item.projectName,
            chapterKey: item.chapterKey,
            sceneIdx: item.sceneIdx,
            priority: true
          })),
          ...this.imageQueue.items.map((item, idx) => ({
            position: this.imageQueue.priorityItems.length + idx + 1,
            projectName: item.projectName,
            chapterKey: item.chapterKey,
            sceneIdx: item.sceneIdx,
            priority: false
          }))
        ]
      },
      cooldown: this.cooldownManager?.getState() || { isCooling: false, remainingSeconds: 0 }
    };
  }

  /**
   * 针对指定项目提供状态描述（兼容原 status 结构）
   */
  getProjectQueueState(projectName) {
    const globalState = this.getGlobalState();
    const isPromptRunning = this.promptQueue.current?.projectName === projectName;
    const promptItemIndex = this.promptQueue.items.findIndex(i => i.projectName === projectName);
    const isPromptQueued = promptItemIndex !== -1;

    const isImageRunning = this.imageQueue.current?.projectName === projectName;
    const projectImageItems = [
      ...this.imageQueue.priorityItems.filter(i => i.projectName === projectName),
      ...this.imageQueue.items.filter(i => i.projectName === projectName)
    ];

    const isBusy = Boolean(isPromptRunning || isPromptQueued || isImageRunning || projectImageItems.length > 0);

    return {
      isRunning: isBusy,
      projectName,
      busy: isBusy,
      promptState: {
        running: isPromptRunning,
        queued: isPromptQueued,
        position: isPromptRunning ? 0 : (promptItemIndex !== -1 ? promptItemIndex + 1 : null),
        current: isPromptRunning ? this.promptQueue.current : null
      },
      imageState: {
        running: isImageRunning,
        pending: projectImageItems.length,
        current: isImageRunning ? {
          chapterKey: this.imageQueue.current.chapterKey,
          sceneIdx: this.imageQueue.current.sceneIdx
        } : null
      },
      // 向下兼容老接口字段
      redrawQueue: {
        running: isImageRunning,
        pending: projectImageItems.length,
        current: isImageRunning ? {
          chapterKey: this.imageQueue.current.chapterKey,
          sceneIdx: this.imageQueue.current.sceneIdx
        } : null
      },
      chapterQueue: {
        running: isPromptRunning,
        pending: isPromptQueued ? 1 : 0,
        pendingChapterKeys: this.promptQueue.items.filter(i => i.projectName === projectName && i.chapterKey).map(i => i.chapterKey),
        current: isPromptRunning && this.promptQueue.current.chapterKey ? {
          chapterKey: this.promptQueue.current.chapterKey
        } : null
      },
      selectedScenesQueue: {
        running: isPromptRunning && this.promptQueue.current.type === 'selected_scenes',
        pending: this.promptQueue.items.filter(i => i.projectName === projectName && i.type === 'selected_scenes').length
      },
      cooldown: this.cooldownManager?.getState() || { isCooling: false, remainingSeconds: 0 },
      globalQueue: globalState
    };
  }

  notifyStateChange() {
    const globalState = this.getGlobalState();
    this.broadcastSSE?.('global_queue_state', globalState);
    this.emit('state_change', globalState);
  }
}
