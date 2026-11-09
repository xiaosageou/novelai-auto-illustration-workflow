/**
 * NovelAI 生图参数护栏。
 *
 * 目的：把生图参数锁在「不额外消耗 Anlas」的免费档以内，防止手滑调高参数
 * 之后每张图都在烧点数。
 *
 * NAI 的计费口径（V4/V4.5 一致）：
 *   - steps ≤ 28 且 总像素 ≤ 1024×1024 时不额外扣点数；
 *   - 超出任一条件，单张就要按倍数消耗 Anlas。
 *
 * 因此上限取：
 *   - steps : 28
 *   - 单边 : 1216（832×1216 / 1216×832 这类竖横图是 NAI 原生支持且在免费档内）
 *   - 像素 : 1024 × 1024 = 1,048,576
 *
 * 尺寸统一对齐到 64 的倍数（NAI 的硬性要求），并且只向下取整，
 * 保证对齐之后不会反过来越过像素上限。
 */

/** 不触发额外扣点的最大步数 */
export const NAI_FREE_STEPS_MAX = 28;
/** 不触发额外扣点的最大总像素 */
export const NAI_FREE_MAX_PIXELS = 1024 * 1024;
/** 单边允许的最大边长（NAI 原生支持的 832×1216 档） */
export const NAI_FREE_MAX_SIDE = 1216;
/** NAI 的 scale 上限 */
export const NAI_SCALE_MAX = 10;
export const NAI_SCALE_MIN = 1;
/** NAI 要求宽高是 64 的倍数 */
export const NAI_SIZE_STEP = 64;

/** 向下对齐到 64 的倍数，最小 64 */
function alignTo64(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return NAI_SIZE_STEP;
  return Math.max(NAI_SIZE_STEP, Math.floor(num / NAI_SIZE_STEP) * NAI_SIZE_STEP);
}

/**
 * 步数夹取：非数字回落默认值，超过 28 一律压到 28。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function clampNaiSteps(value, fallback = NAI_FREE_STEPS_MAX) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' || typeof value === 'boolean') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(NAI_FREE_STEPS_MAX, Math.max(1, Math.floor(num)));
}

/**
 * scale 夹取：只做安全边界，不涉点数（CFG 不影响 Anlas 消耗）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function clampNaiScale(value, fallback = 5) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' || typeof value === 'boolean') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(NAI_SCALE_MAX, Math.max(NAI_SCALE_MIN, num));
}

/**
 * 尺寸夹取：等比缩放到免费档以内，并保持原始宽高比。
 *
 * 先按单边上限缩，再按总像素上限缩，最后对齐 64。
 * 对齐只向下取整，所以对齐后一定不会越过上限。
 *
 * @param {number|string} width
 * @param {number|string} height
 * @returns {{width: number, height: number, clamped: boolean}}
 */
export function clampNaiDimensions(width, height) {
  let w = Number(width);
  let h = Number(height);
  if (!Number.isFinite(w) || w <= 0) w = 1024;
  if (!Number.isFinite(h) || h <= 0) h = 1024;

  const originalW = w;
  const originalH = h;

  // 1) 单边上限
  const sideScale = Math.min(1, NAI_FREE_MAX_SIDE / w, NAI_FREE_MAX_SIDE / h);
  if (sideScale < 1) {
    w *= sideScale;
    h *= sideScale;
  }

  // 2) 总像素上限（等比缩放，保持构图比例）
  const pixels = w * h;
  if (pixels > NAI_FREE_MAX_PIXELS) {
    const pixelScale = Math.sqrt(NAI_FREE_MAX_PIXELS / pixels);
    w *= pixelScale;
    h *= pixelScale;
  }

  // 3) 对齐 64（只向下取整，不会越界）
  const alignedW = alignTo64(w);
  const alignedH = alignTo64(h);

  return {
    width: alignedW,
    height: alignedH,
    clamped: alignedW !== originalW || alignedH !== originalH
  };
}

/** 判断一组尺寸是否在免费档以内（不做修改，仅用于日志/校验提示） */
export function isWithinFreeTier(width, height, steps) {
  const w = Number(width);
  const h = Number(height);
  const s = Number(steps);
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(s)) return false;
  return w <= NAI_FREE_MAX_SIDE
    && h <= NAI_FREE_MAX_SIDE
    && w * h <= NAI_FREE_MAX_PIXELS
    && s <= NAI_FREE_STEPS_MAX;
}
