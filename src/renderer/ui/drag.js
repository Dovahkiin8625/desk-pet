export const DRAG_THRESHOLD = 6;

/**
 * 拖拽状态机：区分「点击」与「拖拽」。
 * 位移未超过阈值视为点击，超过阈值进入拖拽态。
 * onDragMove 回调给出的是**增量**位移（deltaX/deltaY），
 * 便于直接累加到窗口位置，避免重复累加造成漂移。
 *
 * 这是一个纯状态机：它不碰 DOM，也不自己挂监听器。
 * 监听器由 pet/interaction.js 统一挂载——否则同一批指针事件会被
 * 处理两次（点击既触发反应又启动拖拽）。
 */
export function createDragController({ threshold = DRAG_THRESHOLD, onTap, onDragStart, onDragMove, onDragEnd } = {}) {
  let down = null;
  let last = null;
  let dragging = false;

  return {
    get dragging() {
      return dragging;
    },
    pointerDown(e) {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      last = { x: e.clientX, y: e.clientY };
      dragging = false;
    },
    pointerMove(e) {
      if (!down || e.pointerId !== down.pointerId) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!dragging && Math.hypot(dx, dy) > threshold) {
        dragging = true;
        onDragStart?.(down.x, down.y);
      }
      if (dragging) {
        const deltaX = e.clientX - last.x;
        const deltaY = e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        onDragMove?.({ clientX: e.clientX, clientY: e.clientY, deltaX, deltaY });
      }
    },
    pointerUp(e) {
      if (!down || e.pointerId !== down.pointerId) return;
      const wasDragging = dragging;
      down = null;
      last = null;
      dragging = false;
      if (wasDragging) onDragEnd?.({ clientX: e.clientX, clientY: e.clientY });
      else onTap?.(e.clientX, e.clientY);
    },
    pointerCancel() {
      down = null;
      last = null;
      dragging = false;
    },
  };
}
