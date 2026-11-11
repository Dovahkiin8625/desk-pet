// plugins/music-player/lib/lyrics-window.js
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

/** 与 preload/mp.cjs 约定的通道。 */
const CHANNEL = 'mp:music-player:message';

/**
 * 桌面歌词：一个透明的小浮窗，一直浮在桌面上。
 *
 * 宿主那套「一个插件一个窗口」用不上：歌词窗要和小部件同时开着，
 * 所以它自己开窗口、自己管。
 */
export function createLyricsWindow({ pluginDir, preloadPath, onCommand, onClose }) {
  let win = null;

  /** 摆在屏幕底部中间——歌词窗是浮在桌面上的东西，不是窗口。 */
  function place() {
    if (!win || win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const [width, height] = win.getSize();
    win.setPosition(
      Math.round(area.x + (area.width - width) / 2),
      Math.round(area.y + area.height - height - 40),
    );
  }

  function open() {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      return;
    }
    win = new BrowserWindow({
      width: 560,
      height: 170,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // 歌词窗不是「一个应用窗口」，别进任务栏。
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.on('closed', () => {
      win = null;
      onClose?.();
    });
    win.loadFile(join(pluginDir, 'pages', 'lyrics.html')).then(
      () => {
        if (!win || win.isDestroyed()) return;
        place();
        // 显示时不抢焦点：用户正在写东西呢。
        win.showInactive();
      },
      () => {},
    );
  }

  function close() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return {
    open,
    close,
    isOpen: () => Boolean(win && !win.isDestroyed()),

    /** 把一份歌词状态推给窗口。 */
    send(payload) {
      if (!win || win.isDestroyed()) return;
      win.webContents.send(CHANNEL, { role: 'lyrics', type: 'state', ...payload });
    },

    /** 歌词页发来的一句话。 */
    handleMessage(message) {
      if (message?.role !== 'lyrics') return;
      if (message.type === 'close') {
        close();
        return;
      }
      onCommand?.(message);
    },
  };
}
