// plugins/screen-recorder/lib/windows.js
import { BrowserWindow, webContents } from 'electron';
import { join } from 'node:path';

/**
 * 插件自建的几个窗口。
 *
 * 不用宿主那套「一个插件一个窗口、window 与 widget 互斥」的机制：
 * 工作台与控制条要**同时开着**（录着屏还得能改设置）。
 *
 * 页面用 file:// 加载：file:// 在 Chromium 里是 secure context，
 * navigator.mediaDevices 才能用（已实测）。
 */
export function createWindows({ pluginDir, preloadPath, onWorkbenchChanged }) {
  /** webContents.id → 窗口的角色。 */
  const roles = new Map();
  const windows = { capture: null, picker: null, control: null, workbench: null };
  /** 遮罩选完之后的回调（谁在等这块区域）。 */
  let pickerResolve = null;

  function track(win, role) {
    // **webContents.id 要提前存下来**：窗口销毁之后再读
    // `win.webContents` 会把主进程整个冻住（读一个已销毁对象的属性，
    // 轻则抛错、重则卡死）。宿主也有同样的坑，见 src/main/plugins/window.js。
    const contentsId = win.webContents.id;
    roles.set(contentsId, role);
    win.on('closed', () => {
      roles.delete(contentsId);
    });
    return win;
  }

  /**
   * 窗口关了之后把它从记录里去掉。
   *
   * **要认一下是不是当前那个**：关窗是异步的，旧窗口的 'closed' 事件
   * 可能在新窗口建好之后才到——不认一下的话，新窗口的引用会被旧窗口
   * 的回调清掉，下一段录制就停不下来了。
   */
  function forget(key, win) {
    if (windows[key] === win) windows[key] = null;
  }

  /** 捕获页：隐藏着，真正干活的地方。 */
  function createCapture() {
    if (windows.capture && !windows.capture.isDestroyed()) return windows.capture;
    const win = new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      webPreferences: {
        // 独立的 session 分区：displayMedia 的 handler 装在这里，
        // 不会影响桌宠本体的 defaultSession。
        partition: 'persist:screen-recorder',
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 隐藏窗口的定时器会被节流，录制靠它逐帧取像——必须关掉节流。
        backgroundThrottling: false,
      },
    });
    win.on('closed', () => {
      forget('capture', win);
    });
    win.loadFile(join(pluginDir, 'pages', 'recorder.html'));
    windows.capture = track(win, 'capture');
    return win;
  }

  function destroyCapture() {
    // **close() 而不是 destroy()**：destroy() 是硬拆窗口，
    // 窗口里的屏幕捕获会话还没松手，硬拆会把主进程堵住一两分钟
    // （实测：录完屏之后点桌宠弹面板要等 180 秒）。
    // close() 先让渲染进程自己收尾（页面会停掉轨道），拆得干净。
    if (windows.capture && !windows.capture.isDestroyed()) windows.capture.close();
    windows.capture = null;
  }

  /**
   * 开遮罩：铺满一块显示器，等用户框一块区域。
   *
   * 遮罩是**独立窗口**而不是画在桌宠上：它要盖住整块屏幕，
   * 并且始终置顶（'screen-saver' 这一档比 'floating' 更靠前）。
   *
   * @returns {Promise<{crop:object,snapshotSize:object}|null>} 用户框的区域；取消就是 null
   */
  function openPicker({ display, image, snapshotSize }) {
    return new Promise((resolve) => {
      if (windows.picker && !windows.picker.isDestroyed()) windows.picker.destroy();
      pickerResolve = resolve;
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
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
      win.setAlwaysOnTop(true, 'screen-saver');
      windows.picker = track(win, 'picker');
      win.on('closed', () => {
        forget('picker', win);
        resolvePicker(null); // 窗口被直接关掉 = 用户放弃了
      });
      win.webContents.on('did-finish-load', () => {
        win.webContents.send('rec:screen-recorder:message', {
          type: 'picker',
          payload: { image, snapshotSize },
        });
      });
      win.loadFile(join(pluginDir, 'pages', 'picker.html'));
    });
  }

  /** 遮罩选完了：把结果交给等它的人。 */
  function resolvePicker(result) {    const resolve = pickerResolve;
    pickerResolve = null;
    if (resolve) resolve(result);
  }

  /** 把遮罩关掉（框完就关，别让它留在屏幕上）。 */
  function closePicker() {
    if (windows.picker && !windows.picker.isDestroyed()) windows.picker.destroy();
    windows.picker = null;
  }

  /** 给某个角色的窗口发消息。 */
  function sendTo(role, message) {
    for (const [contentsId, r] of roles) {
      if (r !== role) continue;
      const contents = webContents.fromId(contentsId);
      if (contents && !contents.isDestroyed()) {
        contents.send('rec:screen-recorder:message', message);
      }
    }
  }

  /** 控制条：置顶的小浮窗。 */
  function showControl() {
    if (windows.control && !windows.control.isDestroyed()) {
      windows.control.focus();
      return windows.control;
    }
    const win = new BrowserWindow({
      width: 240,
      height: 64,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
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
    win.loadFile(join(pluginDir, 'pages', 'control.html'));
    windows.control = track(win, 'control');
    win.on('closed', () => {
      forget('control', win);
    });
    return win;
  }

  function hideControl() {
    if (windows.control && !windows.control.isDestroyed()) windows.control.destroy();
    windows.control = null;
  }

  /** 工作台：设置与快捷键。 */
  function openWorkbench() {
    if (windows.workbench && !windows.workbench.isDestroyed()) {
      windows.workbench.focus();
      return windows.workbench;
    }
    const win = new BrowserWindow({
      width: 460,
      height: 560,
      title: '录屏设置',
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.on('closed', () => {
      forget('workbench', win);
      onWorkbenchChanged?.(false);
    });
    win.loadFile(join(pluginDir, 'pages', 'workbench.html'));
    windows.workbench = track(win, 'workbench');
    // **等页面加载完再通知**：页面加载完才会挂上消息监听，
    // 通知早了它就听不见（快捷键也就没注册上）。
    win.webContents.on('did-finish-load', () => {
      onWorkbenchChanged?.(true);
    });
    return win;
  }

  function closeWorkbench() {
    if (windows.workbench && !windows.workbench.isDestroyed()) windows.workbench.destroy();
    windows.workbench = null;
    onWorkbenchChanged?.(false);
  }

  function isWorkbenchOpen() {
    return Boolean(windows.workbench && !windows.workbench.isDestroyed());
  }

  /**
   * 退出前把窗口全拆掉。
   *
   * Electron 正常的 app.quit() 流程遇到还有窗口活着会**卡住**——
   * 宿主的 destroyAll() 就是为这个存在的（见 src/main/plugins/window.js）。
   */
  function destroyAll() {
    for (const key of Object.keys(windows)) {
      const win = windows[key];
      if (win && !win.isDestroyed()) win.destroy();
      windows[key] = null;
    }
    roles.clear();
  }

  return {
    createCapture,
    destroyCapture,
    captureWindow: () => windows.capture,
    openPicker,
    resolvePicker,
    closePicker,
    sendTo,
    showControl,
    hideControl,
    openWorkbench,
    closeWorkbench,
    isWorkbenchOpen,
    destroyAll,
    roleOf: (contentsId) => roles.get(contentsId) || '',
  };
}
