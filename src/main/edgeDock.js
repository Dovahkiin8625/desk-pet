/**
 * 边缘吸附与贴边停靠的几何计算。
 *
 * 全部是纯函数：不碰 Electron，也不碰窗口——只算坐标。
 *
 * 之所以单独拆一个文件：这段几何是最容易算错的部分
 * （四条边 × 吸附/停靠/夹紧三种状态），而纯函数能脱离窗口单测。
 *
 * 这个文件**不得 import Electron**：本仓库的单元测试用 `node --test` 跑，
 * 没有 Electron 环境。
 */

/** 停靠时露在屏幕上的宽度（px）。 */
export const DOCK_SLIP = 24;

/** 吸附阈值：离边缘这么近就磁过去。 */
export const SNAP_THRESHOLD = 24;

/** 停靠判定要求的最小净位移（px）。 */
export const MIN_DOCK_PUSH = 8;

/** 「贴齐」的判定容差：坐标取整后可能有 1px 的浮点误差。 */
const FLUSH_EPSILON = 0.5;

/**
 * 窗口与工作区四条边之间的间隙。
 *
 * 正数 = 还差多少才贴齐；负数 = 已经越出屏幕。
 */
export function edgeGaps(x, y, width, height, workArea) {
  const wa = workArea || { x: 0, y: 0, width: 0, height: 0 };
  return {
    left: x - wa.x,
    right: wa.x + wa.width - (x + width),
    top: y - wa.y,
    bottom: wa.y + wa.height - (y + height),
  };
}

/**
 * 吸附：间隙在阈值以内、**且位移是朝那条边去的** → 间隙归零，窗口贴齐。
 *
 * 「朝那条边去」这条是必须的：没有它，窗口贴上边之后往回拖会被立刻吸回去，
 * 用户会发现「拽不动」。加上它，窗口一离开边缘就自由了。
 *
 * @param {object} delta 本帧的位移 `{dx, dy}`
 * @returns {{x: number, y: number, side: string|null}} side 是被吸附的那条边
 */
export function snapToEdge(
  x,
  y,
  width,
  height,
  workArea,
  delta = { dx: 0, dy: 0 },
  threshold = SNAP_THRESHOLD,
) {
  const gaps = edgeGaps(x, y, width, height, workArea);
  const candidates = [];
  if (gaps.left > 0 && gaps.left <= threshold && delta.dx < 0) {
    candidates.push({ side: 'left', gap: gaps.left });
  }
  if (gaps.right > 0 && gaps.right <= threshold && delta.dx > 0) {
    candidates.push({ side: 'right', gap: gaps.right });
  }
  if (gaps.top > 0 && gaps.top <= threshold && delta.dy < 0) {
    candidates.push({ side: 'top', gap: gaps.top });
  }
  if (gaps.bottom > 0 && gaps.bottom <= threshold && delta.dy > 0) {
    candidates.push({ side: 'bottom', gap: gaps.bottom });
  }
  if (candidates.length === 0) return { x, y, side: null };
  // 间隙最小的优先：它离贴齐最近。
  candidates.sort((a, b) => a.gap - b.gap);
  const side = candidates[0].side;
  const next = { x, y };
  if (side === 'left') next.x = workArea.x;
  else if (side === 'right') next.x = workArea.x + workArea.width - width;
  else if (side === 'top') next.y = workArea.y;
  else next.y = workArea.y + workArea.height - height;
  return { x: next.x, y: next.y, side };
}

/**
 * 停靠位置：沿 side 滑出屏幕，只留 slip 宽可见。
 *
 * 垂直于停靠轴的那个坐标**原样保留**：桌宠停靠在右边时，
 * 它在屏幕上的上下位置不该因为停靠而改变。
 */
export function dockPosition(side, x, y, width, height, workArea, slip = DOCK_SLIP) {
  if (side === 'left') return { x: workArea.x + slip - width, y };
  if (side === 'right') return { x: workArea.x + workArea.width - slip, y };
  if (side === 'top') return { x, y: workArea.y + slip - height };
  if (side === 'bottom') return { x, y: workArea.y + workArea.height - slip };
  return { x, y };
}

/** 完全可见、贴齐那条边的位置（停靠的「反面」）。 */
export function flushPosition(side, x, y, width, height, workArea) {
  if (side === 'left') return { x: workArea.x, y };
  if (side === 'right') return { x: workArea.x + workArea.width - width, y };
  if (side === 'top') return { x, y: workArea.y };
  if (side === 'bottom') return { x, y: workArea.y + workArea.height - height };
  return { x, y };
}

/** 停靠时沿该轴允许的位置区间（含两端）。 */
export function dockedRange(side, width, height, workArea, slip = DOCK_SLIP) {
  if (side === 'left') return { min: workArea.x + slip - width, max: workArea.x };
  if (side === 'right') {
    return { min: workArea.x + workArea.width - width, max: workArea.x + workArea.width - slip };
  }
  if (side === 'top') return { min: workArea.y + slip - height, max: workArea.y };
  return { min: workArea.y + workArea.height - height, max: workArea.y + workArea.height - slip };
}

/**
 * 停靠状态的夹紧：停靠轴放宽到 dockedRange，垂直轴照常。
 *
 * 放宽是必须的：普通的 clampToDisplays 把窗口整个按回工作区内，
 * 停靠根本出不来。
 *
 * **停靠轴要用停靠区间直接夹，不能先按普通区间夹一遍再放宽**——
 * 普通区间是 [wa.left, wa.right - w]，落在它右边的值（比如想往屏幕外推）
 * 会先被夹回 wa.right - w，放宽就再也救不回来了。
 */
export function clampDocked(x, y, width, height, workArea, side, slip = DOCK_SLIP) {
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  const range = dockedRange(side, width, height, workArea, slip);
  let cx;
  let cy;
  if (side === 'left' || side === 'right') {
    cx = Math.min(Math.max(x, range.min), range.max);
    cy = Math.min(Math.max(y, workArea.y), maxY);
  } else {
    cx = Math.min(Math.max(x, workArea.x), maxX);
    cy = Math.min(Math.max(y, range.min), range.max);
  }
  return { x: Math.round(cx), y: Math.round(cy) };
}

/** 窗口是不是还完全藏在那条边后面。 */
export function isFullyTucked(x, y, width, height, workArea, side, slip = DOCK_SLIP) {
  const target = dockPosition(side, x, y, width, height, workArea, slip);
  return (
    Math.abs(target.x - x) < FLUSH_EPSILON && Math.abs(target.y - y) < FLUSH_EPSILON
  );
}

/**
 * 拖拽结束时判定要不要停靠、停靠在哪条边。
 *
 * @param {object} gaps 四个间隙
 * @param {object} delta 本次拖拽的**净位移**（期望位置的净变化）
 * @returns {string|null} 停靠边；不停靠返回 null
 */
export function chooseDockSide(gaps, delta, { minPush = MIN_DOCK_PUSH } = {}) {
  const d = delta || { dx: 0, dy: 0 };
  const candidates = [];
  const flush = (v) => Math.abs(v) < FLUSH_EPSILON;
  if (flush(gaps.right) && d.dx >= minPush) candidates.push({ side: 'right', push: d.dx });
  if (flush(gaps.left) && -d.dx >= minPush) candidates.push({ side: 'left', push: -d.dx });
  if (flush(gaps.bottom) && d.dy >= minPush) candidates.push({ side: 'bottom', push: d.dy });
  if (flush(gaps.top) && -d.dy >= minPush) candidates.push({ side: 'top', push: -d.dy });
  if (candidates.length === 0) return null;
  // 两个方向都贴齐时（默认位置就在右下角），取位移大的那个。
  candidates.sort((a, b) => b.push - a.push);
  return candidates[0].side;
}
