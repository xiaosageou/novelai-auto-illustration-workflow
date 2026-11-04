import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMConnectionPool, slotToConnection, DEFAULT_POOL_COOLDOWN_MS } from '../utils/llm-pool.js';
import { LLMExtractor } from '../services/llm-extractor.js';
import { resolveTaskLlmPool, PipelineManager } from '../services/pipeline-manager.js';

const preset = (id, model, extra = {}) => ({
  id,
  slotKey: `preset:${id}`,
  name: `P${id}`,
  url: `https://api-${id}.example.com/v1`,
  key: `sk-${id}`,
  model,
  rateLimitEnabled: true,
  rateLimitRpm: 3,
  poolEnabled: true,
  ...extra
});

test('5 并发 3 槽位：按最少在飞均匀摊开（2/2/1），不会一口气压在第一个槽', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b'), preset('c', 'model-c')]);
  assert.equal(pool.size, 3);
  assert.equal(pool.isUsable, true);

  const leases = [];
  for (let i = 0; i < 5; i++) leases.push(pool.acquire());

  const counts = {};
  for (const lease of leases) counts[lease.key] = (counts[lease.key] || 0) + 1;
  const values = Object.values(counts).sort((x, y) => y - x);
  assert.deepEqual(values, [2, 2, 1]);

  for (const lease of leases) lease.release();
  assert.ok(pool.stats().slots.every(slot => slot.inflight === 0));

  // 归还后再领：served 累计继续增长，分配仍在轮转
  const again = pool.acquire();
  assert.ok(again);
  const totalServed = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const servedSum = pool.stats().slots.reduce((sum, slot) => sum + slot.served, 0);
  assert.equal(servedSum, totalServed + 1);
  again.release();
});

test('单槽位时不启用并发分摊', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a')]);
  assert.equal(pool.size, 1);
  assert.equal(pool.isUsable, false);
  assert.equal(pool.stats().enabled, false);
});

test('429 后 penalize 冻结该槽，hasOtherSlot 立刻指向其它模型', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')], { cooldownMs: 30000 });
  const lease = pool.acquire();
  const frozenKey = lease.key;
  lease.penalize();

  const stats = pool.stats();
  const frozen = stats.slots.find(slot => slot.key === frozenKey);
  assert.ok(frozen.coolingForMs > 0, '被 penalize 的槽位应处于冷却');

  assert.equal(pool.hasOtherSlot([frozenKey]), true);
  const next = pool.acquire({ excludeKeys: [frozenKey] });
  assert.ok(next, '应能取到未冷却的另一个槽位');
  assert.notEqual(next.key, frozenKey);
  assert.equal(pool.stats().slots.filter(slot => slot.coolingForMs > 0).length, 1);
  next.release();
});

test('全部槽位冷却时 acquire 返回 null，并给出等待时长', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')], { cooldownMs: 5000 });
  pool.slots.forEach(slot => { slot.cooldownUntil = Date.now() + 5000; });
  assert.equal(pool.acquire(), null);
  assert.ok(pool.nextAvailableDelayMs() > 0);
  assert.equal(pool.nextAvailableDelayMs() <= 5000, true);
});

test('setConnections 热更新保留同名槽位的冷却与统计', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')]);
  const lease = pool.acquire();
  const key = lease.key;
  lease.penalize(60000);

  const before = pool.stats().slots.find(slot => slot.key === key);
  assert.ok(before.coolingForMs > 0);

  pool.setConnections([preset('a', 'model-a'), preset('b', 'model-b'), preset('c', 'model-c')]);
  const after = pool.stats().slots.find(slot => slot.key === key);
  assert.equal(after.coolingForMs > 0, true);
  assert.equal(after.served, 1);
  assert.equal(pool.size, 3);
});

test('slotToConnection 输出与原 failover 同形的连接描述', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a', { reasoningEffort: 'low' })]);
  const connection = slotToConnection(pool.slots[0]);
  assert.equal(connection.url, 'https://api-a.example.com/v1/chat/completions');
  assert.equal(connection.headers.Authorization, 'Bearer sk-a');
  assert.equal(connection.model, 'model-a');
  assert.equal(connection.reasoningEffort, 'low');
  assert.deepEqual(connection.rateLimit, { enabled: true, rpm: 3, key: 'preset:a' });
});

test('默认冷却阈值不为 0，避免刚冷却就立刻重投', () => {
  assert.equal(DEFAULT_POOL_COOLDOWN_MS >= 3000, true);
});

test('resolveTaskLlmPool：只有勾选「参与并发」的预设入池，当前任务预设永远在池首', () => {
  const config = {
    llm_api_presets: [
      preset('a', 'model-a', { poolEnabled: false }),
      preset('b', 'model-b', { poolEnabled: true }),
      preset('c', 'model-c', { poolEnabled: true })
    ],
    llm_scene_preset_id: 'b',
    llm_scene_model: 'model-b-override',
    llm_multi_model_enabled: true
  };
  const pool = resolveTaskLlmPool(config, 'scene');
  assert.deepEqual(pool.map(item => item.id), ['b', 'c']);
  assert.equal(pool[0].model, 'model-b-override', '当前预设可带任务级模型覆盖');
  assert.equal(pool[0].rateLimit.key, 'preset:b');
});

test('resolveTaskLlmPool：只勾选一个时不启用；关掉全局开关也不启用；trim 任务始终单路', () => {
  const one = {
    llm_api_presets: [preset('a', 'model-a', { poolEnabled: true }), preset('b', 'model-b', { poolEnabled: false })],
    llm_scene_preset_id: 'a'
  };
  assert.deepEqual(resolveTaskLlmPool(one, 'scene'), []);

  const disabled = {
    ...one,
    llm_api_presets: [preset('a', 'model-a'), preset('b', 'model-b')],
    llm_multi_model_enabled: false
  };
  assert.deepEqual(resolveTaskLlmPool(disabled, 'scene'), []);

  const trim = {
    llm_api_presets: [preset('a', 'model-a'), preset('b', 'model-b')]
  };
  assert.deepEqual(resolveTaskLlmPool(trim, 'trim'), []);
});

test('旧「失败回退」已停用：extractor 不再构建 failover 控制器，业务失败也不换模型', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')]);
  const extractor = new LLMExtractor({
    baseUrl: 'https://api-a.example.com/v1',
    apiKey: 'sk-a',
    failoverChain: [{ id: 'b', baseUrl: 'https://api-b.example.com/v1', apiKey: 'sk-b', model: 'model-b' }],
    failoverEnabled: true,
    connectionPool: pool
  });

  assert.equal(extractor.buildFailoverController(), null);
  assert.equal(extractor._switchOnBusinessFailure('boom'), false);
  assert.equal(extractor.failoverEnabled, false);
  assert.equal(extractor.failoverChain.length, 0);

  const info = extractor.getActiveConnectionInfo();
  assert.equal(info.failoverEnabled, false);
  assert.equal(info.pool.size, 2);
  assert.equal(info.pool.enabled, true);
});

test('运行中取消勾选：池对象原地热更新，正在跑的旧 extractor 也不再选到被取消的模型', () => {
  const baseConfig = {
    llm_api_presets: [
      preset('a', 'model-a'),
      preset('b', 'model-b'),
      preset('c', 'model-c')
    ],
    llm_scene_preset_id: 'a'
  };
  const pipeline = new PipelineManager(baseConfig);
  const runningExtractor = pipeline.sceneExtractor;
  assert.equal(runningExtractor.connectionPool.slots.length, 3);

  // 运行途中取消 b 的「参与并发」
  pipeline.updateConfig({
    ...baseConfig,
    llm_api_presets: baseConfig.llm_api_presets.map(item => (
      item.id === 'b' ? { ...item, poolEnabled: false } : item
    ))
  });

  // 旧实例仍在使用中，但它的池已被原地摘掉 b
  assert.equal(runningExtractor.connectionPool, pipeline.sceneExtractor.connectionPool, '新旧实例应共享同一个池对象');
  const keys = runningExtractor.connectionPool.slots.map(slot => slot.key);
  assert.equal(keys.includes('preset:b'), false, '被取消的模型必须立刻退出槽位');
  assert.deepEqual(keys.sort(), ['preset:a', 'preset:c']);

  // 之后从旧实例取槽，永远拿不到被取消的模型
  for (let i = 0; i < 6; i++) {
    const lease = runningExtractor.connectionPool.acquire();
    assert.ok(lease);
    assert.notEqual(lease.key, 'preset:b');
    lease.release();
  }
});

test('运行中关掉勾选到只剩一个槽位：池清空，旧实例回落到单连接', () => {
  const baseConfig = {
    llm_api_presets: [preset('a', 'model-a'), preset('b', 'model-b')],
    llm_scene_preset_id: 'a'
  };
  const pipeline = new PipelineManager(baseConfig);
  const runningExtractor = pipeline.sceneExtractor;
  assert.equal(runningExtractor.connectionPool.slots.length, 2);

  pipeline.updateConfig({
    ...baseConfig,
    llm_api_presets: baseConfig.llm_api_presets.map(item => (
      item.id === 'b' ? { ...item, poolEnabled: false } : item
    ))
  });

  assert.equal(runningExtractor.connectionPool.slots.length, 0, '旧实例的池应被清空');
  assert.equal(pipeline.sceneExtractor.connectionPool, null, '新实例退回单连接');
});

test('业务层失败换模型：标记失败的槽位并让它短暂降级，下一次请求落到别的模型', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')]);
  const extractor = new LLMExtractor({
    baseUrl: 'https://api-a.example.com/v1',
    apiKey: 'sk-a',
    connectionPool: pool
  });

  // A 返回 200 但内容不合合约 → 换模型
  assert.equal(extractor._switchOnBusinessFailure('场景提炼失败: JSON 解析失败', 'preset:a'), true);
  assert.deepEqual(pool.businessPenalizedKeys(), ['preset:a']);

  // 下一发请求不会再落到 A
  const lease = pool.acquire();
  assert.equal(lease.key, 'preset:b');
  lease.release();

  // B 也失败 → 池里轮完一圈，不再换模型（返回 false，交给原语义重试/报错）
  assert.equal(extractor._switchOnBusinessFailure('场景提炼失败: 数量不符', 'preset:b'), false);

  // A 这轮写对了 → 立刻解除惩罚，重新参与分摊
  pool.clearBusinessFailure('preset:a');
  assert.deepEqual(pool.businessPenalizedKeys(), []);
});

test('业务失败不传槽位时不乱换模型；单槽位也不换', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')]);
  const extractor = new LLMExtractor({ baseUrl: 'https://api-a.example.com/v1', apiKey: 'sk-a', connectionPool: pool });
  assert.equal(extractor._switchOnBusinessFailure('未知失败'), false);
  assert.deepEqual(pool.businessPenalizedKeys(), []);

  const single = new LLMConnectionPool([preset('a', 'model-a')]);
  const singleExtractor = new LLMExtractor({ baseUrl: 'https://api-a.example.com/v1', apiKey: 'sk-a', connectionPool: single });
  assert.equal(singleExtractor._switchOnBusinessFailure('失败', 'preset:a'), false);
});

test('全部槽位都有业务惩罚时，池仍能取回使用（软惩罚不锁死流水线）', () => {
  const pool = new LLMConnectionPool([preset('a', 'model-a'), preset('b', 'model-b')]);
  pool.markBusinessFailure('preset:a');
  pool.markBusinessFailure('preset:b');
  assert.equal(pool.businessPenalizedKeys().length, 2);

  const lease = pool.acquire();
  assert.ok(lease, '全标记时应回落挑选，不能返回 null 让整条流水线干等');
  lease.release();
});
