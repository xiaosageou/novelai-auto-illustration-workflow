import { globalCooldownManager } from '../utils/cooldown.js';
import { removeNonEnglishPromptTokens } from '../utils/prompt-cleaner.js';
import { extractFirstImageFromZip, uint8ArrayToDataUrl, detectImageMimeType } from '../utils/zip-parser.js';

const NOVELAI_TRIAL_RECAPTCHA_PATTERN = /recaptcha token is required for trial generation/i;
const NOVELAI_ACCESS_DENIED_PATTERN = /access_denied|ip .*not .*allow|ip .*not .*allowed|ip.*白名单|ip.*允许访问|不在令牌允许访问的列表/i;

function isRetryableStreamError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "terminated",
    "aborted",
    "econnreset",
    "socket hang up",
    "other side closed",
    "premature close",
    "body timeout"
  ].some(token => message.includes(token));
}

function normalizeCharacterCaption(prompt = "") {
  const tokens = String(prompt || "")
    .split(/[,，]/)
    .map(token => token.trim())
    .filter(Boolean);
  let subjectType = "";
  const normalizedTokens = tokens.filter(token => {
    if (/^(?:1girl|1woman|1female)$/i.test(token)) {
      subjectType ||= "girl";
      return false;
    }
    if (/^(?:1boy|1man|1male)$/i.test(token)) {
      subjectType ||= "boy";
      return false;
    }
    if (/^(?:girl|woman|female)$/i.test(token)) {
      subjectType ||= "girl";
      return false;
    }
    if (/^(?:boy|man|male)$/i.test(token)) {
      subjectType ||= "boy";
      return false;
    }
    if (/^(?:creature|monster|animal|other)$/i.test(token)) {
      subjectType ||= "other";
      return false;
    }
    return true;
  });
  return [subjectType, ...normalizedTokens].filter(Boolean).join(", ");
}

function buildDefaultCharacterCenters(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0.5, y: 0.5 }];
  const grid = [0.1, 0.3, 0.5, 0.7, 0.9];
  return Array.from({ length: count }, (_, index) => ({
    x: grid[Math.round((index * (grid.length - 1)) / (count - 1))],
    y: 0.5
  }));
}

function normalizeCharacterCenters(characterCenters = [], count = 0) {
  const defaults = buildDefaultCharacterCenters(count);
  const grid = [0.1, 0.3, 0.5, 0.7, 0.9];
  const snapToGrid = (value) => grid.reduce((closest, candidate) => (
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest
  ), grid[0]);
  return Array.from({ length: count }, (_, index) => {
    const supplied = characterCenters[index];
    const x = Number(supplied?.x);
    const y = Number(supplied?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return defaults[index];
    return {
      x: snapToGrid(Math.min(0.9, Math.max(0.1, x))),
      y: snapToGrid(Math.min(0.9, Math.max(0.1, y)))
    };
  });
}

export class NovelAIClient {
  static DEFAULT_MODELS = {
    "nai-diffusion-4-5-full": "Anime V4.5 (最新顶级完整版)",
    "nai-diffusion-4-5-curated": "Anime V4.5 (精选版)",
    "nai-diffusion-3": "Anime V3 (经典二次元)",
    "safe-diffusion-3": "Anime V3 (SFW 安全版)",
    "furry-diffusion-3": "Furry V3 (兽人二次元)",
    "nai-diffusion-2": "Anime V2 (复古二次元)",
  };

  constructor({ token = "", baseUrl = "https://image.novelai.net" } = {}) {
    this.token = token.trim();
    this.baseUrl = baseUrl.trim();
  }

  setToken(token) {
    this.token = (token || "").trim();
  }

  setBaseUrl(baseUrl) {
    const nextBaseUrl = (baseUrl || "https://image.novelai.net").trim();
    this.baseUrl = nextBaseUrl;
  }

  getHeaders() {
    const headers = {
      "Content-Type": "application/json",
    };
    if (this.token) {
      // 保证 Bearer 格式
      const cleanToken = this.token.replace(/^Bearer\s+/i, "").trim();
      headers["Authorization"] = `Bearer ${cleanToken}`;
    }
    return headers;
  }

  /**
   * 规范化 API 地址，确保 NAI 官方域名重定向到生图子域名
   */
  _normalizeBaseUrl(url) {
    let cleanUrl = (url || "").trim().replace(/\/+$/, "");
    if (/https?:\/\/(api\.)?novelai\.net/i.test(cleanUrl)) {
      if (!/image\.novelai\.net/i.test(cleanUrl)) {
        cleanUrl = "https://image.novelai.net";
      }
    }
    return cleanUrl;
  }

  /**
   * 拉取云端可用模型列表
   */
  async getAvailableModels() {
    if (!this.token) {
      return NovelAIClient.DEFAULT_MODELS;
    }

    const normalizedBase = this._normalizeBaseUrl(this.baseUrl);
    let url = `${normalizedBase}/models`;
    if (!normalizedBase.toLowerCase().includes("/v1") && !normalizedBase.toLowerCase().includes("novelai.net")) {
      url = `${normalizedBase}/v1/models`;
    }

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000), // 10s 超时
      });

      if (res.status === 200) {
        const data = await res.json();
        
        // 兼容 OpenAI models 格式
        const modelsList = data.data || [];
        if (Array.isArray(modelsList) && modelsList.length > 0) {
          const fetched = {};
          for (const m of modelsList) {
            if (m && typeof m === "object") {
              fetched[m.id] = m.name || m.id;
            } else if (typeof m === "string") {
              fetched[m] = m;
            }
          }
          return fetched;
        }

        // 兼容直接数组格式
        if (Array.isArray(data)) {
          const fetched = {};
          for (const m of data) {
            if (m && typeof m === "object" && m.id) {
              fetched[m.id] = m.name || m.id;
            } else if (typeof m === "string") {
              fetched[m] = m;
            }
          }
          return fetched;
        }
      }
    } catch (e) {
      console.warn("[NAI Client] 拉取云端模型列表失败，降级为预设模型:", e.message);
    }

    return NovelAIClient.DEFAULT_MODELS;
  }

  /**
   * 核心图像生成接口
   */
  async generateImage(prompt, {
    model = "nai-diffusion-4-5-full",
    negativePrompt = "",
    width = 1024,
    height = 1024,
    steps = 28,
    scale = 5.0,
    sampler = "k_euler_ancestral",
    noiseSchedule = "karras",
    seed = null,
    basePrompt = null,
    characterPrompts = [],
    characterCenters = [],
    useStructuredCharacterCaptions = false,
    negativeBasePrompt = null,
    negativeCharacterPrompts = [],
    // 付费功能先预留字段
    imageBase64 = null,
    strength = 0.35,
    vibeImageBase64 = null,
    vibeStrength = 0.6,
    vibeEncodings = null,
    vibeStrengths = null,
    vibeInfoExtracted = 1.0,
    vibeNormalizeStrengths = true,
    signal = null,
    onRetry = null
  } = {}) {
    if (!this.token) {
      throw new Error("未配置有效的 NovelAI API Token！");
    }

    // 1. 触发全局自适应防抖冷却锁
    await globalCooldownManager.waitForCooldown();

    prompt = removeNonEnglishPromptTokens(prompt);
    negativePrompt = removeNonEnglishPromptTokens(negativePrompt);
    basePrompt = removeNonEnglishPromptTokens(basePrompt || '');
    characterPrompts = Array.isArray(characterPrompts)
      ? characterPrompts.map(removeNonEnglishPromptTokens).filter(Boolean)
      : [];
    negativeBasePrompt = removeNonEnglishPromptTokens(negativeBasePrompt || '');
    negativeCharacterPrompts = Array.isArray(negativeCharacterPrompts)
      ? negativeCharacterPrompts.map(removeNonEnglishPromptTokens)
      : [];

    const isV4Model = /nai-diffusion-4/i.test(model);
    const normalizedBase = this._normalizeBaseUrl(this.baseUrl);

    // 2. 自适应处理 NSFW 提示词屏蔽（解除艺术审查限制）
    const nsfwKeywords = [
      "nsfw", "nude", "naked", "breasts", "nipples", "pussy", "pubic", "panties", 
      "underwear", "lingerie", "nakedness", "topless", "lewd", "sexy", "undressing", 
      "cleavage", "bare thighs", "sex", "erotic"
    ];
    const isNsfwRequested = nsfwKeywords.some(kw => prompt.toLowerCase().includes(kw));

    let finalNegative = negativePrompt;
    if (!finalNegative) {
      const defaultNeg = "lowres, bad anatomy, bad hands, text, watermark, signature, blurry, extra fingers";
      finalNegative = isNsfwRequested ? defaultNeg : `nsfw, ${defaultNeg}`;
    } else if (isNsfwRequested) {
      // 强力清洗传入的自定义负向词，物理移除 nsfw 单词以释放艺术限制
      finalNegative = finalNegative.replace(/\bnsfw\b/gi, "");
      finalNegative = finalNegative.replace(/,\s*,+/g, ",");
      finalNegative = finalNegative.trim().replace(/^,|,$/g, "").trim();
    }

    // 3. 构建生图 Payload 参数
    const params = {
      width,
      height,
      scale,
      sampler,
      steps,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: true,
      sm: false,
      smDyn: false,
      dynamicThresholding: false,
      controlnetStrength: 1.0,
      legacy: false,
    };

    if (!isV4Model) {
      params.negative_prompt = finalNegative;
      params.addOriginalQuality = true;
      params.uncondScale = 1.0;
      params.cfgRescale = 0.0;
      params.noise = 0.0;
    } else {
      params.params_version = 3;
      params.noise_schedule = noiseSchedule;
      params.add_original_image = false;
      params.legacy_v3_extend = false;
      params.dynamic_thresholding = false;
      params.controlnet_strength = 1;
      params.cfg_rescale = 0;
      params.skip_cfg_above_sigma = null;
      params.use_coords = false;
      params.legacy_uc = false;
      params.normalize_reference_strength_multiple = vibeNormalizeStrengths;
      params.inpaintImg2ImgStrength = 1;
      params.negative_prompt = finalNegative;
      params.stream = "msgpack";

      // 祖先采样器 Bug 兼容处理
      if (sampler === "k_euler_ancestral") {
        params.deliberate_euler_ancestral_bug = false;
        params.prefer_brownian = true;
      }

      // V4/V4.5 角色槽遵循网页端结构：角色 prompt 不带人数，正负槽位和中心点一一对应。
      const cleanCharacterPrompts = useStructuredCharacterCaptions && Array.isArray(characterPrompts)
        ? characterPrompts.map(normalizeCharacterCaption).filter(Boolean)
        : [];
      // V4/V4.5 supports rough 5x5-grid placement when AI's Choice is disabled.
      const useCharacterCoords = cleanCharacterPrompts.length >= 2;
      const centers = normalizeCharacterCenters(characterCenters, cleanCharacterPrompts.length);
      const suppliedNegativePrompts = Array.isArray(negativeCharacterPrompts)
        ? negativeCharacterPrompts.map(item => String(item || '').trim())
        : [];
      const cleanNegativeCharacterPrompts = cleanCharacterPrompts.map((_, index) => suppliedNegativePrompts[index] || "");
      const positiveCharacterCaptions = cleanCharacterPrompts.map((charPrompt, index) => ({
        char_caption: charPrompt,
        centers: [centers[index]]
      }));
      const negativeCharacterCaptions = cleanNegativeCharacterPrompts.map((charPrompt, index) => ({
        char_caption: charPrompt,
        centers: [centers[index]]
      }));
      params.characterPrompts = cleanCharacterPrompts.map((charPrompt, index) => ({
        prompt: charPrompt,
        uc: cleanNegativeCharacterPrompts[index],
        center: centers[index],
        enabled: true
      }));
      params.v4_prompt = {
        use_coords: useCharacterCoords,
        use_order: cleanCharacterPrompts.length > 0,
        caption: {
          base_caption: cleanCharacterPrompts.length > 0 ? (basePrompt || prompt || '').trim() : (prompt || '').trim(),
          char_captions: positiveCharacterCaptions
        },
        legacy_uc: false
      };
      params.use_coords = useCharacterCoords;
      params.v4_negative_prompt = {
        caption: {
          base_caption: (negativeBasePrompt || finalNegative || '').trim(),
          char_captions: negativeCharacterCaptions
        },
        legacy_uc: false
      };
    }

    if (seed !== null && Number.isInteger(seed)) {
      params.seed = Math.max(0, seed);
    }

    // 传统图生图
    if (imageBase64) {
      const cleanBase64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
      params.image = cleanBase64;
      params.strength = strength;
      if (!isV4Model) params.noise = 0.0;
    }

    // Vibe Transfer：支持普通参考图 base64，也支持网页版导出的 .naiv4vibebundle encoding 数组
    const normalizeStrengths = (strengths) => {
      const nums = strengths.map(value => Number(value)).map(value => Number.isFinite(value) && value > 0 ? value : vibeStrength);
      const total = nums.reduce((sum, value) => sum + value, 0);
      if (vibeNormalizeStrengths && total > 1) {
        return nums.map(value => value / total);
      }
      return nums;
    };

    if (Array.isArray(vibeEncodings) && vibeEncodings.length > 0) {
      const cleanEncodings = vibeEncodings
        .map(item => String(item || '').includes(',') ? String(item).split(',').pop() : String(item || ''))
        .map(item => item.trim())
        .filter(Boolean);

      if (cleanEncodings.length > 0) {
        const strengths = Array.isArray(vibeStrengths) && vibeStrengths.length > 0
          ? vibeStrengths.slice(0, cleanEncodings.length)
          : cleanEncodings.map(() => vibeStrength);
        const infoValues = Array.isArray(vibeInfoExtracted)
          ? vibeInfoExtracted.slice(0, cleanEncodings.length).map(value => Number(value)).map(value => Number.isFinite(value) ? value : 1.0)
          : cleanEncodings.map(() => Number(vibeInfoExtracted) || 1.0);

        params.reference_image_multiple = cleanEncodings;
        params.reference_strength_multiple = normalizeStrengths(strengths);
        params.reference_information_extracted_multiple = infoValues;
      }
    } else if (vibeImageBase64) {
      const cleanBase64 = vibeImageBase64.includes(",") ? vibeImageBase64.split(",")[1] : vibeImageBase64;
      params.reference_image_multiple = [cleanBase64];
      params.reference_strength_multiple = normalizeStrengths([vibeStrength]);
      params.reference_information_extracted_multiple = [Number(vibeInfoExtracted) || 1.0];
    }

    const hasStructuredCharacterPayload = Boolean(
      isV4Model && params.v4_prompt?.caption?.char_captions?.length
    );
    const payload = {
      input: hasStructuredCharacterPayload
        ? params.v4_prompt.caption.base_caption
        : prompt,
      model,
      action: "generate",
      parameters: params
    };

    // 4. 规范化并组装端点 URL
    const url = `${normalizedBase}/ai/generate-image`;

    console.log(`[NAI Client] 发送生图请求 -> ${url} | 模型: ${model} | 尺寸: ${width}x${height}`);
    console.log(`[NAI Client] 最终正向 Prompt: ${payload.input}`);
    console.log(`[NAI Client] 最终负向 Prompt: ${finalNegative}`);
    if (isV4Model) {
      console.log(`[NAI Client] V4 Base Prompt: ${params.v4_prompt?.caption?.base_caption || ""}`);
      const finalCharacterCaptions = params.v4_prompt?.caption?.char_captions || [];
      finalCharacterCaptions.forEach((item, index) => {
        console.log(`[NAI Client] V4 Character Prompt ${index + 1}: ${item.char_caption || ""}`);
      });
      console.log(`[NAI Client] 最终采样参数: ${JSON.stringify({
        model,
        width,
        height,
        steps,
        scale,
        sampler,
        noise_schedule: noiseSchedule,
        use_coords: params.v4_prompt?.use_coords === true,
        use_order: params.v4_prompt?.use_order === true,
        character_prompt_count: finalCharacterCaptions.length,
        vibe_count: Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0
      })}`);
    }
    let attempt = 0;
    const maxRetries = 6;
    const waitBeforeRetry = async () => {
      const delaySeconds = globalCooldownManager.cooldownSeconds;
      globalCooldownManager.startCooldown();
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
      return delaySeconds;
    };

    try {
      while (true) {
        let res;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(payload),
            signal: signal
          });
        } catch (fetchErr) {
          globalCooldownManager.recordNon429Failure();
          if (attempt < maxRetries) {
            attempt++;
            const delaySeconds = globalCooldownManager.cooldownSeconds;
            const retryMsg = `[NAI Client] 网络连接失败 (${fetchErr.message})，将在 ${delaySeconds} 秒后进行第 ${attempt}/${maxRetries} 次重试...`;
            console.warn(retryMsg);
            if (onRetry) {
              try { onRetry(retryMsg); } catch (e) {}
            }
            await waitBeforeRetry();
            continue;
          } else {
            throw new Error(`[NovelAI Network Error] 网络连接失败，已重试 ${maxRetries} 次均失败: ${fetchErr.message}`);
          }
        }

        // 处理 429 错误并进行重试
        if (res.status === 429) {
          const cooldownState = globalCooldownManager.record429();
          if (attempt < maxRetries) {
            attempt++;
            const retryMsg = `[NAI Client] NovelAI 返回 429 (连续 ${cooldownState.consecutive429} 次)，将在 ${cooldownState.cooldownSeconds} 秒后进行第 ${attempt}/${maxRetries} 次重试${cooldownState.mode === 'degraded' ? '；已降级到固定 35 秒间隔' : ''}...`;
            console.warn(retryMsg);
            if (onRetry) {
              try { onRetry(retryMsg); } catch (e) {}
            }
            // 开启冷却锁确保其他并发请求在重试期间也进行排队
            await waitBeforeRetry();
            continue;
          } else {
            throw new Error(`[NovelAI 429] 频率限制，已重试 ${maxRetries} 次均失败，停止工作流。`);
          }
        }

        if (res.status !== 200 && res.status !== 201) {
          globalCooldownManager.recordNon429Failure();
          const errorText = await res.text();
          let message = errorText;
          try {
            const errObj = JSON.parse(errorText);
            message = errObj.message || message;
          } catch {}

          // 识别特定 NAI 限制错
          if (NOVELAI_TRIAL_RECAPTCHA_PATTERN.test(message)) {
            throw new Error(`[NovelAI 401] 试用限流或未检测到可用 Token。请检查您的 API Key (pst- 开头) 是否配置正确。`);
          }
          if (NOVELAI_ACCESS_DENIED_PATTERN.test(message)) {
            throw new Error(`[NovelAI 403] 拒绝访问。请检查 API Key 的 IP 白名单配置。`);
          }

          throw new Error(`[NovelAI ${res.status}] ${message}`);
        }

        // 5. 提取响应内容（ArrayBuffer 二进制流）
        let buffer;
        try {
          buffer = await res.arrayBuffer();
        } catch (streamErr) {
          globalCooldownManager.recordNon429Failure();
          if (attempt < maxRetries && isRetryableStreamError(streamErr)) {
            attempt++;
            const delaySeconds = globalCooldownManager.cooldownSeconds;
            const retryMsg = `[NAI Client] 响应体读取失败 (${streamErr.message})，将在 ${delaySeconds} 秒后进行第 ${attempt}/${maxRetries} 次重试...`;
            console.warn(retryMsg);
            if (onRetry) {
              try { onRetry(retryMsg); } catch (e) {}
            }
            await waitBeforeRetry();
            continue;
          }
          throw streamErr;
        }
        const bytes = new Uint8Array(buffer);

        // 解析 ZIP 包，获取首张图片
        const imageFile = extractFirstImageFromZip(bytes);
        if (!imageFile) {
          // 兼容兜底：如果不是 ZIP 但直接是 PNG 字节
          if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
            const mimeType = "image/png";
            globalCooldownManager.recordSuccess();
            return {
              imageBytes: bytes,
              dataUrl: uint8ArrayToDataUrl(bytes, mimeType),
              mimeType
            };
          }
          throw new Error("无法从 NovelAI 响应中提取图片，解压 ZIP 失败且不是裸图片字节。");
        }

        const mimeType = detectImageMimeType(imageFile.fileName);
        globalCooldownManager.recordSuccess();
        return {
          imageBytes: imageFile.imageBytes,
          dataUrl: uint8ArrayToDataUrl(imageFile.imageBytes, mimeType),
          mimeType,
          fileName: imageFile.fileName
        };
      }

    } catch (e) {
      console.error("[NAI Client] 生图网络错误:", e);
      throw e;
    }
  }
}
