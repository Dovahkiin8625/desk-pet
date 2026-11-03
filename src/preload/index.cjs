const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 白名单 API：只暴露渲染层真正需要的能力，其余一律不开放。
// Task 8 会追加 moveWindowBy，Task 9 会追加 onSettingsChanged。
contextBridge.exposeInMainWorld('pet', {
  getSettings: () => ipcRenderer.invoke('pet:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('pet:saveSettings', patch),
  listModels: () => ipcRenderer.invoke('pet:listModels'),
  switchModel: (id) => ipcRenderer.invoke('pet:switchModel', id),
  showContextMenu: () => ipcRenderer.invoke('pet:showContextMenu'),
  openSettings: () => ipcRenderer.invoke('pet:openSettings'),
  // 弹出插件面板：左键点桌宠时走这条路。
  openPanel: () => ipcRenderer.invoke('pet:openPanel'),
  // 增量移动窗口：传的是「相对上一次的位移」，不是绝对坐标。
  // 绝对坐标在混合 DPI / 多显示器下会漂移，累加增量才不会。
  moveWindowBy: (dx, dy) => ipcRenderer.invoke('pet:moveWindowBy', { dx, dy }),
  // 新一次拖拽开始：主进程据此把期望位置重新对齐到当前窗口位置。
  dragStart: () => ipcRenderer.invoke('pet:dragStart'),
  // 拖拽结束：主进程清掉累加器，不依赖 dragStart 一定送达。
  dragEnd: () => ipcRenderer.invoke('pet:dragEnd'),
  onModelSwitchRequest: (cb) => {
    ipcRenderer.on('pet:modelSwitchRequest', (_e, payload) => {
      // 载荷是 { requestId, modelId }：requestId 用来把渲染层的回执
      // 匹配回主进程那一次具体的请求（并发切换时不能串台）。
      cb(payload?.modelId, payload?.requestId);
    });
  },
  // 渲染层就绪信号：主进程在这之前发出的推送频道会被丢弃
  // （webContents.send 对尚未注册监听器的页面是丢弃，不是排队）。
  reportRendererReady: () => ipcRenderer.send('pet:rendererReady'),
  // 切换结果回执：主进程据此决定「落盘哪个 id」以及「要不要提示失败」。
  reportModelSwitchResult: (result) => ipcRenderer.send('pet:modelSwitchResult', result),
  // 模型加载失败（启动阶段）：必须让主进程知道，否则用户在终端里看不到任何线索。
  reportModelError: (info) => ipcRenderer.send('pet:modelError', info),
  // 设置变化广播：主进程在设置落盘前就把新设置推给渲染层，
  // 宠物窗口据此立刻重新适配缩放，设置窗口据此同步控件。
  onSettingsChanged: (cb) => {
    ipcRenderer.on('pet:settingsChanged', (_e, s) => cb(s));
  },
  // 光标位置（窗口内坐标）：主进程轮询系统光标发过来，
  // 让桌宠在鼠标不在它身上时也看着鼠标。
  onCursorPoint: (cb) => {
    ipcRenderer.on('pet:cursorPoint', (_e, p) => cb(p));
  },
  // —— 桌面助理 ——
  // 情绪事件：主进程那边发生了「提醒到了」「任务完成」之类的事，
  // 渲染层据此换表情。第二个参数是心情值的增量（没有就是 0）。
  onEmotion: (cb) => {
    ipcRenderer.on('pet:emotion', (_e, payload) =>
      cb(payload?.emotion, typeof payload?.mood === 'number' ? payload.mood : 0)
    );
  },
  // 合成好的语音：主进程合成完发过来，渲染层播放并驱动口型。
  onSpeak: (cb) => {
    ipcRenderer.on('pet:speak', (_e, payload) => cb(payload?.audio, payload?.mime));
  },
  // 提示音：待办完成、提醒响起之类的界面反馈。
  onSound: (cb) => {
    ipcRenderer.on('pet:sound', (_e, payload) => cb(payload?.name));
  },
  // 音效总开关（设置窗口改的）。
  onSoundEnabled: (cb) => {
    ipcRenderer.on('pet:soundEnabled', (_e, payload) => cb(payload?.enabled !== false));
  },
  // 文件拖放：Electron 32 起 File.path 已被移除，
  // 真实的路径要用 webUtils.getPathForFile 从 File 对象里取
  // （它只能在 preload 里调，所以由 preload 代劳）。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  // 报告「有文件被拖到桌宠身上」。
  reportDroppedFile: (filePath) => ipcRenderer.send('pet:droppedFile', filePath),
  // —— 设置窗口用的助理接口 ——
  // 助理状态：设置窗口用它显示与修改偏好（待办/提醒在插件面板里管）。
  getAssistantState: () => ipcRenderer.invoke('pet:getAssistantState'),
  saveAssistantPrefs: (patch) => ipcRenderer.invoke('pet:saveAssistantPrefs', patch),
  // 语音状态：只回掩码，**绝不回明文 key**。
  getTtsStatus: () => ipcRenderer.invoke('pet:getTtsStatus'),
  setTtsApiKey: (key) => ipcRenderer.invoke('pet:setTtsApiKey', key),
  // 对话（LLM）的 key：留空表示沿用 MiniMax 的那个。
  getLlmStatus: () => ipcRenderer.invoke('pet:getLlmStatus'),
  setLlmApiKey: (key) => ipcRenderer.invoke('pet:setLlmApiKey', key),
});
