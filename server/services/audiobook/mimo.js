/**
 * MiMo V2.5 TTS 客户端（OpenAI 兼容 /chat/completions）。
 *
 *   POST {base}/chat/completions
 *   { model:'mimo-v2.5-tts',
 *     messages:[{role:'user',content:风格指令?},{role:'assistant',content:待合成文本}],
 *     audio:{format:'wav', voice:'白桦'} }
 *   → choices[0].message.audio.data = base64(WAV)
 *
 * 失败按「指数退避 + 抖动」重试，429 额外加长等待；支持 AbortSignal 停止。
 */

export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const DEFAULT_MODEL = 'mimo-v2.5-tts';

/**
 * 专用 HTTP 客户端：默认直连，不受全局 ProxyAgent 影响。
 *
 * 主程序为了访问 NovelAI / LLM 会 setGlobalDispatcher(ProxyAgent)，那会把 MiMo
 * 请求也塞进代理导致 fetch failed。这里用 undici 自己的 fetch + 独立 Agent；
 * Node 内置 fetch 与 npm undici 的 Agent 版本不匹配（UND_ERR_INVALID_ARG），
 * 所以必须成对使用同一个包里的 fetch。需要代理时用 MIMO_PROXY 显式指定。
 */
let httpPromise = null;

async function getHttpClient() {
  if (!httpPromise) {
    httpPromise = (async () => {
      try {
        const undici = await import('undici');
        if (typeof undici.fetch === 'function') {
          const proxy = String(process.env.MIMO_PROXY || '').trim();
          const dispatcher = proxy
            ? new undici.ProxyAgent(proxy)
            : new undici.Agent({ connect: { timeout: 30000 }, keepAliveTimeout: 30000 });
          return { fetch: undici.fetch, dispatcher };
        }
      } catch { /* 降级到内置 fetch */ }
      return { fetch: globalThis.fetch, dispatcher: undefined };
    })();
  }
  return httpPromise;
}

export const PRESET_VOICES = [
  { id: '白桦', name: '白桦', lang: 'zh', gender: '男', desc: '沉稳磁性 · 玄幻 / 历史 / 正剧' },
  { id: '苏打', name: '苏打', lang: 'zh', gender: '男', desc: '清朗阳光 · 都市 / 青春 / 轻喜剧' },
  { id: '茉莉', name: '茉莉', lang: 'zh', gender: '女', desc: '温柔知性 · 言情 / 现代' },
  { id: '冰糖', name: '冰糖', lang: 'zh', gender: '女', desc: '甜美活泼 · 校园 / 轻小说' },
  { id: 'Mia', name: 'Mia', lang: 'en', gender: 'female', desc: 'Lively girl · English' },
  { id: 'Chloe', name: 'Chloe', lang: 'en', gender: 'female', desc: 'Sweet dreamy · English' },
  { id: 'Milo', name: 'Milo', lang: 'en', gender: 'male', desc: 'Sunny boy · English' },
  { id: 'Dean', name: 'Dean', lang: 'en', gender: 'male', desc: 'Steady gentle · English' },
];

export class TtsError extends Error {
  constructor(message, { status = 0, retryable = false, cause } = {}) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MiMoClient {
  constructor(opts = {}) {
    if (!opts.apiKey) throw new TtsError('缺少 MiMo API Key');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.voice = opts.voice || '白桦';
    this.model = opts.model || DEFAULT_MODEL;
    this.context = opts.context || '';
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 180000;
    this.log = opts.log || (() => {});
    this.stats = { requests: 0, retries: 0, audioBytes: 0 };
  }

  buildMessages(text) {
    const messages = [];
    if (String(this.context || '').trim()) messages.push({ role: 'user', content: String(this.context).trim() });
    messages.push({ role: 'assistant', content: text });
    return messages;
  }

  /**
   * 合成一段文本。
   * @returns {Promise<{ wav: Buffer, usage: object|null }>}
   */
  async synthesize(text, opts = {}) {
    const payload = {
      model: this.model,
      messages: this.buildMessages(text),
      audio: { format: 'wav', voice: opts.voice || this.voice },
      stream: false,
    };

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (opts.signal?.aborted) throw new TtsError('已取消');
      try {
        const data = await this.request(payload, opts.signal);
        const b64 = data?.choices?.[0]?.message?.audio?.data;
        if (!b64) {
          throw new TtsError('响应中没有音频数据（可能触发内容审核，或文本为空）');
        }
        const wav = Buffer.from(b64, 'base64');
        if (wav.length < 44) throw new TtsError('返回音频数据不完整', { retryable: true });
        this.stats.requests += 1;
        this.stats.audioBytes += wav.length;
        return { wav, usage: data.usage || null };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof TtsError ? err.retryable : true;
        if (!retryable || attempt >= this.maxAttempts) break;
        if (opts.signal?.aborted) throw new TtsError('已取消');

        this.stats.retries += 1;
        const backoff = Math.min(30000, 800 * (2 ** (attempt - 1)));
        const wait = Math.round(backoff * (err.status === 429 ? 2.2 : 1) * (0.7 + Math.random() * 0.6));
        this.log(`合成失败（第 ${attempt} 次）：${err.message}，${(wait / 1000).toFixed(1)}s 后重试`, 'warn');
        await sleep(wait);
      }
    }
    throw lastError instanceof TtsError
      ? lastError
      : new TtsError(`合成失败：${lastError?.message || lastError}`, { cause: lastError });
  }

  async request(payload, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res;
    try {
      const http = await getHttpClient();
      res = await http.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: composite,
        ...(http.dispatcher ? { dispatcher: http.dispatcher } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new TtsError('已取消');
      const code = err?.cause?.code || err?.code || '';
      throw new TtsError(
        `网络请求失败：${err.message}${code ? `（${code}）` : ''}`,
        { retryable: true, cause: err },
      );
    }

    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 300);
      try {
        const j = JSON.parse(raw);
        detail = j.error?.message || j.message || detail;
      } catch { /* 保留原文 */ }
      const retryable = res.status === 429 || res.status >= 500;
      const hint = res.status === 401
        ? '（API Key 无效或已过期）'
        : res.status === 429 ? '（触发限流，建议降低并发）' : '';
      throw new TtsError(`HTTP ${res.status}${hint}：${detail}`, { status: res.status, retryable });
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new TtsError('返回内容不是合法 JSON', { retryable: true });
    }
  }
}

/** 用一句短文本探测 Key 是否可用（会计费，极少量） */
export async function verifyKey({ apiKey, baseUrl, voice = '白桦', signal } = {}) {
  const client = new MiMoClient({ apiKey, baseUrl, voice, maxAttempts: 1, timeoutMs: 60000 });
  const { wav } = await client.synthesize('好的。', { signal });
  return { bytes: wav.length };
}
