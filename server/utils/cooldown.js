/**
 * 35秒全局防抖冷却锁管理器
 */
export class CooldownManager {
  constructor(cooldownSeconds = 35) {
    this.cooldownSeconds = cooldownSeconds;
    this.lastGenerationTime = 0; // 上次生图完成的时间戳（毫秒）
    this.timer = null;
    this.listeners = new Set();
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
    for (const listener of this.listeners) {
      try {
        listener(remaining);
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
    const remaining = this.cooldownSeconds - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * 启动冷却锁（通常在开始发送 API 请求时调用，或者在响应成功返回后调用）
   * 建议在开始请求前更新时间戳以防并发，在请求返回后再刷新一遍
   */
  startCooldown() {
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
  async waitForCooldown() {
    const remaining = this.getRemainingSeconds();
    if (remaining > 0) {
      const waitMs = remaining * 1000;
      console.log(`[Cooldown] 需要等待冷却锁，剩余时间: ${remaining.toFixed(1)} 秒...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
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
export const globalCooldownManager = new CooldownManager(35);
