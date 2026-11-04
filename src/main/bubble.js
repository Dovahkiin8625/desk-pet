import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { appUrl } from './protocol.js';
import { placeBesidePet, DEFAULT_SIDES } from './placement.js';
import { MESSAGE_KIND, DEFAULT_TTL_MS } from '../shared/assistant.js';

/**
 * 桌宠的「说话气泡」。
 *
 * 为什么是独立窗口而不是画在桌宠窗口里：桌宠窗口 300×560 被角色占满了，
 * 气泡画在它上面就是盖住角色的脸；而气泡要塞得下天气、系统状态、
 * 甚至一整段聊天回复，需要自己的尺寸与排版。
 *
 * 三条硬约束（每一条都对应一个踩过的坑）：
 *
 * 1. **懒创建**：窗口在第一次有消息时才建。
 *    `app.firstWindow()` 认的是「第一个窗口」，E2E 靠它找宠物窗口——
 *    气泡若在启动时就存在，整个 e2e 套件都会超时。
 * 2. **就绪握手**：`webContents.send` 对尚未注册监听器的页面是**丢弃**而不是排队。
 *    气泡页要回「我准备好了」，在那之前的消息排队等着——
 *    否则用户点的第一个功能的提示会被凭空吞掉。
 * 3. **点击穿透**：始终 `setIgnoreMouseEvents(true)`。
 *    Windows 没有逐像素命中测试，整个窗口矩形都是热区——
 *    气泡要是吃掉了桌面的点击，用户会以为桌面坏了。
 *
 * 气泡有两种形态：
 * - `show()`：一句话，完整显示，6 秒后自动消失；
 * - `openStream()`：**流式**消息（AI 对话的回复），逐字冒出来，
 *   定稿之后才开始计时自动消失。
 */

/** 气泡与桌宠之间的间距（像素）。 */
const GAP = 8;

/** 气泡窗口的最小/最大尺寸，防止内容把窗口撑到离谱。 */
const MIN_WIDTH = 160;
const MAX_WIDTH = 360;

/** 流式消息定稿后的存活时长（毫秒）：比一句话长——回复要读完。 */
const CHAT_TTL_MS = 15000;

export function createBubbleController({ rootDir, getPetWindow, getPetRect, getDisplays }) {
  let win = null;
  let ready = false;
  // 还没准备好时收到的消息：等页面就绪后按顺序补发。
  const pending = [];
  let hideTimer = null;
  let currentMessage = null;
  // 正在进行的流式消息：0 表示没有。
  let streamId = 0;
  // 流式序号：每开一个流就 +1，用来认「迟到的旧流」。
  let streamSeq = 0;
  // 流式期间锁定的摆放方向：气泡长大后换边会让小尾巴跳。
  let streamSide = null;
  // 当前流的存活时长（定稿后开始计时）。
  let currentStreamTtl = CHAT_TTL_MS;
  // 流式期间到达的普通消息：等流结束再显示（不要打断半句话）。
  const deferred = [];
  // 页面还没就绪时收到的流式增量：先攒着。
  //
  // `webContents.send` 对尚未注册监听器的页面是**丢弃**而不是排队——
  // 模型的回复往往比气泡页加载还快，不攒着的话开头那几句就没了。
  let streamBuffer = '';
  // 页面还没就绪时收到的**定稿**：同样会被丢弃，要一起攒着。
  let streamFinal = null;
  // 最近一次流的 id：定稿补发时要用它（页面那边只认自己那个流）。
  let lastStreamId = 0;

  function clearTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  /** 定稿之后（或普通消息之后）开始计时自动消失。 */
  function scheduleHide(ttlMs) {
    clearTimer();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // 有排队等着的消息：换下一条。
      //
      // **不能**在流结束的那一刻就显示它——那会把刚说完的回复顶掉
      // （用户看到的是自己的话闪一下就没了，换成了别的东西）。
      // 等气泡自己消失、读者已经看完，再换下一条。
      if (deferred.length > 0) {
        deliver(deferred.shift());
        return;
      }
      hide();
    }, Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS);
  }

  /**
   * 气泡放在桌宠的哪个位置。
   *
   * 摆位规则与插件面板共用（见 src/main/placement.js）：
   * 头顶 → 脚下 → 左侧 → 右侧，取第一个完整落在工作区内的位置。
   *
   * 流式期间**锁住方向**：气泡会随着文字变长，长到某个尺寸后
   * 「头顶」就放不下了，会改摆到「脚下」——小尾巴跟着跳一下，
   * 正在读字的人会以为换了个窗口。
   *
   * 返回摆在哪一侧：气泡页面要据此决定小尾巴朝哪边指。
   */
  function place(width, height) {
    const preferred = streamSide
      ? [streamSide, ...DEFAULT_SIDES.filter((side) => side !== streamSide)]
      : undefined;
    const chosen = placeBesidePet({
      petWindow: getPetWindow(),
      // 贴着桌宠**本体**：桌宠窗口上半截常常是空的，
      // 按窗口摆气泡会浮在角色头顶老高的地方。
      petRect: getPetRect?.(),
      displays: getDisplays(),
      width,
      height,
      gap: GAP,
      preferred,
    });
    if (streamSide) streamSide = chosen.placement;
    win.setPosition(chosen.x, chosen.y);
    return chosen.placement;
  }

  /** 页面量出内容尺寸后回来：按内容撑开窗口，再重新摆位置。 */
  function applySize(size) {
    if (!win || win.isDestroyed()) return;
    const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, size?.width || MIN_WIDTH)));
    const height = Math.max(24, Math.round(size?.height || 24));
    const [currentWidth, currentHeight] = win.getSize();
    if (currentWidth !== width || currentHeight !== height) {
      win.setBounds({ ...win.getBounds(), width, height });
    }
    const placement = place(width, height);
    send('pet:bubblePlacement', placement);
  }

  function send(channel, payload) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  function hide() {
    clearTimer();
    // 自己要收气泡，就别让 cancelStream 再装一个计时器。
    cancelStream({ hide: false });
    currentMessage = null;
    if (!win || win.isDestroyed()) return;
    send('pet:bubbleHide');
    win.hide();
  }

  /**
   * 显示一条完整消息。
   *
   * @param {object} message { kind, text, title, emotion, ttlMs, interrupt }
   *   `interrupt: true` 表示这条消息**打断**正在进行的流式回复
   *   （提醒、闹钟比聊天重要）。
   */
  function show(message) {
    const kind = message?.kind || MESSAGE_KIND.SAY;
    const payload = {
      kind,
      title: message?.title || '',
      text: message?.text || '',
      emotion: message?.emotion || '',
      // 存活时长：调用方可以指定，不给就用默认的 6 秒。
      ttlMs: Number.isFinite(message?.ttlMs) ? message.ttlMs : undefined,
    };
    // **先**记住气泡现在显示的是什么：下面要用它判断
    // 「聊天回复是不是正占着气泡」——currentMessage 马上就要被覆盖了。
    const showingChat = currentMessage?.kind === MESSAGE_KIND.CHAT;

    if (!win || win.isDestroyed()) {
      createWindow();
      // 窗口刚建好，页面还没就绪：先排队，等它报到再发。
      pending.push({ type: 'message', payload });
      return;
    }
    if (!ready) {
      pending.push({ type: 'message', payload });
      return;
    }
    if (streamId && !message?.interrupt) {
      // 流式期间：排队，不要打断半句话。
      deferred.push(payload);
      return;
    }
    if (streamId && message?.interrupt) cancelStream();
    // 聊天回复正在显示时，别的消息排队等它读完。
    //
    // 否则一句问候就能把刚说完的回复顶掉——用户读到一半，
    // 自己刚收到的话就没了（虽然聊天记录里还在）。
    // 提醒、闹钟这类要紧的消息带 `interrupt`，可以直接插队。
    if (showingChat && !message?.interrupt) {
      deferred.push(payload);
      return;
    }
    currentMessage = payload;
    deliver(payload);
  }

  function deliver(payload) {
    clearTimer();
    send('pet:bubbleShow', payload);
    scheduleHide(payload.ttlMs);
  }

  /**
   * 开一个流式消息（先显示一个空壳）。
   *
   * @returns {number} 流 id：后面的增量与定稿都带着它。
   */
  function openStream({ kind = MESSAGE_KIND.CHAT, title = '', ttlMs = CHAT_TTL_MS } = {}) {
    // 上一个流直接作废：不能有两个流同时往一个气泡里写字。
    cancelStream();
    const id = ++streamSeq;
    streamId = id;
    lastStreamId = id;
    streamSide = null;
    currentStreamTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : CHAT_TTL_MS;
    streamBuffer = '';
    streamFinal = null;
    // **流期间不计时**：定时器在这里必须清掉，
    // 否则半句话说到一半气泡就消失了。
    clearTimer();
    const payload = { streamId: id, kind, title, ttlMs };
    if (!win || win.isDestroyed()) {
      createWindow();
      pending.push({ type: 'stream', payload });
      return id;
    }
    if (!ready) {
      pending.push({ type: 'stream', payload });
      return id;
    }
    startStream(payload);
    return id;
  }

  function startStream(payload) {
    send('pet:bubbleStreamOpen', payload);
  }

  /** 追加一段增量文本。 */
  function appendStream(id, delta) {
    // 迟到的旧流：丢掉（用户已经看到新的回复了）。
    if (!streamId || streamId !== id) return;
    const text = String(delta ?? '');
    if (!text) return;
    // 页面还没就绪：先攒着，页面报到后补上。
    if (!ready) {
      streamBuffer += text;
      return;
    }
    send('pet:bubbleDelta', { streamId: id, delta: text });
  }

  /** 定稿：从**此刻**开始计时自动消失。 */
  function endStream(id, { text = '', emotion = '' } = {}) {
    if (!streamId || streamId !== id) return;
    const ttlMs = currentStreamTtl;
    streamId = 0;
    currentMessage = { kind: MESSAGE_KIND.CHAT, text, emotion };
    // 页面还没就绪时，这条定稿会被**丢弃**——先攒着，页面报到后补发。
    // 不攒的话，用户会看到一只空的、闪着光标的气泡，回复正文不见了。
    if (!ready) {
      streamFinal = { text, emotion };
      scheduleHide(ttlMs);
      return;
    }
    streamBuffer = '';
    streamFinal = null;
    send('pet:bubbleStreamEnd', { streamId: id, text, emotion });
    scheduleHide(ttlMs);
    // 流期间排队的消息**不**在这里显示：
    // 刚说完的回复要留在气泡里等用户读完，
    // 排队的那些等它自动消失后再换上来（见 scheduleHide）。
  }

  /**
   * 作废当前的流（出错、被打断）。
   *
   * @param {object} [options]
   * @param {boolean} [options.hide] 要不要顺手把气泡收起来。
   *   `hide()` 自己会调用它那时不能收（会又把计时器装上）。
   */
  function cancelStream({ hide = true } = {}) {
    if (!streamId) return;
    const id = streamId;
    streamId = 0;
    streamBuffer = '';
    streamFinal = null;
    currentStreamTtl = DEFAULT_TTL_MS;
    // 页面还没就绪时，开流的那条请求还排在队列里——
    // 不撤掉的话，页面就绪后会开一个**已经作废**的流：
    // 一只空的、闪着光标的气泡，而且没有任何计时器会收掉它。
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i]?.type === 'stream') pending.splice(i, 1);
    }
    send('pet:bubbleStreamCancel', { streamId: id });
    // 流期间排队的消息不能跟着流一起没了：它们要显示出来。
    while (deferred.length > 0) deliver(deferred.shift());
    if (hide) {
      // 气泡里现在什么都没有（流被撤了），别让它一直挂在桌面上。
      scheduleHide(DEFAULT_TTL_MS);
    }
  }

  function createWindow() {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      width: 240,
      height: 80,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(rootDir, 'src', 'preload', 'bubble.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 隐藏的窗口会被 Chromium **冻结**（后台节流）：
        // 气泡自动消失后渲染进程就冻住了，下一条消息要等它「醒过来」才画得出来，
        // 表现得像气泡失灵。宠物窗口也有同一行——两处都要关。
        backgroundThrottling: false,
      },
    });
    // 层级要高于桌宠：桌宠用的是普通 alwaysOnTop（'floating' 级），
    // 两个同级的置顶窗口相对顺序是未定义的——气泡会被桌宠盖住。
    win.setAlwaysOnTop(true, 'screen-saver');
    // 气泡**永远**不吃点击：它只是桌宠说话的地方，不是界面的入口。
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.loadURL(appUrl('/src/renderer/bubble/index.html'));
    // 抓住这个窗口自己：旧窗口的 closed 事件不能把新窗口的引用清掉。
    const created = win;
    created.on('closed', () => {
      if (win !== created) return;
      win = null;
      ready = false;
      pending.length = 0;
      deferred.length = 0;
    });
  }

  // 页面就绪：把排队等着消息补发出去。
  ipcMain.on('pet:bubbleReady', (event) => {
    if (!win || event.sender !== win.webContents) return;
    ready = true;
    while (pending.length > 0) {
      const item = pending.shift();
      if (item.type === 'stream') startStream(item.payload);
      else deliver(item.payload);
    }
    // 模型比气泡页加载还快的时候，开头那几句会先到：补上。
    if (streamBuffer) {
      send('pet:bubbleDelta', { streamId: lastStreamId, delta: streamBuffer });
      streamBuffer = '';
    }
    // 定稿也可能先到（回复比页面加载还快）：补上，
    // 否则用户看到的是一只空的、闪着光标的气泡，回复正文不见了。
    if (streamFinal) {
      send('pet:bubbleStreamEnd', {
        streamId: lastStreamId,
        text: streamFinal.text,
        emotion: streamFinal.emotion,
      });
      streamFinal = null;
    }
  });

  // 页面量出了内容尺寸。
  ipcMain.on('pet:bubbleSize', (event, size) => {
    if (!win || event.sender !== win.webContents) return;
    applySize(size);
    if (!win.isVisible()) win.showInactive();
  });

  // 气泡当前的状态。
  //
  // `interactive` 恒为 false：气泡永远是点击穿透的。
  // 它留在这里是为了让「气泡不挡桌面」这件事有个可断言的出口——
  // Electron 只有 setIgnoreMouseEvents（setter），没有对应的 getter。
  ipcMain.handle('pet:bubbleState', (event) => {
    if (!win || event.sender !== win.webContents) return null;
    return {
      kind: currentMessage?.kind || '',
      interactive: false,
      visible: win.isVisible(),
    };
  });

  return {
    show,
    hide,
    openStream,
    appendStream,
    endStream,
    cancelStream,
    /** 桌宠窗口移动后重新摆位。 */
    reposition: () => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const [w, h] = win.getSize();
      const placement = place(w, h);
      // 摆到哪一侧要告诉页面：小尾巴要朝桌宠那边指。
      // 只挪窗口而不改尾巴，桌宠拖到屏幕另一边后，
      // 尾巴还指着原来的方向——看起来像指错了人。
      send('pet:bubblePlacement', placement);
    },
    isOpen: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    /** 桌宠被隐藏时：气泡也不该留在桌面上。 */
    onPetHidden: () => {
      if (win && !win.isDestroyed() && win.isVisible()) hide();
    },
    destroy: () => {
      clearTimer();
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
