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

/**
 * 四条停靠边。
 *
 * 边名散落过多处时迟早会写错一个（这条分支已经因为方向写反栽过一次），
 * 所以这里给出一份**唯一**的清单：几何计算、设置文件的 sanitize
 * 都从它这儿取。
 */
export const DOCK_SIDES = Object.freeze(['left', 'right', 'top', 'bottom']);

/**
 * 每条边「本帧位移朝它去」的判据。
 *
 * 屏幕坐标的 y 轴**向下为正**——所以「往上推」是 `dy < 0`。
 * 写反的话上下两个方向的吸附会整个对调。
 */
const TOWARD = Object.freeze({
  left: (d) => d.dx < 0,
  right: (d) => d.dx > 0,
  top: (d) => d.dy < 0,
  bottom: (d) => d.dy > 0,
});

/** 停靠时露在屏幕上的宽度（px）。 */
export const DOCK_SLIP = 24;

/** 吸附阈值：离边缘这么近就磁过去。 */
export const SNAP_THRESHOLD = 24;

/** 停靠判定要求的最小净位移（px）。 */
export const MIN_DOCK_PUSH = 8;

/**
 * 「贴齐」的判定容差：坐标取整后最多 0.5px 的浮点误差。
 *
 * 实际坐标都是整数，所以它等价于「gap 必须恰好是 0」——
 * 差 1px 就不算贴齐。
 */
const FLUSH_EPSILON = 0.5;

/**
 * 窗口与工作区四条边之间的间隙。
 *
 * 正数 = 还差多少才贴齐；负数 = 已经越出屏幕。
 *
 * workArea 缺失时**抛错**，不返回假间隙：拿零尺寸工作区算出来的
 * 间隙是一堆毫无意义的数字（left = x、right = -x - width），
 * 调用方会拿着它们继续跑，比当场炸掉难排查得多。
 */
export function edgeGaps(x, y, width, height, workArea) {
  if (!workArea) {
    throw new TypeError('edgeGaps 需要 workArea');
  }
  return {
    left: x - workArea.x,
    right: workArea.x + workArea.width - (x + width),
    top: y - workArea.y,
    bottom: workArea.y + workArea.height - (y + height),
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
  const d = delta || { dx: 0, dy: 0 };
  const candidates = [];
  // 四条边走同一套判据：间隙在阈值内，且位移朝它去。
  for (const side of DOCK_SIDES) {
    const gap = gaps[side];
    if (!(gap > 0 && gap <= threshold)) continue;
    if (!TOWARD[side](d)) continue;
    candidates.push({ side, gap });
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

/**
 * 停靠时沿该轴允许的位置区间（含两端）。
 *
 * 区间是 **藏匿区 ∪ 普通可见区**：从「完全藏起」一路盖到「工作区另一头的
 * 完全可见位」。只给藏匿区是不够的——那样「把停靠中的桌宠挪到屏幕中间」
 * 根本做不到：往里拖 400px，它只走（窗宽 − 24）就停在藏匿区边界不动，
 * 光标还在它右边 124px，用户得再拖一次。
 *
 * 每条边的区间都必须**包含自己的停靠位**（dockPosition 算出来的那个）：
 * 不包含的话，停靠中的窗口一被拖动就会被夹到别处——
 * 「停在上边缘」会立刻弹成「完全可见」，停在下边缘同理。
 */
export function dockedRange(side, width, height, workArea, slip = DOCK_SLIP) {
  if (side === 'left') {
    return { min: workArea.x + slip - width, max: workArea.x + workArea.width - width };
  }
  if (side === 'right') {
    return { min: workArea.x, max: workArea.x + workArea.width - slip };
  }
  if (side === 'top') {
    return { min: workArea.y + slip - height, max: workArea.y + workArea.height - height };
  }
  if (side === 'bottom') {
    return { min: workArea.y, max: workArea.y + workArea.height - slip };
  }
  // 不是四条边之一：调用方（clampDocked）会先挡掉这种情形，
  // 这里给一个「普通可见区」兜底——不做任何停靠放宽。
  return { min: workArea.x, max: workArea.x + workArea.width - width };
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
 *
 * **取整在夹紧之前**：先夹再取整会让结果越出区间 1px
 * （976.6 夹到 976 后取整成 977，比上界 976 多露 1px）。
 *
 * side 不是四个合法边名时退化成**普通夹紧**（两个轴都按工作区夹，
 * 不做任何停靠放宽）——「什么都不做」比「无声地把窗口推到屏幕外」好。
 */
export function clampDocked(x, y, width, height, workArea, side, slip = DOCK_SLIP) {
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  if (!DOCK_SIDES.includes(side)) {
    return {
      x: Math.min(Math.max(Math.round(x), workArea.x), maxX),
      y: Math.min(Math.max(Math.round(y), workArea.y), maxY),
    };
  }
  const range = dockedRange(side, width, height, workArea, slip);
  let cx;
  let cy;
  if (side === 'left' || side === 'right') {
    cx = Math.min(Math.max(Math.round(x), range.min), range.max);
    cy = Math.min(Math.max(Math.round(y), workArea.y), maxY);
  } else {
    cx = Math.min(Math.max(Math.round(x), workArea.x), maxX);
    cy = Math.min(Math.max(Math.round(y), range.min), range.max);
  }
  return { x: cx, y: cy };
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
  // 每条边「朝它推」的量：往左推时 dx 是负的，所以左边的量是 -dx；
  // 往上是 dy 负，所以上边的量是 -dy（屏幕坐标 y 向下为正）。
  const push = { left: -d.dx, right: d.dx, top: -d.dy, bottom: d.dy };
  for (const side of DOCK_SIDES) {
    if (!flush(gaps[side])) continue;
    if (push[side] < minPush) continue;
    candidates.push({ side, push: push[side] });
  }
  if (candidates.length === 0) return null;
  // 两个方向都贴齐时（默认位置就在右下角），取位移大的那个。
  candidates.sort((a, b) => b.push - a.push);
  return candidates[0].side;
}
