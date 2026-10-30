const { contextBridge, ipcRenderer } = require('electron');

// 白名单 API：只暴露渲染层真正需要的能力，其余一律不开放。
// Task 8 会追加 moveWindowBy，Task 9 会追加 onSettingsChanged。
contextBridge.exposeInMainWorld('pet', {
  getSettings: () => ipcRenderer.invoke('pet:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('pet:saveSettings', patch),
  listModels: () => ipcRenderer.invoke('pet:listModels'),
  switchModel: (id) => ipcRenderer.invoke('pet:switchModel', id),
  showContextMenu: () => ipcRenderer.invoke('pet:showContextMenu'),
  openSettings: () => ipcRenderer.invoke('pet:openSettings'),
  // 增量移动窗口：传的是「相对上一次的位移」，不是绝对坐标。
  // 绝对坐标在混合 DPI / 多显示器下会漂移，累加增量才不会。
  moveWindowBy: (dx, dy) => ipcRenderer.invoke('pet:moveWindowBy', { dx, dy }),
  // 新一次拖拽开始：主进程据此把期望位置重新对齐到当前窗口位置。
  dragStart: () => ipcRenderer.invoke('pet:dragStart'),
  // 拖拽结束：主进程清掉累加器，不依赖 dragStart 一定送达。
  dragEnd: () => ipcRenderer.invoke('pet:dragEnd'),
  onModelSwitchRequest: (cb) => {
    ipcRenderer.on('pet:modelSwitchRequest', (_e, modelId) => cb(modelId));
  },
  // 设置变化广播：主进程在设置落盘前就把新设置推给渲染层，
  // 宠物窗口据此立刻重新适配缩放，设置窗口据此同步控件。
  onSettingsChanged: (cb) => {
    ipcRenderer.on('pet:settingsChanged', (_e, s) => cb(s));
  },
});
