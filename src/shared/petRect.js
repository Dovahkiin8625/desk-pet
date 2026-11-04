/**
 * 桌宠的「可见矩形」：窗口里真正画着形象的那一块。
 *
 * 桌宠窗口是一块固定大小的画布（300×560 基准，按用户缩放放大），
 * 而 Live2D 贴图四周通常留着一大片透明边——模型的自然包围盒把那些
 * 空白也算进去了。于是小模型会出现两个后果：
 *
 *   1. 窗口上半截是空的，但**窗口本身**仍占着那块地方。
 *      主进程按窗口夹紧位置 → 角色永远差一截才贴得到屏幕边，
 *      往上拖也拖不到顶（用户报的现象）。
 *   2. 点在那片空白上照样算「点到桌宠」→ 输入框弹出来。
 *
 * 所以「桌宠有多大、在哪」必须由**渲染结果**回答，而不是由画布回答。
 * 渲染层量出可见矩形（窗口内坐标）报给主进程，主进程据此夹紧、
 * 吸附、停靠、摆位；渲染层自己拿它做逐点命中判定。
 *
 * 本文件是纯几何，不碰 Electron——单元测试可以直接跑。
 */

/** 可见矩形是否可用：宽高都得是有限正数。 */
export function hasVisibleRect(rect) {
  return (
    Boolean(rect) &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * 可见矩形在屏幕上的位置与大小。
 *
 * @param {{x:number,y:number,width:number,height:number}} windowRect 窗口在屏幕上的矩形
 * @param {object|null} visible 可见矩形在**窗口内**的偏移与大小
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function visibleRectOnScreen(windowRect, visible) {
  if (!hasVisibleRect(visible)) {
    return { x: windowRect.x, y: windowRect.y, width: windowRect.width, height: windowRect.height };
  }
  return {
    x: windowRect.x + visible.x,
    y: windowRect.y + visible.y,
    width: visible.width,
    height: visible.height,
  };
}

/**
 * 反过来：可见矩形该在屏幕上的哪里 → 窗口左上角该在哪。
 *
 * 夹紧与吸附算的是可见矩形的位置，落到窗口上要减掉窗口内的偏移。
 */
export function windowRectForVisible(visibleRect, visible) {
  if (!hasVisibleRect(visible)) return { x: visibleRect.x, y: visibleRect.y };
  return { x: visibleRect.x - visible.x, y: visibleRect.y - visible.y };
}

/**
 * 窗口尺寸变了之后，按比例缩放可见矩形。
 *
 * 缩放时窗口会重新适配模型，渲染层随后会报一个新的可见矩形；
 * 但在它报上来之前，主进程得先有个能用的值——
 * 按比例缩放是最接近的估计，误差只有一个模型宽度的零头。
 */
export function scaleVisibleRect(visible, ratioX, ratioY) {
  if (!hasVisibleRect(visible)) return visible;
  const rx = Number.isFinite(ratioX) && ratioX > 0 ? ratioX : 1;
  const ry = Number.isFinite(ratioY) && ratioY > 0 ? ratioY : 1;
  return {
    x: visible.x * rx,
    y: visible.y * ry,
    width: visible.width * rx,
    height: visible.height * ry,
  };
}
