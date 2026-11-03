// 桌宠的视口与缩放常量。
//
// 主进程（按缩放算窗口大小）与渲染层（把模型适配进画布）共用这一份：
// 两边各写一份迟早会漂移，而漂移的后果不是「数值对不上」，
// 是「模型被窗口切掉上半身」——那正是这个模块要消灭的缺陷。

// 缩放为 1 时桌宠窗口的尺寸（也是模型适配的基准画布）。
//
// 与 assets/live2d/models/*/pet.json 的 viewport 保持一致。
// 清单里的 viewport 不能拿来用：settings 的 sanitizeSettings 会把 viewport 丢掉。
export const PET_VIEWPORT = Object.freeze({ width: 300, height: 560 });

// 用户缩放的取值范围。
//
// 渲染层（滚轮）与主进程（落盘）必须用同一份：渲染层多给一点、
// 主进程夹回去，用户会看到「已经滚到底了却不再变」。
export const SCALE_RANGE = Object.freeze({ min: 0.5, max: 2.0 });

// 滚轮一格（deltaY = 100）对应的缩放增量。
export const SCALE_STEP = 0.05;

/** 把缩放夹进合法区间；非法值回退到 fallback。 */
export function clampScale(value, fallback = 1) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(SCALE_RANGE.max, Math.max(SCALE_RANGE.min, n));
}

/**
 * 按用户缩放算出窗口尺寸（还没夹到屏幕大小）。
 *
 * 窗口尺寸 = 基准视口 × 缩放：等比放大，画布跟着变，
 * 渲染层把模型适配进画布，模型于是跟着等比变大。
 */
export function scaledWindowSize(scale) {
  const s = clampScale(scale);
  return {
    width: Math.max(1, Math.round(PET_VIEWPORT.width * s)),
    height: Math.max(1, Math.round(PET_VIEWPORT.height * s)),
  };
}

/**
 * 窗口尺寸夹到显示器的可见工作区之内。
 *
 * 窗口比屏幕还高时，桌宠的头会跑到屏幕外面去——那和被窗口截断是同一类缺陷，
 * 只是裁剪的边界从窗口换成了屏幕。
 */
export function fitWindowSize(scale, workArea) {
  const raw = scaledWindowSize(scale);
  if (!workArea) return raw;
  return {
    width: Math.min(raw.width, workArea.width),
    height: Math.min(raw.height, workArea.height),
  };
}

/**
 * 窗口尺寸变了之后的新位置：锚点是窗口的**下边缘中心**。
 *
 * 桌宠是站在地上的角色，放大时脚下的位置不动，个头往上长——
 * 否则每放大一次，宠物就会在桌面上「长歪」一截。
 */
export function anchoredPosition(x, y, width, height, size) {
  return {
    x: Math.round(x + width / 2 - size.width / 2),
    y: Math.round(y + height - size.height),
  };
}
