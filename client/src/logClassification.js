export function isNaiLogMessage(text = '') {
  const message = String(text);

  if (/\[LLM\]|\[Pipeline LLM\]|高级参数生成|参数生成失败|Prompt 已就绪/i.test(message)) {
    return false;
  }

  return /\[NAI\]|\[Pipeline NAI\]|NAI 生图|NAI 接口|NovelAI|插图已存盘|生图成功|开始生图中|重绘队列|仅 NAI|cooldown|冷却锁/i.test(message);
}
