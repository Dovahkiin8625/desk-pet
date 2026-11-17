// plugins/screenshot/preload/shot.cjs
const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'shot:screenshot:message';

/**
 * 插件自己的窗口（遮罩、工具条、结果窗、置顶窗）用的桥。
 *
 * 只暴露「发消息给主进程」和「收主进程的消息」——
 * 页面不该拿到 ipcRenderer 本体（那等于把主进程的门开着）。
 */
contextBridge.exposeInMainWorld('shot', {
  send: (message) => ipcRenderer.send(CHANNEL, message),
  onMessage: (callback) => {
    ipcRenderer.on(CHANNEL, (_event, message) => callback(message));
  },
});
