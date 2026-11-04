// plugins/screen-recorder/lib/ipc.js
import { ipcMain } from 'electron';

const CHANNEL = 'rec:screen-recorder:message';

/**
 * 注册插件自己的 IPC。
 *
 * 通道名带插件 id：用户要是装了第二个录屏插件，两个插件的通道不会打架。
 *
 * @param {(message: object, event: object) => any} handler
 * @returns {() => void} 注销函数
 */
export function registerIpc(handler) {
  ipcMain.on(CHANNEL, (event, message) => {
    try {
      handler(message, event);
    } catch (err) {
      console.warn('[录屏] IPC 处理出错：', err?.message);
    }
  });
  ipcMain.handle(CHANNEL, async (event, message) => {
    try {
      return await handler(message, event);
    } catch (err) {
      console.warn('[录屏] IPC 处理出错：', err?.message);
      return { ok: false, message: err?.message || String(err) };
    }
  });
  return () => {
    ipcMain.removeHandler(CHANNEL);
    ipcMain.removeAllListeners(CHANNEL);
  };
}

export { CHANNEL };
