// plugins/screen-recorder/pages/picker.js
/**
 * 选区遮罩。
 *
 * 窗口铺满一块显示器，底图是那张显示器的整屏截图（变暗），
 * 用户在上面拖一个框。选完把矩形交回主进程。
 *
 * 坐标有两条路：
 * - 这里拿到的是 **CSS 像素**（= DIP，窗口多大就是多大）；
 * - 主进程要的是**截图的物理像素**，所以这里顺手换算好再发。
 *
 * 换算用的是 web/geometry.js —— 和捕获页裁剪用的是同一份，
 * 两边算法不一样的话，选区就会偏。
 */
(function () {
  const G = globalThis.ScreenRecorderGeometry;

  const shot = document.getElementById('shot');
  const sel = document.getElementById('sel');
  const sizeLabel = document.getElementById('size');

  let snapshotSize = { width: 0, height: 0 };
  let start = null;
  let current = null;

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** CSS 空间 → 截图物理像素空间。 */
  function toSnapshot(rect) {
    return G.scaleRect(rect, viewport(), snapshotSize);
  }

  function paint() {
    if (!current) return;
    sel.style.display = 'block';
    sel.style.left = `${current.x}px`;
    sel.style.top = `${current.y}px`;
    sel.style.width = `${current.width}px`;
    sel.style.height = `${current.height}px`;
    const snap = toSnapshot(current);
    sizeLabel.textContent = `${snap.width} × ${snap.height}`;
  }

  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#bar')) return;
    start = { x: event.clientX, y: event.clientY };
    current = G.normalizeRect(start, start);
    paint();
  });

  document.addEventListener('mousemove', (event) => {
    if (!start) return;
    current = G.normalizeRect(start, { x: event.clientX, y: event.clientY });
    paint();
  });

  document.addEventListener('mouseup', () => {
    if (!start) return;
    start = null;
  });

  document.getElementById('ok').addEventListener('click', () => {
    const rect = current ? toSnapshot(current) : null;
    if (!rect || rect.width < 4 || rect.height < 4) {
      // 没框到东西就别录：告诉用户重框一次，而不是录一段全黑。
      sizeLabel.textContent = '先在上面拖一个框';
      return;
    }
    window.rec.send({ type: 'picked', payload: { crop: rect, snapshotSize } });
  });

  document.getElementById('cancel').addEventListener('click', () => {
    window.rec.send({ type: 'picked-cancel' });
  });

  window.rec.onMessage((message) => {
    if (message.type !== 'picker') return;
    const payload = message.payload || {};
    snapshotSize = payload.snapshotSize || { width: 0, height: 0 };
    shot.src = payload.image || '';
  });
})();
