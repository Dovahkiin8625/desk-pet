// plugins/screenshot/pages/overlay.js
/**
 * 遮罩层：铺满一块显示器，盖着刚抓下来的那张画面。
 *
 * 它管三件事：
 *
 * 1. **框选**：鼠标移到窗口上自动选中它（还没点选时，选区跟着窗口走）；
 *    按下左键后就由用户自己决定——不动是确认，动了就是手动框；
 * 2. **标注**：画图形、箭头、笔、文字、马赛克；
 * 3. **出图**：把选区（连同标注）导成 PNG 交给主进程。
 *
 * 坐标一律用**物理像素**（截图的像素）——跟窗口位置是一套，窗口识别才对得上。
 */
(function () {
  const bg = document.getElementById('bg');
  const ink = document.getElementById('ink');
  const hole = document.getElementById('hole');
  const tools = document.getElementById('tools');
  const options = document.getElementById('options');
  const txt = document.getElementById('txt');
  const ctxBg = bg.getContext('2d');
  const ctxInk = ink.getContext('2d');

  const COLOR = '#ff4d4f';

  const OPTIONS_MODES = new Set(['shape', 'arrow', 'pen', 'text']);
  const COLORS = ['#ff4d4f', '#fa541c', '#fadb14', '#52c41a', '#1890ff', '#722ed1', '#000000', '#ffffff'];
  const WIDTHS = [2, 4, 6, 8];
  const SIZES = [12, 14, 16, 20, 24, 32];

  let info = null;
  /** 窗口清单（自动选窗用）：可能晚于 init 到，先存着。 */
  let pendingWindows = null;
  let source = null;
  /** 选区：{x,y,w,h}（物理像素）。 */
  let sel = null;
  /** 标注操作（按画的顺序）。 */
  let ops = [];
  /** select | shape | arrow | pen | text | mosaic */
  let mode = 'select';
  /** 图形是矩形还是椭圆。 */
  let shape = 'rect';
  /** 标注的颜色、粗细、字号（二级选项条里挑）。 */
  let penColor = COLOR;
  let strokeWidth = 4;
  let textSize = 20;
  let drag = null;
  /**
   * 用户是不是已经选定了选区（按下过左键）。
   *
   * 还没选定（false）时，鼠标移到哪个窗口上就自动把它当选区——
   * 这就是「吸附」存在的地方；一旦按下左键（chosen = true），
   * 选区就交给用户：不动 = 确认当前选区，动了 = 手动框，
   * 手动框的时候一律不再吸附。
   */
  let chosen = false;

  const send = (message) => window.shot.send(message);
  window.shot.onMessage(handle);

  function handle(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'init') init(message);
    else if (message.type === 'windows') {
      // 窗口清单是后补的：清单到了再合并。
      const windows = Array.isArray(message.windows) ? message.windows : [];
      if (info) info.windows = windows;
      else pendingWindows = windows;
    }
  }

  function init(data) {
    info = data;
    info.windows = Array.isArray(data.windows) ? data.windows : pendingWindows || [];
    pendingWindows = null;
    bg.width = data.width;
    bg.height = data.height;
    ink.width = data.width;
    ink.height = data.height;
    const veil = document.getElementById('veil');
    const img = new Image();
    const ready = () => {
      // 画面画好了（或画坏了）再跟主进程说一声：它这时候才把遮罩亮出来。
      // drawImage 是同步的，画布里已经有像素了，不用等下一帧。
      send({ type: 'ready' });
    };
    img.onload = () => {
      source = img;
      ctxBg.drawImage(img, 0, 0, data.width, data.height);
      // 画面到了，撤掉罩着的黑纱。
      if (veil) veil.style.display = 'none';
      ready();
    };
    img.onerror = () => {
      if (veil) veil.style.display = 'none';
      ready();
    };
    img.src = data.file;
  }

  // -------------------------------------------------------------------------
  // 坐标
  // -------------------------------------------------------------------------

  /** 画布的缩放：CSS 像素 → 物理像素。 */
  function metrics() {
    const rect = bg.getBoundingClientRect();
    return {
      rect,
      rx: info ? info.width / (rect.width || info.width) : 1,
      ry: info ? info.height / (rect.height || info.height) : 1,
    };
  }

  function point(event) {
    const { rect, rx, ry } = metrics();
    return { x: (event.clientX - rect.left) * rx, y: (event.clientY - rect.top) * ry };
  }

  function normRect(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  // -------------------------------------------------------------------------
  // 自动选窗口
  // -------------------------------------------------------------------------

  /**
   * 指针下面那个窗口：取 **z 序最靠上**的那个。
   *
   * 被压在下面的窗口指针点不到，吸附框它只会带偏——
   * 遮挡就以枚举出来的顺序为准（EnumWindows 自顶向下）。
   */
  function windowAt(p) {
    const list = (info?.windows || []).filter(
      (w) => p.x >= w.x && p.x <= w.x + w.w && p.y >= w.y && p.y <= w.y + w.h
    );
    if (!list.length) return null;
    list.sort((a, b) => (a.z ?? 1e9) - (b.z ?? 1e9));
    return list[0];
  }

  /** 窗口清单里一个窗口的矩形（复制一份，别让外部改到清单）。 */
  function windowRect(w) {
    return { x: w.x, y: w.y, w: w.w, h: w.h };
  }

  /** 选区不能出屏。 */
  function clampRect(rect) {
    const x = Math.max(0, Math.min(rect.x, bg.width));
    const y = Math.max(0, Math.min(rect.y, bg.height));
    return {
      x,
      y,
      w: Math.max(0, Math.min(rect.w, bg.width - x)),
      h: Math.max(0, Math.min(rect.h, bg.height - y)),
    };
  }

  // -------------------------------------------------------------------------
  // 画
  // -------------------------------------------------------------------------

  /**
   * 指针离开这块屏：吸附预览是「上一帧」的画面——鼠标挪到另一块屏上，
   * 这块屏上还留着一个框（哪怕是全屏框），看着像漏了东西。
   * 没按下过（没 chosen、没在拖）就清掉，框就跟着人走。
   */
  function clearHover() {
    if (drag || chosen || mode !== 'select') return;
    if (!sel) return;
    sel = null;
    paint();
  }

  function paint() {
    if (!sel) {
      hole.style.display = 'none';
      tools.style.display = 'none';
      return;
    }
    const { rect, rx, ry } = metrics();
    hole.style.display = 'block';
    hole.style.left = `${rect.left + sel.x / rx}px`;
    hole.style.top = `${rect.top + sel.y / ry}px`;
    hole.style.width = `${sel.w / rx}px`;
    hole.style.height = `${sel.h / ry}px`;
    // 选区还没定下来（鼠标悬停自动选中的预览态）就别放工具条——
    // 它会跟着悬停乱跳，用户根本点不中。
    if (chosen) {
      placeTools();
      placeOptions();
    } else {
      tools.style.display = 'none';
      options.style.display = 'none';
    }
  }

  /** 工具条摆在选区下方；下方放不下就摆上方。 */
  function placeTools() {
    const { rect, rx, ry } = metrics();
    const width = tools.offsetWidth;
    const height = tools.offsetHeight;
    const left = rect.left + sel.x / rx;
    const top = rect.top + sel.y / ry;
    const bottom = top + sel.h / ry;

    let x = left + sel.w / rx / 2 - width / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    let y = bottom + 8;
    if (y + height > window.innerHeight - 8) y = top - height - 8;
    if (y < 8) y = 8;
    tools.style.left = `${x}px`;
    tools.style.top = `${y}px`;
    tools.style.display = 'flex';
  }

  // -------------------------------------------------------------------------
  // 二级选项条（图形 / 箭头 / 画笔 / 文本）
  // -------------------------------------------------------------------------

  /** 建一条（或重建）选项条的内容。每次挑了选项就整条重建，.on 状态天然摆正。 */
  function buildOptions() {
    options.innerHTML = '';
    options.dataset.mode = mode;

    const button = (className, on, title, onClick, inner) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = on ? `${className} on` : className;
      el.title = title;
      if (inner) el.innerHTML = inner;
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
        buildOptions();
        placeOptions();
      });
      options.appendChild(el);
      return el;
    };
    const sep = () => {
      const el = document.createElement('span');
      el.className = 'sep';
      options.appendChild(el);
    };
    const colorRow = () => {
      for (const c of COLORS) {
        const el = button('swatch', penColor === c, `颜色 ${c}`, () => {
          penColor = c;
        });
        el.style.background = c;
      }
    };
    const widthRow = () => {
      for (const w of WIDTHS) {
        button('line-btn', strokeWidth === w, `粗细 ${w}px`, () => {
          strokeWidth = w;
        }, `<span class="bar" style="height:${w}px"></span>`);
      }
    };

    if (mode === 'shape') {
      button('opt-btn', shape === 'rect', '矩形', () => {
        shape = 'rect';
      }, '矩形');
      button('opt-btn', shape === 'ellipse', '椭圆', () => {
        shape = 'ellipse';
      }, '椭圆');
      sep();
    }
    colorRow();
    sep();
    if (mode === 'text') {
      for (const s of SIZES) {
        const el = button('size-btn', textSize === s, `字号 ${s}`, () => {
          textSize = s;
        });
        el.textContent = String(s);
      }
    } else {
      widthRow();
    }
  }

  /** 选项条摆在工具条正下方；下方放不下就挪到工具条上面。 */
  function placeOptions() {
    if (!OPTIONS_MODES.has(mode) || !sel || !chosen) {
      options.style.display = 'none';
      return;
    }
    if (options.dataset.mode !== mode) buildOptions();
    options.style.display = 'flex';
    const toolsLeft = parseFloat(tools.style.left) || 8;
    const toolsTop = parseFloat(tools.style.top) || 8;
    const width = options.offsetWidth;
    const height = options.offsetHeight;
    let x = toolsLeft + tools.offsetWidth / 2 - width / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    let y = toolsTop + tools.offsetHeight + 4;
    if (y + height > window.innerHeight - 8) y = Math.max(8, toolsTop - height - 4);
    options.style.left = `${x}px`;
    options.style.top = `${y}px`;
  }

  function drawOps(pending) {
    ctxInk.clearRect(0, 0, ink.width, ink.height);
    const list = pending ? ops.concat([pending]) : ops;
    for (const op of list) drawOp(op);
  }

  function drawOp(op) {
    ctxInk.strokeStyle = op.color || COLOR;
    ctxInk.fillStyle = op.color || COLOR;
    ctxInk.lineWidth = op.width || 3;
    if (op.type === 'rect') {
      ctxInk.strokeRect(op.x, op.y, op.w, op.h);
    } else if (op.type === 'ellipse') {
      ctxInk.beginPath();
      ctxInk.ellipse(
        op.x + op.w / 2,
        op.y + op.h / 2,
        Math.abs(op.w / 2),
        Math.abs(op.h / 2),
        0,
        0,
        Math.PI * 2
      );
      ctxInk.stroke();
    } else if (op.type === 'arrow') {
      drawArrow(op);
    } else if (op.type === 'pen') {
      if (op.points.length < 2) return;
      ctxInk.beginPath();
      ctxInk.moveTo(op.points[0][0], op.points[0][1]);
      for (const p of op.points) ctxInk.lineTo(p[0], p[1]);
      ctxInk.stroke();
    } else if (op.type === 'text') {
      ctxInk.font = `${op.size}px sans-serif`;
      ctxInk.textBaseline = 'top';
      ctxInk.fillText(op.text, op.x, op.y);
    } else if (op.type === 'mosaic') {
      drawMosaic(op);
    }
  }

  function drawArrow(op) {
    const angle = Math.atan2(op.y2 - op.y1, op.x2 - op.x1);
    const head = Math.max(12, op.width * 4);
    ctxInk.beginPath();
    ctxInk.moveTo(op.x1, op.y1);
    ctxInk.lineTo(op.x2, op.y2);
    ctxInk.stroke();
    ctxInk.beginPath();
    ctxInk.moveTo(op.x2, op.y2);
    ctxInk.lineTo(
      op.x2 - head * Math.cos(angle - Math.PI / 7),
      op.y2 - head * Math.sin(angle - Math.PI / 7)
    );
    ctxInk.lineTo(
      op.x2 - head * Math.cos(angle + Math.PI / 7),
      op.y2 - head * Math.sin(angle + Math.PI / 7)
    );
    ctxInk.closePath();
    ctxInk.fill();
  }

  /** 马赛克：把那块地方缩成几个色块再放大回去。 */
  function drawMosaic(op) {
    const block = 10;
    const x = Math.min(op.x, op.x + op.w);
    const y = Math.min(op.y, op.y + op.h);
    const w = Math.max(1, Math.abs(op.w));
    const h = Math.max(1, Math.abs(op.h));
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w / block));
    tmp.height = Math.max(1, Math.round(h / block));
    tmp.getContext('2d').drawImage(bg, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctxInk.imageSmoothingEnabled = false;
    ctxInk.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    ctxInk.imageSmoothingEnabled = true;
  }

  // -------------------------------------------------------------------------
  // 鼠标
  // -------------------------------------------------------------------------

  window.addEventListener('mousedown', (event) => {
    if (!info) return;
    if (event.target === txt) return;
    if (event.target.closest('.tools')) return;
    if (event.target.closest('.options')) return;
    if (mode === 'text') {
      // **别让浏览器接管焦点**：鼠标点下去时默认会把焦点抢走，
      // 输入框刚打开就被 blur，字写不进去。
      event.preventDefault();
      if (txt.style.display === 'block') {
        // 已经开着一个输入了：点别的地方先把字落下，再开新的。
        commitText();
        return;
      }
      dragPoint = point(event);
      placeText();
      return;
    }
    const p = point(event);
    if (mode === 'select') {
      // 按下这一下就算「选定了」：不动是确认当前选区，动了就是手动框——
      // 之后选区不再跟着鼠标悬停走，手动框也不吸附。
      const prevChosen = chosen;
      chosen = true;
      // 按在窗口上：**先记着**，不动就选它整个，动了就是自己框。
      // prev：按下之前的选区——空白处点了一下要原样放回去，别误清。
      drag = { kind: 'free', start: p, hit: windowAt(p), prev: sel ? { ...sel } : null, prevChosen };
      return;
    }
    if (!sel) return;
    if (mode === 'pen') drag = { kind: 'pen', points: [[p.x, p.y]], color: penColor, width: strokeWidth };
    else drag = { kind: mode, start: p, end: p, color: penColor, width: strokeWidth };
  });

  // 鼠标移出这块屏（比如挪到另一块屏上）：两种写法都试一遍。
  document.documentElement.addEventListener('mouseleave', clearHover);
  window.addEventListener('mouseout', (event) => {
    if (!event.relatedTarget) clearHover();
  });

  window.addEventListener('mousemove', (event) => {
    if (!info) return;
    const p = point(event);
    if (!drag) {
      // 还没选定：鼠标移到哪个窗口上就自动选中它（悬停预览，工具条等选定后再出）。
      if (!chosen && mode === 'select') {
        const hit = windowAt(p);
        sel = hit ? windowRect(hit) : null;
        paint();
      }
      return;
    }
    if (drag.kind === 'free') {
      // 手动框：框哪全看用户，一律不再吸附。
      sel = clampRect(normRect(drag.start, p));
      paint();
      return;
    }
    if (drag.kind === 'pen') {
      drag.points.push([p.x, p.y]);
      drawOps({ type: 'pen', points: drag.points, color: drag.color, width: drag.width });
      return;
    }
    drag.end = p;
    drawOps(buildOp(drag));
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (current.kind === 'free') {
      const tiny = !sel || sel.w < 8 || sel.h < 8;
      if (tiny) {
        if (current.hit) {
          // 原地点了一下：压着窗口就是选它整个。
          sel = windowRect(current.hit);
          chosen = true;
          ops = [];
        } else if (current.prev) {
          // 点在空白处：一次无效点击，原选区、原定/预览状态和标注都不动。
          sel = current.prev;
          chosen = current.prevChosen;
        } else {
          // 本来就没选区，点空白 = 什么都没发生。
          sel = null;
          chosen = false;
        }
      } else {
        // 拖了一个真框：手动选区，不吸附。
        chosen = true;
        ops = [];
      }
      drawOps();
      paint();
      return;
    }
    if (current.kind === 'pen') {
      // 画笔的点已经在拖动中画出来了，收尾时把这一笔收进 ops，
      // 否则 mouseup 后 drawOps 会把它清掉。
      if (current.points.length >= 2) {
        ops.push({ type: 'pen', points: current.points, color: current.color, width: current.width });
      }
    } else {
      const op = buildOp(current);
      if (op) ops.push(op);
    }
    drawOps();
  });

  /** 双击选区：跟点 √ 一样，把选区复制进剪贴板。 */
  window.addEventListener('dblclick', (event) => {
    if (event.target.closest('.tools') || event.target.closest('.options')) return;
    if (mode !== 'select') return;
    if (!info || !sel || !source) return;
    const p = point(event);
    if (p.x >= sel.x && p.y >= sel.y && p.x <= sel.x + sel.w && p.y <= sel.y + sel.h) {
      exportPng('copy');
    }
  });

  /** 把这一笔变成一个操作。 */
  function buildOp(drag) {
    const end = drag.end || drag.start;
    if (drag.kind === 'shape') {
      const r = normRect(drag.start, end);
      if (r.w < 4 || r.h < 4) return null;
      return { type: shape, x: r.x, y: r.y, w: r.w, h: r.h, width: drag.width || strokeWidth, color: drag.color || penColor };
    }
    if (drag.kind === 'arrow') {
      if (Math.abs(end.x - drag.start.x) + Math.abs(end.y - drag.start.y) < 8) return null;
      return {
        type: 'arrow',
        x1: drag.start.x,
        y1: drag.start.y,
        x2: end.x,
        y2: end.y,
        width: drag.width || strokeWidth,
        color: drag.color || penColor,
      };
    }
    if (drag.kind === 'mosaic') {
      const r = normRect(drag.start, end);
      if (r.w < 8 || r.h < 8) return null;
      return { type: 'mosaic', x: r.x, y: r.y, w: r.w, h: r.h };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 文字
  // -------------------------------------------------------------------------

  let committing = false;
  let dragPoint = null;

  function placeText() {
    // 已经在输入了：别把用户写到一半的字冲掉。
    if (txt.style.display === 'block') return;
    const { rect, rx, ry } = metrics();
    committing = false;
    txt.style.display = 'block';
    txt.style.left = `${rect.left + dragPoint.x / rx}px`;
    txt.style.top = `${rect.top + dragPoint.y / ry}px`;
    txt.value = '';
    txt.focus();
  }

  function commitText() {
    if (committing) return;
    committing = true;
    const value = txt.value.trim();
    txt.style.display = 'none';
    if (!value || !dragPoint) return;
    ops.push({
      type: 'text',
      x: dragPoint.x,
      y: dragPoint.y,
      text: value,
      size: Math.round(textSize * metrics().rx),
      color: penColor,
    });
    dragPoint = null;
    drawOps();
  }

  txt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitText();
    else if (event.key === 'Escape') {
      committing = true;
      txt.style.display = 'none';
      dragPoint = null;
    }
  });
  txt.addEventListener('blur', commitText);

  // -------------------------------------------------------------------------
  // 工具条
  // -------------------------------------------------------------------------

  const TOOLS = new Set(['shape', 'arrow', 'pen', 'text', 'mosaic']);

  tools.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const cmd = button.dataset.cmd;
    if (TOOLS.has(cmd)) {
      setMode(cmd);
      return;
    }
    if (cmd === 'undo') {
      ops.pop();
      drawOps();
      return;
    }
    if (cmd === 'ocr' || cmd === 'save' || cmd === 'pin') {
      exportPng(cmd);
      return;
    }
    if (cmd === 'finish') {
      // √ 和双击选区一回事：把选区复制进剪贴板（没选区就只收工）。
      if (sel && source) exportPng('copy');
      else send({ type: 'finish' });
      return;
    }
    send({ type: cmd });
  });

  function setMode(tool) {
    mode = tool;
    for (const button of tools.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.cmd === tool);
    }
    placeOptions();
  }

  // -------------------------------------------------------------------------
  // 出图
  // -------------------------------------------------------------------------

  function exportPng(action) {
    if (!sel || !source) return;
    const x = Math.max(0, Math.round(sel.x));
    const y = Math.max(0, Math.round(sel.y));
    const w = Math.min(bg.width - x, Math.round(sel.w));
    const h = Math.min(bg.height - y, Math.round(sel.h));
    if (w <= 0 || h <= 0) return;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.drawImage(bg, x, y, w, h, 0, 0, w, h);
    ctx.drawImage(ink, x, y, w, h, 0, 0, w, h);
    out.toBlob(
      (blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buffer) => {
          send({ type: 'png', action, buffer: new Uint8Array(buffer) });
        });
      },
      'image/png'
    );
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && txt.style.display !== 'block') {
      send({ type: 'cancel' });
    }
  });
})();
