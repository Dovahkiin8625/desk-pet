const { contextBridge, ipcRenderer } = require('electron');

/**
 * 气泡窗口**专用**的 preload。
 *
 * 为什么不给它复用 src/preload/index.cjs：那份是宠物窗口与设置窗口共用的，
 * 上面挂着 moveWindowBy / switchModel / saveSettings 这些能力。
 * 气泡窗口只需要「显示什么」和「用户按了什么」，
 * 多给它一份能力就多一份攻击面——它跟主进程之间还隔着 IPC。
 */
contextBridge.exposeInMainWorld('bubble', {
  // 主进程要显示一条消息。
  onShow: (cb) => {
    ipcRenderer.on('pet:bubbleShow', (_e, message) => cb(message));
  },
  // 主进程要把气泡收起来（自动消失、桌宠被藏起来了）。
  onHide: (cb) => {
    ipcRenderer.on('pet:bubbleHide', () => cb());
  },
  // 气泡摆在了桌宠的哪一侧：页面据此决定小尾巴朝哪边指。
  onPlacement: (cb) => {
    ipcRenderer.on('pet:bubblePlacement', (_e, placement) => cb(placement));
  },
  // —— 流式消息（AI 对话的回复）——
  // 开一个空壳。
  onStreamOpen: (cb) => {
    ipcRenderer.on('pet:bubbleStreamOpen', (_e, payload) => cb(payload));
  },
  // 追加一段增量。
  onDelta: (cb) => {
    ipcRenderer.on('pet:bubbleDelta', (_e, payload) => cb(payload));
  },
  // 定稿。
  onStreamEnd: (cb) => {
    ipcRenderer.on('pet:bubbleStreamEnd', (_e, payload) => cb(payload));
  },
  // 流被作废（出错或被打断）。
  onStreamCancel: (cb) => {
    ipcRenderer.on('pet:bubbleStreamCancel', (_e, payload) => cb(payload));
  },
  // 页面注册好监听器了：主进程在这之前发来的消息会被丢弃，
  // 所以要先报到，再让主进程把排队等着消息补发过来。
  reportReady: () => ipcRenderer.send('pet:bubbleReady'),
  // 内容画完之后把尺寸报回去：窗口要按内容撑开，
  // 不然长文本会被截断、短文本会留一大块空白。
  reportSize: (size) => ipcRenderer.send('pet:bubbleSize', size),
  // 气泡当前的状态（形态、是否可交互、是否可见）。
  getState: () => ipcRenderer.invoke('pet:bubbleState'),
});
