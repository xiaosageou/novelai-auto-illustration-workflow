/**
 * LLM 失败重试参数。
 *
 * 两条独立的退避链路，都可以在前端「全局配置」里调：
 *   - maxRetries     ：业务重试（JSON 解析失败 / 字段不合合约 / 数量不符 / 空返回）
 *   - max429Retries  ：HTTP 429 与 5xx 的传输层重试
 *
 * 历史：这些次数原本散落在 llm-extractor / pipeline-manager / comic-text-generator
 * 里写死成 3 和 5，代理不稳的用户没法调大，代理正常时又省钱调不小。
 */

export const DEFAULT_LLM_MAX_RETRIES = 3;
export const DEFAULT_LLM_429_MAX_RETRIES = 5;

/** 上限只是防手滑，不是硬技术限制 */
export const LLM_MAX_RETRIES_CEILING = 10;
export const LLM_429_MAX_RETRIES_CEILING = 20;

/**
 * 把配置里的重试次数归一化成可用的整数。
 * 空值 / 非数字 / 越界都回落到默认值或夹到区间内。
 * @param {object} config
 * @returns {{ maxRetries: number, max429Retries: number }}
 */
export function resolveLlmRetryLimits(config = {}) {
  return {
    maxRetries: clampLlmRetries(config?.llm_max_retries, DEFAULT_LLM_MAX_RETRIES, 1, LLM_MAX_RETRIES_CEILING),
    max429Retries: clampLlmRetries(config?.llm_429_max_retries, DEFAULT_LLM_429_MAX_RETRIES, 0, LLM_429_MAX_RETRIES_CEILING)
  };
}

/**
 * 单个参数归一化。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampLlmRetries(value, fallback = DEFAULT_LLM_MAX_RETRIES, min = 1, max = LLM_MAX_RETRIES_CEILING) {
  if (value === null || value === undefined || value === '') return fallback;
  // 配置可能来自 JSON 手改：数组/对象/布尔一律当作无效值，避免 Number([]) === 0 这类奇葩转换
  if (typeof value === 'object' || typeof value === 'boolean') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const int = Math.floor(num);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}
