/**
 * 形象的「可见轮廓」：渲染结果里真正不透明的那一块。
 *
 * 为什么不能拿模型的自然包围盒凑合：Live2D 贴图四周通常留着一大片
 * 透明边，自然包围盒把那些空白也算进去了。于是小模型会出两个问题：
 *
 *   1. 桌宠窗口的上半截是空的，但**窗口本身**仍占着那块地方。
 *      主进程按窗口夹紧位置 → 角色往上拖也拖不到屏幕顶。
 *   2. 点在那片空白上照样算「点到桌宠」→ 输入框弹出来。
 *
 * 这个模块从**渲染结果**里量：把舞台离屏渲染一遍，读回 alpha，
 * 扫出可见矩形，再存一张缩小的 alpha 掩膜供逐点命中判定。
 *
 * 掩膜是快照：模型待机时会小幅呼吸，轮廓会挪动几个像素。
 * 所以它要定期刷新（refreshIntervalMs），不能只算一次。
 */

/**
 * alpha 阈值：低于它算「透明」。
 *
 * 取 16/255（≈6%）而不是 0：抗锯齿边缘与半透明的柔光也算形象的
 * 一部分，全当透明会让角色的轮廓缺一圈，点边缘时经常点不中。
 */
export const ALPHA_MIN = 16;

/**
 * 在离屏渲染期间关掉**面剔除**。
 *
 * 为什么必须关掉：PIXI 的 extract 会用一个 Y 轴翻转的投影把舞台画进
 * 离屏纹理（最后再翻回来，所以取出来的图看着是正的）。三角形绕序
 * 随之反转——而 Live2D 的部件大多是**单面**的（双面的只占少数，
 * Wanko 34 个部件里只有 1 个是双面的），于是被整个剔除掉：
 * 量出来的掩膜缺一大块，有的模型（Wanko）整只都不剩，
 * 结果是「这个形象的点击区域是空的」。
 *
 * 屏幕上的渲染不走这条路（它用的是屏幕的投影矩阵，绕序是对的），
 * 所以这个毛病只在测量时出现。
 *
 * 关掉剔除只影响这一次离屏渲染：我们要的是 alpha 掩膜，
 * 双面单面都得画出来。
 */
function withoutFaceCulling(renderer, fn) {
  const gl = renderer?.gl;
  if (!gl) return fn();
  const originalEnable = gl.enable.bind(gl);
  const originalDisable = gl.disable.bind(gl);
  gl.enable = (cap) => {
    if (cap !== gl.CULL_FACE) originalEnable(cap);
  };
  gl.disable = (cap) => {
    if (cap !== gl.CULL_FACE) originalDisable(cap);
  };
  try {
    return fn();
  } finally {
    gl.enable = originalEnable;
    gl.disable = originalDisable;
    // 恢复 PIXI 的默认状态（不剔除），并让 PIXI 的状态缓存失效：
    // 刚才那一次渲染动过 GL 状态，缓存若还留着，下一帧可能画错。
    try {
      gl.disable(gl.CULL_FACE);
      renderer.state?.reset?.();
    } catch {
      /* 恢复失败不影响功能：下一帧 Live2D 自己会重设状态 */
    }
  }
}

/**
 * 掩膜相对提取图像的缩小比例。
 *
 * 掩膜是逐点命中判定用的，1/2 意味着一个掩膜格覆盖 2×2 个画布像素：
 * 既够细（头发丝这种一像素宽的部件也在），又省得每格都去读原图。
 */
export const MASK_SCALE = 0.5;

/**
 * 掩膜多久刷新一次（毫秒）。
 *
 * 刷新一次要把舞台离屏渲染一遍并读回像素，几毫秒的事——
 * 每帧刷是浪费，隔太久轮廓又该跟不上动作了。三秒是个折中。
 */
export const DEFAULT_REFRESH_MS = 3000;

/**
 * 建一个轮廓测量器。
 *
 * @param {object} opts
 * @param {object} opts.app PIXI 的 Application
 * @param {number} [opts.refreshIntervalMs] 定时刷新间隔
 * @param {Function} [opts.onRefresh] 定时刷新之后的回调（参数是新的可见矩形）
 */
export function createSilhouette({ app, refreshIntervalMs = DEFAULT_REFRESH_MS, onRefresh } = {}) {
  // 可见矩形（画布坐标）：{x, y, width, height}。
  let rect = null;
  // alpha 掩膜：每个格子一个 alpha 值（0..255）。
  let mask = null;
  // 掩膜覆盖区域的左上角（画布坐标）。
  let origin = { x: 0, y: 0 };
  // 掩膜的格数。
  let maskW = 0;
  let maskH = 0;
  // 提取图像里一个像素对应多少画布单位（提取分辨率不一定是 1）。
  let unitX = 1;
  let unitY = 1;

  let timer = null;

  /**
   * 重新量一次轮廓。
   *
   * 做法：把舞台离屏渲染到一张纹理，读回 alpha，扫出不透明像素的
   * 包围盒，再把整张图缩成一张掩膜。
   *
   * 返回可见矩形（画布坐标），失败返回 null。
   */
  function refresh() {
    const renderer = app?.renderer;
    const extract = renderer?.plugins?.extract || renderer?.extract;
    if (!extract || !app?.stage) return null;

    let el;
    let region;
    try {
      // 区域要按 PIXI 自己的算法算（generateTexture 内部也是这么算的），
      // 否则提取图像与区域的对应关系会差一个像素。
      region = { ...app.stage.getLocalBounds(null, true) };
      el = withoutFaceCulling(renderer, () => extract.canvas(app.stage));
    } catch (err) {
      console.warn('[desk-pet] 轮廓测量失败：', err?.message || err);
      return null;
    }
    if (!el || el.width <= 0 || el.height <= 0) return null;

    let data;
    try {
      data = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
    } catch (err) {
      console.warn('[desk-pet] 轮廓像素读取失败：', err?.message || err);
      return null;
    }

    // 扫 alpha，找不透明像素的包围盒。
    let minX = el.width;
    let minY = el.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < el.height; y++) {
      const row = y * el.width * 4;
      for (let x = 0; x < el.width; x++) {
        if (data[row + x * 4 + 3] < ALPHA_MIN) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // 一个不透明像素都没有：模型没画出来（加载失败、或被隐藏了）。
    // 这时**不要**把轮廓清空——保留上一次的结果，
    // 否则模型短暂不可见的那一帧会让可点击区域整个消失。
    if (maxX < 0) return rect;

    unitX = region.width / el.width;
    unitY = region.height / el.height;
    const left = region.x + minX * unitX;
    const top = region.y + minY * unitY;
    rect = {
      x: left,
      y: top,
      width: (maxX - minX + 1) * unitX,
      height: (maxY - minY + 1) * unitY,
    };

    // 缩成掩膜：一格取覆盖范围内的**最大** alpha，
    // 免得细到一格的部件（发丝、睫毛）整个漏掉。
    maskW = Math.max(1, Math.ceil(el.width * MASK_SCALE));
    maskH = Math.max(1, Math.ceil(el.height * MASK_SCALE));
    const next = new Uint8Array(maskW * maskH);
    for (let my = 0; my < maskH; my++) {
      const y0 = Math.floor(my / MASK_SCALE);
      const y1 = Math.min(el.height, Math.max(y0 + 1, Math.floor((my + 1) / MASK_SCALE)));
      for (let mx = 0; mx < maskW; mx++) {
        const x0 = Math.floor(mx / MASK_SCALE);
        const x1 = Math.min(el.width, Math.max(x0 + 1, Math.floor((mx + 1) / MASK_SCALE)));
        let a = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * el.width * 4;
          for (let x = x0; x < x1; x++) {
            const v = data[row + x * 4 + 3];
            if (v > a) a = v;
          }
        }
        next[my * maskW + mx] = a;
      }
    }
    mask = next;
    origin = { x: region.x, y: region.y };
    return rect;
  }

  /**
   * 画布上的这个点是不是落在形象上。
   *
   * 量不出来的时候返回 **null**（= 不知道），由调用方决定怎么办——
   * 「不知道」与「不在形象上」不是一回事：前者该退回旧行为，
   * 后者该忽略这次点击。
   */
  function contains(x, y) {
    if (!mask || !rect) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const px = (x - origin.x) / unitX;
    const py = (y - origin.y) / unitY;
    if (px < 0 || py < 0 || px >= maskW / MASK_SCALE || py >= maskH / MASK_SCALE) return false;
    const mx = Math.min(maskW - 1, Math.floor(px * MASK_SCALE));
    const my = Math.min(maskH - 1, Math.floor(py * MASK_SCALE));
    return mask[my * maskW + mx] >= ALPHA_MIN;
  }

  /** 可见矩形（画布坐标）；还没量出来时是 null。 */
  function getRect() {
    return rect ? { ...rect } : null;
  }

  /** 轮廓是否可用。 */
  function isReady() {
    return Boolean(mask && rect);
  }

  /** 启动定时刷新。 */
  function startAutoRefresh() {
    if (timer) return;
    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) return;
    timer = setInterval(() => {
      // 量完要把结果告诉外面：可见矩形变了，主进程得重新夹紧位置。
      const next = refresh();
      if (next) onRefresh?.(next);
    }, refreshIntervalMs);
  }

  /** 停掉定时刷新。 */
  function stopAutoRefresh() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { refresh, contains, getRect, isReady, startAutoRefresh, stopAutoRefresh };
}
