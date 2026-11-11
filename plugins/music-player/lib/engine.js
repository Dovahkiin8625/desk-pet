// plugins/music-player/lib/engine.js
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 与 preload/mp.cjs 约定的通道。 */
const CHANNEL = 'mp:music-player:message';

/**
 * 播放引擎：一个**藏起来**的窗口，里面就一个 `<audio>`。
 *
 * 主进程放不出声音，音频得由渲染层放——
 * 而这个窗口不能是面板或小部件：它们随时会被关掉，音乐得一直放。
 */
export function createEngine({ pluginDir, preloadPath, onEvent }) {
  let win = null;
  let ready = false;
  /** 引擎就绪之前的命令：先攒着，就绪了再一股脑儿发过去。 */
  const pending = [];

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 藏起来的窗口会被节流：音乐要一直放着，时钟不能停。
        backgroundThrottling: false,
      },
    });
    win.on('closed', () => {
      win = null;
      ready = false;
    });
    win.loadFile(join(pluginDir, 'pages', 'engine.html'));
    return win;
  }

  function send(cmd) {
    ensure();
    if (!ready) {
      pending.push(cmd);
      return;
    }
    win.webContents.send(CHANNEL, { role: 'engine', type: 'cmd', ...cmd });
  }

  return {
    /** 引擎页面发来的一句话。 */
    handleMessage(message) {
      if (message?.type === 'ready') {
        ready = true;
        while (pending.length) {
          const cmd = pending.shift();
          win?.webContents.send(CHANNEL, { role: 'engine', type: 'cmd', ...cmd });
        }
        return;
      }
      onEvent?.(message);
    },

    /** 装上要放的那首歌。 */
    load(file) {
      send({ cmd: 'load', url: pathToFileURL(file).href });
    },
    play() {
      send({ cmd: 'play' });
    },
    pause() {
      send({ cmd: 'pause' });
    },
    seek(seconds) {
      send({ cmd: 'seek', seconds });
    },
    volume(value) {
      send({ cmd: 'volume', value });
    },

    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      ready = false;
      pending.length = 0;
    },
  };
}
