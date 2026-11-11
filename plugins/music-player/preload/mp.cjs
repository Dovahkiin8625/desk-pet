// plugins/music-player/preload/mp.cjs
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 插件自己的窗口与主进程之间的话。
 *
 * 通道名带插件 id：用户要是装了第二个音乐插件，两个插件的通道不会打架。
 *
 * 页面只拿到「发一句话」与「收一句话」两件事——
 * ipcRenderer 本体不该给页面（那等于把主进程的门开着）。
 */
const CHANNEL = 'mp:music-player:message';

contextBridge.exposeInMainWorld('mp', {
  /** 给主进程发一句话。 */
  send: (message) => ipcRenderer.send(CHANNEL, message),
  /** 收主进程的话。 */
  onMessage: (callback) => {
    ipcRenderer.on(CHANNEL, (_event, message) => callback(message));
  },
});
