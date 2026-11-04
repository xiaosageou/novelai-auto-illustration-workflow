/**
 * 多模型并发槽位池（LLM Connection Pool）。
 *
 * 目的：把「一路并发打一个模型」改成「多路并发摊到几个模型」。
 *  - 旧机制（失败回退 failover）是请求已经失败之后才永久切到下一个连接：
 *    模型 A 已吃掉全部 429，才轮到 B，前期的等待与重试成本已经付掉了。
 *  - 本池是请求发出之前就分流：每个并发 worker 领一个槽位，
 *    槽位带自己的 RPM 限流器 key，所以不同供应商互不排队，
 *    单模型的每秒请求数被按槽位数摊薄，429 显著减少。
 *
 * 分配策略：可用槽位里挑「在飞请求数最少」的那个，同分时按游标轮转，
 * 保证 5 并发 / 3 槽 = 2/2/1 这种均匀分布，且不会一直压在第一个槽上。
 *
 * 槽位数据结构（由 pipeline-manager 的 resolveTaskLlmPool 生产）：
 *   {
 *     key, id, label, baseUrl, apiKey, model, reasoningEffort,
 *     rateLimit: { enabled, rpm, key }
 *   }
 */

export const DEFAULT_POOL_COOLDOWN_MS = 20000;

export class LLMConnectionPool {
  /**
   * @param {Array<object>} connections 槽位连接列表
   * @param {{ cooldownMs?: number, hopOn429?: boolean, hopBudget?: number }} options
   */
  constructor(connections = [], { cooldownMs = DEFAULT_POOL_COOLDOWN_MS, hopOn429 = true, hopBudget = 0 } = {}) {
    this.cooldownMs = Number.isFinite(Number(cooldownMs)) && Number(cooldownMs) >= 0
      ? Number(cooldownMs)
      : DEFAULT_POOL_COOLDOWN_MS;
    this.hopOn429 = hopOn429 !== false;
    this.hopBudget = Number.isFinite(Number(hopBudget)) && Number(hopBudget) > 0 ? Math.floor(Number(hopBudget)) : 0;
    this.cursor = 0;
    this.slots = [];
    this.setConnections(connections);
  }

  /** 热更新槽位列表（配置保存时调用）；保留仍存在的槽位的冷却/统计状态 */
  setConnections(connections = []) {
    const previous = new Map(this.slots.map(slot => [slot.key, slot]));
    const seen = new Set();
    this.slots = (Array.isArray(connections) ? connections : [])
      .map(connection => {
        // 同时兼容 pipeline 的槽位结构（baseUrl）与前端预设结构（url）
        const baseUrl = String(connection?.baseUrl || connection?.url || '').trim().replace(/\/+$/, '');
        if (!baseUrl) return null;
        const model = String(connection?.model || '').trim();
        const rateLimitKey = String(connection?.rateLimit?.key || connection?.rateLimitKey || `preset:${connection?.id || baseUrl}`);
        // 槽位标识优先用预设 id；不要在 url/key 不完整时回退到 apiKey（那是密钥，不是身份）
        const key = String(connection?.slotKey || connection?.id || `${baseUrl}::${model}` || rateLimitKey);
        if (seen.has(key)) return null;
        seen.add(key);
        const old = previous.get(key);
        return {
          key,
          id: connection?.id || '',
          label: connection?.label || connection?.name || key,
          baseUrl,
          apiKey: String(connection?.apiKey || connection?.key || '').trim(),
          model,
          reasoningEffort: String(connection?.reasoningEffort || '').trim(),
          rateLimit: {
            enabled: connection?.rateLimit?.enabled !== false,
            rpm: Number(connection?.rateLimit?.rpm ?? connection?.rateLimitRpm) || 3,
            key: rateLimitKey
          },
          inflight: old?.inflight || 0,
          served: old?.served || 0,
          cooldownUntil: old?.cooldownUntil || 0,
          lastUsedAt: old?.lastUsedAt || 0
        };
      })
      .filter(Boolean);
    if (this.cursor >= this.slots.length) this.cursor = 0;
    return this.slots;
  }

  get size() {
    return this.slots.length;
  }

  /** 至少两个槽位才值得启用并发分摊 */
  get isUsable() {
    return this.slots.length >= 2;
  }

  /**
   * 领一个槽位。返回 null 表示当前没有可用槽（全在冷却或被 exclude 排除）。
   * 调用方拿到 lease 后要自己 await 该槽的限流器，最后必须 release()。
   *
   * @param {{ excludeKeys?: string[] }} options
   */
  acquire({ excludeKeys = [] } = {}) {
    if (!this.slots.length) return null;
    const excluded = new Set(Array.isArray(excludeKeys) ? excludeKeys : []);
    const now = Date.now();
    const available = [];
    for (let i = 0; i < this.slots.length; i++) {
      const index = (this.cursor + i) % this.slots.length;
      const slot = this.slots[index];
      if (excluded.has(slot.key)) continue;
      if (slot.cooldownUntil > now) continue;
      available.push({ slot, index });
    }
    if (!available.length) return null;

    const minInflight = Math.min(...available.map(item => item.slot.inflight));
    const chosen = available.find(item => item.slot.inflight === minInflight);
    chosen.slot.inflight += 1;
    chosen.slot.served += 1;
    chosen.slot.lastUsedAt = now;
    this.cursor = (chosen.index + 1) % this.slots.length;
    return this._createLease(chosen.slot);
  }

  _createLease(slot) {
    let released = false;
    const self = this;
    return {
      slot,
      get key() {
        return slot.key;
      },
      /** 正常归还：只减在飞计数 */
      release() {
        if (released) return;
        released = true;
        slot.inflight = Math.max(0, slot.inflight - 1);
      },
      /** 触发 429/5xx：先冻结该槽一段时间，再归还 */
      penalize(ms = self.cooldownMs) {
        const penalty = Number.isFinite(Number(ms)) && Number(ms) >= 0 ? Number(ms) : self.cooldownMs;
        slot.cooldownUntil = Math.max(slot.cooldownUntil, Date.now() + penalty);
        if (!released) {
          released = true;
          slot.inflight = Math.max(0, slot.inflight - 1);
        }
      }
    };
  }

  /** 除指定槽位外是否还有可立刻使用的槽 */
  hasOtherSlot(excludeKeys = []) {
    const excluded = new Set(Array.isArray(excludeKeys) ? excludeKeys : []);
    const now = Date.now();
    return this.slots.some(slot => !excluded.has(slot.key) && slot.cooldownUntil <= now);
  }

  /** 全部槽位冷却时，还需要等多久（毫秒）；没有槽位返回 0 */
  nextAvailableDelayMs() {
    if (!this.slots.length) return 0;
    const now = Date.now();
    const soonest = Math.min(...this.slots.map(slot => slot.cooldownUntil));
    return Math.max(0, soonest - now);
  }

  /** 槽位连接是否与给定列表一致（用于配置热更新时复用旧池，保留冷却状态） */
  matches(connections = []) {
    const next = new LLMConnectionPool(connections).slots;
    if (next.length !== this.slots.length) return false;
    return next.every((slot, index) => {
      const current = this.slots[index];
      return slot.key === current.key && slot.baseUrl === current.baseUrl && slot.model === current.model;
    });
  }

  /** 槽位快照，给前端展示「现在哪几个模型在分摊」 */
  stats() {
    const now = Date.now();
    return {
      enabled: this.isUsable,
      size: this.slots.length,
      hopOn429: this.hopOn429,
      slots: this.slots.map(slot => ({
        key: slot.key,
        label: slot.label,
        model: slot.model,
        inflight: slot.inflight,
        served: slot.served,
        coolingForMs: Math.max(0, slot.cooldownUntil - now)
      }))
    };
  }
}

/**
 * 把池子里的槽位转成 postChatCompletionWith429Retry 认识的连接描述，
 * 与旧 failover 的 next() 返回结构保持同形，便于复用同一段应用逻辑。
 */
export function slotToConnection(slot) {
  if (!slot) return null;
  return {
    url: `${slot.baseUrl}/chat/completions`,
    headers: slot.apiKey
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${slot.apiKey}` }
      : { 'Content-Type': 'application/json' },
    rateLimit: slot.rateLimit,
    model: slot.model || undefined,
    reasoningEffort: slot.reasoningEffort || '',
    label: slot.label,
    key: slot.key
  };
}
