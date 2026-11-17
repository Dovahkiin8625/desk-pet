import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { appUrl } from './protocol.js';
import { appIconPath } from './appIcon.js';
import { placeBesidePet, DEFAULT_SIDES } from './placement.js';
import { MESSAGE_KIND, DEFAULT_TTL_MS } from '../shared/assistant.js';
import { createAskInbox } from './bubbleAsk.js';

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
 *
 * 还有一种**例外形态**：**卡片**（`showApproval` / `showChoice`）——
 * 它不自动消失，而且**能点**（普通气泡永远是点击穿透的）。
 * 卡片有两种：审批卡（这么干行不行）与选择卡（你要哪个）——
 * 后台任务拿不准的时候，就用选择卡问用户一句。
 */

/** 气泡与桌宠之间的间距（像素）。 */
const GAP = 8;

/** 气泡窗口的最小/最大尺寸，防止内容把窗口撑到离谱。 */
const MIN_WIDTH = 160;
/**
 * 最大宽度要装得下「气泡本体 + 四周的留白」：
 * 气泡本体的上限是 340（见 renderer/bubble/index.html），
 * 留白是两边各 16——窗口被截短了，气泡右边的影子就没了。
 */
const MAX_WIDTH = 380;

/** 流式消息定稿后的存活时长（毫秒）：比一句话长——回复要读完。 */
const CHAT_TTL_MS = 15000;

export function createBubbleController({ rootDir, getPetWindow, getPetRect, getDisplays }) {
  let win = null;
  let ready = false;
  // 还没准备好时收到的消息：等页面就绪后按顺序补发。
  const pending = [];
  /** 等着用户回话的卡片：一条队列（先进先出）。 */
  const asks = createAskInbox();
  /** 气泡上正显示着的那张卡片（空串 = 没有）。 */
  let shownCardId = '';
  /** 审批的自动编号：调用方没给 id 时用。 */
  let approvalSeq = 0;
  /** 选择卡的自动编号：调用方没给 id 时用。 */
  let choiceSeq = 0;
  let hideTimer = null;
  let currentMessage = null;
  // 正在进行的流式消息：0 表示没有。
  let streamId = 0;
  // 流式序号：每开一个流就 +1，用来认「迟到的旧流」。
  let streamSeq = 0;
  // 流式期间锁定的摆放方向：气泡长大后换边会让小尾巴跳。
  let streamSide = null;
  // 单条消息指定的摆放方向（点桌宠的台词要摆在脚下，
  // 免得和头顶的插件面板重叠）。只在显示这一条时有效。
  let oneShotSide = null;
  // 当前流的存活时长（定稿后开始计时）。
  let currentStreamTtl = CHAT_TTL_MS;
  /**
   * 气泡**本体**的尺寸与四周留白（页面上报的）。
   *
   * 摆位按本体算，窗口比本体大一圈：那圈留白是给影子与小尾巴的，
   * 不是气泡的一部分，不该算进「离桌宠多远」里。
   */
  let content = {
    width: 0,
    height: 0,
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
  };
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
      // 气泡空出来了：还有卡片等着就把它摆上来——
      // 刚才它给流让了位，现在该它了。
      if (asks.pending() > 0) {
        showHeadCard();
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
  function place() {
    // 优先顺序：单条消息指定的边 > 流式锁定 > 默认（头顶 → 脚下 → 左 → 右）。
    const locked = oneShotSide || streamSide;
    const preferred = locked
      ? [locked, ...DEFAULT_SIDES.filter((side) => side !== locked)]
      : undefined;
    const chosen = placeBesidePet({
      petWindow: getPetWindow(),
      // 贴着桌宠**本体**：桌宠窗口上半截常常是空的，
      // 按窗口摆气泡会浮在角色头顶老高的地方。
      petRect: getPetRect?.(),
      displays: getDisplays(),
      // 按**气泡本体**摆：窗口四周还有一圈留白（给影子与小尾巴），
      // 那一圈不是气泡，不该算进「离桌宠多远」里。
      width: content.width || win.getSize()[0],
      height: content.height || win.getSize()[1],
      gap: GAP,
      preferred,
    });
    if (streamSide) streamSide = chosen.placement;
    // 窗口要往桌宠那边挪一圈留白，气泡本体的边才真的离桌宠 GAP 这么远。
    win.setPosition(chosen.x - content.paddingLeft, chosen.y - content.paddingTop);
    return chosen.placement;
  }

  /** 页面量出内容尺寸后回来：按内容撑开窗口，再重新摆位置。 */
  function applySize(size) {
    if (!win || win.isDestroyed()) return;
    content = {
      width: Math.max(0, Number(size?.width) || 0),
      height: Math.max(0, Number(size?.height) || 0),
      paddingLeft: Math.max(0, Number(size?.paddingLeft) || 0),
      paddingRight: Math.max(0, Number(size?.paddingRight) || 0),
      paddingTop: Math.max(0, Number(size?.paddingTop) || 0),
      paddingBottom: Math.max(0, Number(size?.paddingBottom) || 0),
    };
    // 窗口 = 气泡本体 + 四周的留白（影子与小尾巴要待的地方）。
    const width = Math.round(
      Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, content.width + content.paddingLeft + content.paddingRight)
      )
    );
    const height = Math.max(
      24,
      Math.round(content.height + content.paddingTop + content.paddingBottom)
    );
    const [currentWidth, currentHeight] = win.getSize();
    if (currentWidth !== width || currentHeight !== height) {
      win.setBounds({ ...win.getBounds(), width, height });
    }
    const placement = place();
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
    // 单条消息指定的摆位方向只对那一条有效：收掉就清掉。
    oneShotSide = null;
    // 气泡收走了，**卡片不作废**：用户没点过按钮，
    // 那不能记成「用户拒绝」——任务界面仍然能答复它。
    shownCardId = '';
    setInteractive(false);
    if (!win || win.isDestroyed()) return;
    send('pet:bubbleHide');
    win.hide();
  }

  /**
   * 气泡能不能点。
   *
   * 普通气泡永远**点击穿透**（Windows 没有逐像素命中测试，
   * 整个窗口矩形都是热区——气泡吃了桌面点击，用户会以为桌面坏了）。
   * 审批气泡是唯一例外：它有按钮要让人点。
   */
  function setInteractive(on) {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!on, { forward: true });
    // **不**把窗口变成可聚焦的：桌宠是背景程序。
    // 用户点一下「允许」就把键盘焦点抢走，手上的活儿全断了——
    // 按钮靠鼠标点就够了（回车激活不了，但气泡本来就不是键盘界面）。
  }

  /** 队头那张卡片（先进先出）。 */
  function headCard() {
    return asks.list()[0] || null;
  }

  /**
   * 把队头那张卡片摆到气泡上。
   *
   * **只摆一张**：后来的排在后面，不打断已经显示着的那张。
   * 流还占着气泡时也不摆——卡片让位，流结束后它自己回来。
   */
  function showHeadCard() {
    if (shownCardId) return;
    const head = headCard();
    if (!head) return;
    if (streamId) return;
    if (!win || win.isDestroyed() || !ready) return;
    shownCardId = head.id;
    setInteractive(true);
    currentMessage = { kind: head.kind, text: head.text || head.question, emotion: '' };
    send('pet:bubbleCard', {
      id: head.id,
      kind: head.kind,
      title: head.title,
      text: head.text,
      question: head.question,
      options: head.options,
      risk: head.risk,
    });
  }

  /**
   * 卡片给流让位。
   *
   * **不作废**：它还在队列里，流结束后自己回来，
   * 期间也能在任务界面答复它。
   */
  function yieldCard() {
    if (!shownCardId) return;
    shownCardId = '';
    setInteractive(false);
  }

  /**
   * 答复一张卡片（气泡上的按钮与任务界面共用这一条路）。
   *
   * **谁先答谁算数**：后答的那个拿到「这个已经答复过了」，状态一点不动。
   *
   * @param {object} payload { id, answer }
   * @returns {{ok: boolean, message: string}}
   */
  function answerCard({ id, answer } = {}) {
    const res = asks.respond({ id, answer });
    if (!res.ok) return res;
    // 气泡上摆着的就是它：这张卡收走。
    if (shownCardId === String(id || '')) {
      send('pet:bubbleCardDone', { id: shownCardId });
      shownCardId = '';
      setInteractive(false);
    }
    // 还有排队的：换下一张卡。
    if (asks.pending() > 0) {
      showHeadCard();
      return res;
    }
    // 没有排队的了：气泡收起来，排队的普通消息放出来。
    hide();
    while (deferred.length > 0) deliver(deferred.shift());
    return res;
  }

  /**
   * 挂一张卡片，等用户回话。
   *
   * 与普通气泡有两点不同：
   * 1. **不自动消失**：它一直挂着等用户点（规格 §8.2）。
   *    `ttlMs: 0` 表达不了这个——`scheduleHide` 会把它退回默认 TTL，
   *    所以这里干脆**不装计时器**（sticky 是结构上的，不是靠一个魔数）。
   * 2. **能点**：普通气泡永远点击穿透，卡片是唯一例外。
   *
   * **可以同时挂着好几张**：后来的排在后面，
   * 不打断已经显示出来的那张（那张答完了它才上来）。
   *
   * @returns {Promise<string>} 用户的答复
   */
  function showCard(request) {
    const promise = asks.request(request);
    if (!win || win.isDestroyed()) {
      createWindow();
      pending.push({ type: 'card' });
      return promise;
    }
    if (!ready) {
      pending.push({ type: 'card' });
      return promise;
    }
    // 气泡上已经有卡片了：新来的排队，不动它。
    if (shownCardId) return promise;
    // 卡片是**阻塞**的：它卡在任务的关键路径上，
    // 别的消息排后面（用户得先回话，任务才能继续）。
    //
    // **撤流时不装计时器**：撤流会把排队的消息放出来，
    // 那条消息会顺手装一个「几秒后收掉气泡」的计时器——
    // 留着它，卡片自己就消失了：用户还没点，任务先被判成拒绝。
    if (streamId) cancelStream({ hide: false });
    // 计时器要**最后**清：上面的撤流可能又装了一个。
    clearTimer();
    showHeadCard();
    return promise;
  }

  /**
   * 显示一条**要用户点头**的消息（审批卡）。
   *
   * @returns {Promise<'allow'|'deny'|'always'|'cancel'>} 用户的答复
   */
  function showApproval({ id = '', taskId = '', title = '', text = '', risk = '' } = {}) {
    const key = String(id || `approval-${++approvalSeq}`);
    return showCard({
      id: key,
      kind: MESSAGE_KIND.APPROVAL,
      taskId,
      title,
      text,
      risk,
    });
  }

  /**
   * 显示一条**要用户选**的消息（选择卡）。
   *
   * 后台任务拿不准用户想要什么的时候用它问一句：
   * 用户在气泡里点一个选项，任务就知道该往哪边走了。
   *
   * @returns {Promise<string>} 用户选中的那个选项（没人回答时是空串）
   */
  function showChoice({ id = '', taskId = '', title = '', question = '', options = [] } = {}) {
    const key = String(id || `choice-${++choiceSeq}`);
    return showCard({
      id: key,
      kind: MESSAGE_KIND.CHOICE,
      taskId,
      title,
      question,
      options,
    });
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
      // 摆位偏好（'top'/'bottom'/'left'/'right'）：不给就按默认顺序摆。
      side: message?.side || '',
      // **「打断」的意图要一起带进队列**：页面还没就绪时消息是排队的，
      // 等页面就绪了才按同一套规矩来判断——不带这个标记，
      // 「提醒、闹钟可以插队」的规矩就丢了。
      interrupt: Boolean(message?.interrupt),
      // **常驻**：不自动消失，等用户自己看完（或下一条消息把它顶掉）。
      sticky: Boolean(message?.sticky),
    };

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
    if (streamId && message?.interrupt) cancelStream();
    // 审批气泡挂着的时候，普通消息**排队**：
    // 审批是阻塞的，用户正在做决定——
    // 这时候把气泡顶掉，用户点不到按钮，任务就一直卡着。
    if (asks.pending() > 0) {
      deferred.push(payload);
      return;
    }
    // 该让着就让着（流还在写、或者聊天回复正占着气泡）。
    if (shouldWaitBehind(payload)) {
      deferred.push(payload);
      return;
    }
    currentMessage = payload;
    deliver(payload);
  }

  /**
   * 这条消息现在该不该排队。
   *
   * **页面没就绪时也要用同一套规矩**：页面就绪后补发的消息，
   * 如果直接盖上去，刚说完的回复正文就没了——
   * 用户只看到后来说的那句，前一句像是从来没出现过。
   * （回复的定稿是补发的最后一步，被盖掉就再也补不回来。）
   */
  function shouldWaitBehind(payload) {
    // 卡片还挂着：消息排队等一等（卡片是阻塞的）。
    // 这条主要是给「页面就绪后补发」那条路用的——
    // 那时候卡片刚摆上来，消息不能把它顶掉。
    if (asks.pending() > 0) return true;
    // 带 interrupt 的（提醒、闹钟）可以插队。
    if (payload?.interrupt) return false;
    // 流还在写：不要打断半句话。
    if (streamId) return true;
    // 聊天回复正占着气泡：等用户读完。
    return currentMessage?.kind === MESSAGE_KIND.CHAT;
  }

  function deliver(payload) {
    clearTimer();
    // 摆位用的方向跟着这条消息走：页面报尺寸时会用到它。
    oneShotSide = payload?.side || null;
    send('pet:bubbleShow', payload);
    // **常驻的消息不装计时器**：它可能等用户回来才看得到——
    // 六秒就没了的结果，等于没送到。
    if (payload?.sticky) return;
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
    // 流要占住气泡了：卡片**暂时让位**——
    // 它不作废，还在队列里，流结束后自己回来（期间能在任务界面答复）。
    yieldCard();
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
    // **卡片还挂着的时候继续等**：卡片是阻塞的，
    // 用户得先回话，消息才能上来（见 shouldWaitBehind）。
    if (asks.pending() === 0) {
      while (deferred.length > 0) deliver(deferred.shift());
    }
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
      icon: appIconPath(rootDir),
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
      else if (item.type === 'card') {
        // 卡片：**不装计时器**（它要一直挂着等用户回话）。
        showHeadCard();
      } else if (shouldWaitBehind(item.payload)) {
        // 跟 show() 一个规矩：聊天回复正占着气泡时，这条消息排队。
        // 不排队的话，它会盖掉刚说完的回复——
        // 而回复的定稿是**补发的最后一步**，被盖掉就再也补不回来。
        deferred.push(item.payload);
      } else deliver(item.payload);
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
  // `interactive` 只在**卡片**挂着时为 true：普通气泡永远点击穿透。
  // 它留在这里是为了让「气泡不挡桌面」这件事有个可断言的出口——
  // Electron 只有 setIgnoreMouseEvents（setter），没有对应的 getter。
  ipcMain.handle('pet:bubbleState', (event) => {
    if (!win || event.sender !== win.webContents) return null;
    return {
      kind: currentMessage?.kind || '',
      interactive: Boolean(shownCardId),
      visible: win.isVisible(),
    };
  });

  // 用户在卡片上点了按钮。
  //
  // **按 id 认**：两个任务同时要回话时，
  // 第二个的答复不能把第一个的搞混（见 bubbleAsk.js）。
  //
  // 走的是与任务界面**同一条**答复路：谁先答谁算数。
  ipcMain.on('pet:bubbleCardResponse', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    answerCard(payload || {});
  });

  return {
    show,
    hide,
    /**
     * 显示审批卡，等用户点头。
     *
     * @returns {Promise<'allow'|'deny'|'always'|'cancel'>}
     */
    showApproval,
    /**
     * 显示选择卡，等用户挑一个。
     *
     * @returns {Promise<string>} 用户选中的那个选项
     */
    showChoice,
    /**
     * 现在等着用户回话的卡片（排队顺序）。
     *
     * @returns {Array<{id: string, kind: string, taskId: string, title: string, text: string, risk: string, question: string, options: string[]}>}
     */
    pendingCards: () => asks.list(),
    /**
     * 现在等着用户点头的审批（排队顺序）。
     *
     * @returns {Array<{id: string, taskId: string, title: string, text: string, risk: string}>}
     */
    pendingApprovals: () => asks.list(MESSAGE_KIND.APPROVAL),
    /**
     * 答复一张卡片：谁先答谁算数。
     *
     * @returns {{ok: boolean, message: string}}
     */
    answerCard: (payload) => answerCard(payload),
    /**
     * 答复一个审批：谁先答谁算数。
     *
     * @returns {{ok: boolean, message: string}}
     */
    answerApproval: (payload) => answerCard({ id: payload?.id, answer: payload?.decision }),
    openStream,
    appendStream,
    endStream,
    cancelStream,
    /** 桌宠窗口移动后重新摆位。 */
    reposition: () => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const placement = place();
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
    /**
     * 桌宠重新出现了：挂着的卡片要重新摆出来。
     *
     * 桌宠藏着的时候卡片被一起收走了——用户没看见那个问题，
     * 等他的后台任务就一直卡着。
     */
    onPetVisible: () => {
      if (asks.pending() > 0) showHeadCard();
    },
    destroy: () => {
      clearTimer();
      // 挂着的卡片要有交代：否则等它的任务永远醒不过来。
      asks.clear();
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
