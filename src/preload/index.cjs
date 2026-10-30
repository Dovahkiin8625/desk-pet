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
  onModelSwitchRequest: (cb) => {
    ipcRenderer.on('pet:modelSwitchRequest', (_e, modelId) => cb(modelId));
  },
});
