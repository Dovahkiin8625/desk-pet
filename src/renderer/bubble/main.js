const bubble = document.getElementById('bubble');
const titleEl = document.getElementById('title');
const textEl = document.getElementById('text');

/**
 * 桌宠的说话气泡。
 *
 * 两种形态：
 * - 一句完整的话（`onShow`）；
 * - **流式**的聊天回复（`onStreamOpen` → 一串 `onDelta` → `onStreamEnd`），
 *   文字一个字一个字冒出来。
 *
 * 这里只负责「显示什么」，不关心消息从哪来。
 */

/** 正在进行的流：null 表示没有。 */
let streamId = null;
/** 流式文本的追加节点：用文本节点比 `textContent +=` 快得多。 */
let streamNode = null;

// —— 尺寸上报 ——
//
// 流式时每个字都会来一次尺寸测量：每次都报的话，
// 窗口会被缩放几百次（又闪又卡）。所以要**节流**：
// 尺寸变化小于 2px 不报，距上次不足 80ms 也不报（攒着一起报）。

const MIN_SIZE_DELTA = 2;
const MIN_REPORT_INTERVAL_MS = 80;

let lastReported = { width: 0, height: 0 };
let lastReportAt = 0;
let pendingSize = null;
let reportTimer = null;

/** 把量出来的尺寸报给主进程。 */
function sendSize(size) {
  lastReported = size;
  lastReportAt = Date.now();
  // 攒着的那一档要作废：它比现在这档旧，
  // 迟一点发出去会让窗口**缩回去**（回复的尾巴被裁掉）。
  pendingSize = null;
  if (reportTimer) {
    clearTimeout(reportTimer);
    reportTimer = null;
  }
  window.bubble?.reportSize?.(size.width, size.height);
}

/**
 * 把内容尺寸报给主进程：窗口要按内容撑开。
 *
 * 必须等一帧再量：改完 DOM 立刻量，浏览器可能还没算完布局，
 * 量出来的是旧尺寸（窗口就会比内容小，文字被裁掉）。
 */
function reportSize(force = false) {
  requestAnimationFrame(() => {
    const rect = bubble.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // 加上 body 的内边距（阴影留白）。
    const size = { width: Math.ceil(rect.width) + 12, height: Math.ceil(rect.height) + 12 };
    const changed =
      Math.abs(size.width - lastReported.width) >= MIN_SIZE_DELTA ||
      Math.abs(size.height - lastReported.height) >= MIN_SIZE_DELTA;
    if (!changed) return;
    const now = Date.now();
    if (!force && now - lastReportAt < MIN_REPORT_INTERVAL_MS) {
      // 太快了：攒着，等一会儿一起报。
      pendingSize = size;
      if (!reportTimer) {
        reportTimer = setTimeout(() => {
          reportTimer = null;
          const next = pendingSize;
          pendingSize = null;
          if (next) sendSize(next);
        }, MIN_REPORT_INTERVAL_MS + 10);
      }
      return;
    }
    sendSize(size);
  });
}

/** 渲染一条完整的消息。 */
function render(message) {
  if (!message) {
    bubble.classList.add('hidden');
    return;
  }
  bubble.classList.remove('hidden');
  bubble.classList.remove('streaming');
  bubble.dataset.kind = message.kind || 'say';
  titleEl.textContent = message.title || '';
  textEl.textContent = message.text || '';
  streamId = null;
  streamNode = null;
  reportSize(true);
}

/** 开一个流式消息（先是个空壳）。 */
function openStream(payload) {
  streamId = payload?.streamId ?? null;
  titleEl.textContent = payload?.title || '';
  textEl.textContent = '';
  // 用文本节点追加：每次 `textContent +=` 都会把整段重新解析一遍。
  streamNode = document.createTextNode('');
  textEl.append(streamNode);
  bubble.classList.remove('hidden');
  bubble.classList.add('streaming');
  bubble.dataset.kind = payload?.kind || 'chat';
  reportSize(true);
}

/** 追加一段增量。 */
function appendDelta(payload) {
  if (payload?.streamId !== streamId) return; // 迟到的旧流
  if (!streamNode) return;
  streamNode.append(document.createTextNode(payload.delta || ''));
  reportSize();
}

/** 定稿。 */
function endStream(payload) {
  if (payload?.streamId !== streamId) return;
  if (typeof payload.text === 'string' && payload.text) textEl.textContent = payload.text;
  bubble.classList.remove('streaming');
  streamId = null;
  streamNode = null;
  reportSize(true);
}

/** 流被作废：把气泡收起来（半句话不该留在桌面上）。 */
function cancelStream(payload) {
  if (payload?.streamId !== streamId) return;
  bubble.classList.remove('streaming');
  bubble.classList.add('hidden');
  textEl.textContent = '';
  streamId = null;
  streamNode = null;
}

window.bubble?.onShow?.((message) => render(message));

window.bubble?.onStreamOpen?.((payload) => openStream(payload));
window.bubble?.onDelta?.((payload) => appendDelta(payload));
window.bubble?.onStreamEnd?.((payload) => endStream(payload));
window.bubble?.onStreamCancel?.((payload) => cancelStream(payload));

window.bubble?.onHide?.(() => {
  titleEl.textContent = '';
  textEl.textContent = '';
  bubble.classList.remove('streaming');
  bubble.classList.add('hidden');
  streamId = null;
  streamNode = null;
});

// 气泡摆在桌宠的哪一侧：小尾巴要朝那边指。
window.bubble?.onPlacement?.((placement) => {
  if (placement) bubble.dataset.placement = placement;
});

// 先注册监听器再报到：反过来主进程发来的消息会被丢弃。
window.bubble?.reportReady?.();

// 初始是空的：别让一个空壳泡留在桌面上。
bubble.classList.add('hidden');
