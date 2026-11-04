// plugins/screen-recorder/web/geometry.js
/**
 * 坐标换算。
 *
 * 这个文件是**经典脚本**（渲染层页面用 `<script src>` 加载），
 * 挂到 globalThis 上而不是 export——插件的页面走 file://，
 * ES module 的 import 会被 CORS 拦掉。
 *
 * 这里有两套坐标，别混：
 *
 * - **DIP**（逻辑像素）：显示器 bounds、遮罩窗口的大小。
 *   Windows 缩放 150% 时，2560 宽的屏幕在 bounds 里只有 1707。
 * - **物理像素**：截图的原始尺寸、捕获轨的 videoWidth。
 *
 * 换算漏了任何一级，选区录出来就是歪的。
 */
(function () {
  function toNumber(value) {
    return Number.isFinite(value) ? value : 0;
  }

  /** 拖拽的起止点 → 矩形（宽高为正）。 */
  function normalizeRect(start, end) {
    const x1 = toNumber(start?.x);
    const y1 = toNumber(start?.y);
    const x2 = toNumber(end?.x);
    const y2 = toNumber(end?.y);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  /** 矩形从一个空间换算到另一个空间。 */
  function scaleRect(rect, from, to) {
    const fromWidth = toNumber(from?.width) || 1;
    const fromHeight = toNumber(from?.height) || 1;
    const toWidth = toNumber(to?.width) || 1;
    const toHeight = toNumber(to?.height) || 1;
    const sx = toWidth / fromWidth;
    const sy = toHeight / fromHeight;
    return {
      x: Math.round(toNumber(rect?.x) * sx),
      y: Math.round(toNumber(rect?.y) * sy),
      width: Math.round(toNumber(rect?.width) * sx),
      height: Math.round(toNumber(rect?.height) * sy),
    };
  }

  /** 把矩形夹在给定尺寸内。 */
  function clampRect(rect, size) {
    const width = toNumber(size?.width);
    const height = toNumber(size?.height);
    const x = Math.max(0, Math.min(toNumber(rect?.x), width));
    const y = Math.max(0, Math.min(toNumber(rect?.y), height));
    return {
      x,
      y,
      width: Math.max(0, Math.min(toNumber(rect?.width), width - x)),
      height: Math.max(0, Math.min(toNumber(rect?.height), height - y)),
    };
  }

  globalThis.ScreenRecorderGeometry = { normalizeRect, scaleRect, clampRect };
})();
