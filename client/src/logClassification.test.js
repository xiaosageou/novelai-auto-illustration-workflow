import test from 'node:test';
import assert from 'node:assert/strict';

import { isNaiLogMessage } from './logClassification.js';

test('NAI log classification does not capture LLM parameter failures', () => {
  assert.equal(
    isNaiLogMessage('[LLM] 第 2/3 次参数生成失败，优先重试（下一次使用精简上下文）'),
    false
  );
  assert.equal(isNaiLogMessage('  [场景 1] 高级参数生成完成 → orientation=portrait'), false);
  assert.equal(isNaiLogMessage('  [场景 1] Prompt 已就绪并持久化，等待 NAI 生图队列。'), false);
  assert.equal(isNaiLogMessage('❌ 章节「第一章」[场景 1/2] LLM Prompt 生成失败！'), false);
});

test('NAI log classification keeps NAI-specific progress in the NAI pane', () => {
  assert.equal(isNaiLogMessage('  [场景 1] [NAI] 开始生图 → prompt...'), true);
  assert.equal(isNaiLogMessage('[Pipeline NAI] 章节「第一章」所有多图配图已锁定。'), true);
  assert.equal(isNaiLogMessage('⏳ 章节「第一章」[场景 1/2] 开始生图中...'), true);
  assert.equal(isNaiLogMessage('❌ 章节「第一章」[场景 1/2] NAI 生图失败！'), true);
  assert.equal(isNaiLogMessage('⏱️ NAI 接口进入 15s 冷却，等待锁释放...'), true);
});
