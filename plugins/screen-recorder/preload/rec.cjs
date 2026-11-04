// plugins/screen-recorder/preload/rec.cjs
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 插件页面的桥。
 *
 * 只暴露「发消息给主进程」和「收主进程的消息」两件事——
 * 页面不该拿到 ipcRenderer 本体（那等于把主进程的门开着）。
 */
contextBridge.exposeInMainWorld('rec', {
  send: (message) => ipcRenderer.send('rec:screen-recorder:message', message),
  invoke: (message) => ipcRenderer.invoke('rec:screen-recorder:message', message),
  onMessage: (callback) => {
    ipcRenderer.on('rec:screen-recorder:message', (_event, message) => callback(message));
  },
});
