export class CooldownManager {
  constructor(baseCooldownSeconds = 15, degradedCooldownSeconds = 35) {
    this.baseCooldownSeconds = this._normalizeBaseCooldown(baseCooldownSeconds);
    this.degradedCooldownSeconds = degradedCooldownSeconds;
    this.cooldownSeconds = this.baseCooldownSeconds;
    this.activeCooldownSeconds = this.cooldownSeconds;
    this.mode = 'normal';
    this.consecutive429 = 0;
    this.degradedSuccesses = 0;
    // 429 降级窗口：一次 429 就把间隔抬到降级档，并保持半小时。
    // 窗口内再撞 429 就重新计时；到期自动切回用户原本设置的间隔。
    this.degradedDurationMs = 30 * 60 * 1000;
    this.degradedUntil = 0;
    this.lastGenerationTime = 0; // 上次生图完成的时间戳（毫秒）
    this.timer = null;
    this.listeners = new Set();
  }

  _normalizeBaseCooldown(seconds) {
    const value = Number(seconds);
    return Number.isFinite(value) ? Math.max(1, Math.min(120, value)) : 15;
  }

  setBaseCooldownSeconds(seconds) {
    this.baseCooldownSeconds = this._normalizeBaseCooldown(seconds);
    if (this.mode === 'normal') {
      this.cooldownSeconds = this.baseCooldownSeconds;
    }
    this._emit(this.getRemainingSeconds());
  }

  record429() {
    this.consecutive429 += 1;
    if (this.mode === 'degraded') {
      // 已在降级档：刷新半小时窗口，避免刚恢复就立刻又撞 429
      this.degradedUntil = Date.now() + this.degradedDurationMs;
      this.degradedSuccesses = 0;
    } else if (this.cooldownSeconds < this.degradedCooldownSeconds) {
      // 间隔本来就不低于降级档时无需再降，只处理「比降级档更快」的情况
      this._enterDegraded();
    }
    this._emit(this.getRemainingSeconds());
    return this.getState();
  }

  /** 进入 429 降级：把出图间隔抬到降级档并开半小时窗口 */
  _enterDegraded() {
    this.mode = 'degraded';
    this.cooldownSeconds = this.degradedCooldownSeconds;
    this.degradedSuccesses = 0;
    this.degradedUntil = Date.now() + this.degradedDurationMs;
    console.warn(
      `[Cooldown] 检测到 429，出图间隔 ${this.baseCooldownSeconds}s → ${this.degradedCooldownSeconds}s，`
      + `${Math.round(this.degradedDurationMs / 60000)} 分钟后自动恢复`
    );
  }

  /** 降级窗口到期则切回原间隔（惰性检查，供 getState / tick 轮询时调用） */
  _checkDegradedExpiry() {
    if (this.mode !== 'degraded') return;
    if (Date.now() < this.degradedUntil) return;
    this.mode = 'normal';
    this.cooldownSeconds = this.baseCooldownSeconds;
    this.consecutive429 = 0;
    this.degradedSuccesses = 0;
    this.degradedUntil = 0;
    console.log(`[Cooldown] 429 降级窗口结束，出图间隔恢复为 ${this.baseCooldownSeconds}s`);
  }

  recordSuccess() {
    if (this.mode === 'degraded') {
      // 不再按成功次数提前恢复：降级窗口由时间驱动，这里只做计数展示
      this.degradedSuccesses += 1;
      this._checkDegradedExpiry();
    } else {
      this.consecutive429 = 0;
    }
    this._emit(this.getRemainingSeconds());
    return this.getState();
  }

  recordNon429Failure() {
    if (this.mode === 'normal') {
      this.consecutive429 = 0;
    } else {
      this.degradedSuccesses = 0;
    }
  }

  getState() {
    // 惰性到期检查：即使没有新请求，前端轮询时也能及时切回原间隔
    this._checkDegradedExpiry();
    return {
      remaining: this.getRemainingSeconds(),
      activeCooldownSeconds: this.activeCooldownSeconds,
      cooldownSeconds: this.cooldownSeconds,
      baseCooldownSeconds: this.baseCooldownSeconds,
      degradedCooldownSeconds: this.degradedCooldownSeconds,
      mode: this.mode,
      consecutive429: this.consecutive429,
      degradedSuccesses: this.degradedSuccesses,
      degradedUntil: this.degradedUntil,
      degradedRemainingSeconds: this.mode === 'degraded'
        ? Math.max(0, Math.round((this.degradedUntil - Date.now()) / 1000))
        : 0,
      degradedDurationMinutes: Math.round(this.degradedDurationMs / 60000)
    };
  }

  /**
   * 注册倒计时 Tick 监听器
   * @param {function} callback 接收剩余秒数的函数
   */
  onTick(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * 触发所有监听器
   */
  _emit(remaining) {
    const state = { ...this.getState(), remaining };
    for (const listener of this.listeners) {
      try {
        listener(remaining, state);
      } catch (e) {
        console.error("Cooldown tick listener error:", e);
      }
    }
  }

  /**
   * 获取当前剩余的冷却秒数
   */
  getRemainingSeconds() {
    if (this.lastGenerationTime === 0) return 0;
    const elapsed = (Date.now() - this.lastGenerationTime) / 1000;
    const remaining = this.activeCooldownSeconds - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * 启动冷却锁（通常在开始发送 API 请求时调用，或者在响应成功返回后调用）
   * 建议在开始请求前更新时间戳以防并发，在请求返回后再刷新一遍
   */
  startCooldown(seconds = this.cooldownSeconds) {
    this.activeCooldownSeconds = Math.max(0, Number(seconds) || 0);
    this.lastGenerationTime = Date.now();
    this._startTickTimer();
  }

  /**
   * 开启一个 100ms 间隔的 Tick 定时器来更新 UI
   */
  _startTickTimer() {
    if (this.timer) clearInterval(this.timer);
    
    this.timer = setInterval(() => {
      const remaining = this.getRemainingSeconds();
      this._emit(remaining);
      
      if (remaining <= 0) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 100);
  }

  /**
   * 等待冷却完成的核心方法
   * 如果剩余冷却时间 > 0，则异步等待直到满足冷却限制
   */
  /**
   * 中断冷却计时（暂停或停止流水线时调用）
   */
  interruptCooldown() {
    this.lastGenerationTime = 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._emit(0);
  }

  /**
   * 等待冷却完成的核心方法
   * 如果剩余冷却时间 > 0，则异步等待直到满足冷却限制
   * 支持传入 signal 监听中断事件，毫秒级响应暂停
   */
  async waitForCooldown(signal = null) {
    const remaining = this.getRemainingSeconds();
    if (remaining > 0) {
      if (signal?.aborted) return;
      const waitMs = remaining * 1000;
      console.log(`[Cooldown] 需要等待冷却锁，剩余时间: ${remaining.toFixed(1)} 秒...`);
      await new Promise((resolve) => {
        let timer = null;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      if (signal?.aborted) return;
    }
    // 冷却结束后重置或开启冷却锁
    this.startCooldown();
  }

  /**
   * 销毁定时器
   */
  destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }
}

// 导出全局单例，保证整个应用共享一个冷却锁
export const globalCooldownManager = new CooldownManager(15, 35);
