// plugins/music-player/pages/lyrics.js
/**
 * 桌面歌词。
 *
 * 主进程推来一份歌词（行 + 当前该显示第几行），这里把它摆成
 * 「当前那行大、亮，其余小、淡」的一列，滚到当前那行为止。
 *
 * 窗口是透明的，底下就是桌面：歌词自己带一层描边 shadows 才看得清。
 */
const viewport = document.getElementById('viewport');
const linesEl = document.getElementById('lines');
const closeBtn = document.getElementById('close');

/** 当前的歌词行。 */
let lines = [];
/** 当前该显示第几行。 */
let index = -1;
/** 上一份歌词的「长相」：变了才重画整列。 */
let signature = '';

function paint() {
  linesEl.textContent = '';
  if (!lines.length) {
    const p = document.createElement('p');
    p.className = 'line current';
    p.textContent = '♪';
    linesEl.append(p);
    linesEl.style.transform = 'translateY(0)';
    return;
  }
  lines.forEach((line, i) => {
    const p = document.createElement('p');
    p.className = i === index ? 'line current' : 'line';
    p.textContent = line.text || '♪';
    linesEl.append(p);
  });
  center();
}

/** 把当前那行滚到中间。 */
function center() {
  const current = linesEl.children[index];
  if (!current) {
    linesEl.style.transform = 'translateY(0)';
    return;
  }
  const y = viewport.clientHeight / 2 - (current.offsetTop + current.offsetHeight / 2);
  linesEl.style.transform = `translateY(${Math.round(y)}px)`;
}

function apply(state) {
  if (!state) return;
  const nextLines = Array.isArray(state.lines) ? state.lines : [];
  const nextIndex = Number(state.index);
  const sig = `${nextLines.length}:${nextIndex}`;
  if (sig === signature) return;
  signature = sig;
  lines = nextLines;
  index = Number.isFinite(nextIndex) ? nextIndex : -1;
  paint();
}

window.mp.onMessage((message) => {
  if (message?.type !== 'state') return;
  apply(message);
});

closeBtn.addEventListener('click', () => {
  window.mp.send({ role: 'lyrics', type: 'close' });
});

// 页面好了：主进程把当前歌词发过来。
window.mp.send({ role: 'lyrics', type: 'ready' });
