// plugins/screen-recorder/pages/picker.js
/**
 * 选区遮罩。
 *
 * 窗口铺满一块显示器，**透明**——底下就是真实的桌面。
 * 用户在上面拖一个框，框住要录的地方。
 *
 * 坐标：
 * - 这里拿到的是 **CSS 像素**（= DIP，窗口多大就是多大）；
 * - 主进程要的是**截图的物理像素**，那边自己乘缩放系数（这里只报 DIP）。
 */
(function () {
  const sel = document.getElementById('sel');
  const sizeLabel = document.getElementById('size');
  const shades = {
    top: document.getElementById('shade-top'),
    right: document.getElementById('shade-right'),
    bottom: document.getElementById('shade-bottom'),
    left: document.getElementById('shade-left'),
  };

  let start = null;
  let current = null;

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function normalize(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  }

  /** 框外压暗：四块。选中的那块不盖。 */
  function paintShade(rect) {
    const { width: vw, height: vh } = viewport();
    const parts = {
      top: { x: 0, y: 0, width: vw, height: rect.y },
      right: { x: rect.x + rect.width, y: 0, width: vw - rect.x - rect.width, height: vh },
      bottom: { x: 0, y: rect.y + rect.height, width: vw, height: vh - rect.y - rect.height },
      left: { x: 0, y: 0, width: rect.x, height: vh },
    };
    for (const [key, part] of Object.entries(parts)) {
      const node = shades[key];
      if (part.width <= 0 || part.height <= 0) {
        node.style.display = 'none';
        continue;
      }
      node.style.display = 'block';
      node.style.left = `${part.x}px`;
      node.style.top = `${part.y}px`;
      node.style.width = `${part.width}px`;
      node.style.height = `${part.height}px`;
    }
  }

  function paint() {
    if (!current) return;
    sel.style.display = 'block';
    sel.style.left = `${current.x}px`;
    sel.style.top = `${current.y}px`;
    sel.style.width = `${current.width}px`;
    sel.style.height = `${current.height}px`;
    paintShade(current);
    // 大小写在框的上边（框到屏幕顶部时就在下面）。
    const above = current.y > 24;
    sizeLabel.style.display = 'block';
    sizeLabel.style.left = `${Math.max(4, current.x)}px`;
    sizeLabel.style.top = `${above ? current.y - 24 : current.y + current.height + 4}px`;
    sizeLabel.textContent = `${Math.round(current.width)} × ${Math.round(current.height)}（DIP）`;
  }

  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#bar')) return;
    start = { x: event.clientX, y: event.clientY };
    current = normalize(start, start);
    paint();
  });

  document.addEventListener('mousemove', (event) => {
    if (!start) return;
    current = normalize(start, { x: event.clientX, y: event.clientY });
    paint();
  });

  document.addEventListener('mouseup', () => {
    if (!start) return;
    start = null;
  });

  document.getElementById('ok').addEventListener('click', () => {
    if (!current || current.width < 4 || current.height < 4) {
      // 没框到东西就别录：告诉用户重框一次，而不是录一段全黑。
      sizeLabel.textContent = '先在上面拖一个框';
      sizeLabel.style.display = 'block';
      sizeLabel.style.left = '12px';
      sizeLabel.style.top = '12px';
      return;
    }
    window.rec.send({
      type: 'picked',
      payload: { rect: current, viewport: viewport() },
    });
  });

  document.getElementById('cancel').addEventListener('click', () => {
    window.rec.send({ type: 'picked-cancel' });
  });

  // Esc 也能取消：用户未必看得见底下的按钮。
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.rec.send({ type: 'picked-cancel' });
  });
})();
