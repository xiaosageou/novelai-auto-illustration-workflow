import test from 'node:test';
import assert from 'node:assert/strict';
import { CooldownManager } from '../utils/cooldown.js';

// ── 429 冷却策略：一次 429 立即降级到 35s，30 分钟后自动恢复 ─────────────────

test('cooldown: 一次 429 立即降级到 35s，不再需要连续三次', () => {
  const cooldown = new CooldownManager(15, 35);

  cooldown.record429();
  const state = cooldown.getState();
  assert.equal(state.mode, 'degraded');
  assert.equal(state.cooldownSeconds, 35);
  // 降级窗口 30 分钟
  assert.ok(state.degradedRemainingSeconds > 29 * 60, '降级窗口约 30 分钟');
});

test('cooldown: 429 前本就快于 35s 才降级，本就慢于 35s 则不降', () => {
  const fast = new CooldownManager(15, 35);
  fast.record429();
  assert.equal(fast.getState().mode, 'degraded');

  // base=40 已经比降级档更慢，429 无需再降级
  const slow = new CooldownManager(40, 35);
  slow.record429();
  assert.equal(slow.getState().mode, 'normal');
  assert.equal(slow.getState().cooldownSeconds, 40);
});

test('cooldown: 降级窗口内再次 429 会刷新 30 分钟计时', () => {
  const cooldown = new CooldownManager(15, 35);
  cooldown.record429();
  const firstWindow = cooldown.getState().degradedUntil;

  // 手动把窗口拨到快到期，再撞一次 429 应重新计时
  cooldown.degradedUntil = Date.now() + 1000;
  cooldown.record429();
  assert.ok(cooldown.getState().degradedUntil > firstWindow - 1000);
  assert.ok(cooldown.getState().degradedRemainingSeconds > 29 * 60);
  assert.equal(cooldown.getState().mode, 'degraded');
});

test('cooldown: 降级窗口到期后自动切回原间隔', () => {
  const cooldown = new CooldownManager(15, 35);
  cooldown.record429();
  assert.equal(cooldown.getState().mode, 'degraded');

  // 模拟 30 分钟窗口过去
  cooldown.degradedUntil = Date.now() - 1;
  const state = cooldown.getState();
  assert.equal(state.mode, 'normal');
  assert.equal(state.cooldownSeconds, 15);
  assert.equal(state.degradedRemainingSeconds, 0);
});

test('cooldown: 成功不再按次数提前恢复，恢复由时间窗口驱动', () => {
  const cooldown = new CooldownManager(15, 35);
  cooldown.record429();
  assert.equal(cooldown.getState().mode, 'degraded');

  // 连续成功多次也不会提前恢复（旧逻辑 5 次成功即恢复）
  for (let i = 0; i < 10; i++) cooldown.recordSuccess();
  assert.equal(cooldown.getState().mode, 'degraded');

  // 只有时间窗口过去才恢复
  cooldown.degradedUntil = Date.now() - 1;
  cooldown.recordSuccess();
  assert.equal(cooldown.getState().mode, 'normal');
});

test('configured base cooldown is clamped and does not change fixed degraded interval', () => {
  const cooldown = new CooldownManager(15, 35);
  cooldown.setBaseCooldownSeconds(8);
  assert.equal(cooldown.getState().cooldownSeconds, 8);

  cooldown.record429();
  cooldown.record429();
  cooldown.record429();
  cooldown.setBaseCooldownSeconds(12);
  assert.equal(cooldown.getState().baseCooldownSeconds, 12);
  assert.equal(cooldown.getState().cooldownSeconds, 35);
});
