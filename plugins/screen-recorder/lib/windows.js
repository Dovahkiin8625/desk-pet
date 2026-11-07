// plugins/screen-recorder/lib/windows.js
import { BrowserWindow, webContents } from 'electron';
import { join } from 'node:path';

/**
 * 插件自建的几个窗口。
 *
 * 不用宿主那套「一个插件一个窗口、window 与 widget 互斥」的机制：
 * 录着屏的时候还得能改设置、控制条也得一直挂在桌面上。
 *
 * 页面用 file:// 加载：file:// 在 Chromium 里是 secure context，
 * navigator.mediaDevices 才能用（已实测）。
 */
export function createWindows({ pluginDir, preloadPath }) {
  /** webContents.id → 窗口的角色。 */
  const roles = new Map();
  const windows = { capture: null, picker: null, frame: null, control: null };
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
   * **窗口是透明的**：底下就是真实的桌面，用户框到哪里，
   * 看到的就是录下来会是什么——不要一张会过期的截图，更不要一层暗色。
   *
   * @param {object} display 要框的那块显示器
   * @returns {Promise<{rect:object,viewport:object}|null>} 用户框的区域（DIP）；取消就是 null
   */
  function openPicker({ display }) {
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
      /*
       * **建成之后再设一次尺寸**。
       *
       * 新建窗口时 Windows 会把尺寸夹到**工作区**（任务栏以外的那块）：
       * 实测 2560×1440 的屏幕上，窗口只有 1392 高——差的那 48 像素
       * 正好是任务栏，于是遮罩盖不到任务栏，用户框不到最下面一条。
       *
       * 建成之后再 `setBounds` 就不会被夹（新建走的是「按工作区限大小」那条路，
       * 之后改尺寸走的是另一条）。这一下就是任务栏那一截的差别。
       */
      win.setBounds({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      });
      windows.picker = track(win, 'picker');
      win.on('closed', () => {
        forget('picker', win);
        resolvePicker(null); // 窗口被直接关掉 = 用户放弃了
      });
      win.loadFile(join(pluginDir, 'pages', 'picker.html'));
    });
  }

  /** 遮罩选完了：把结果交给等它的人。 */
  function resolvePicker(result) {
    const resolve = pickerResolve;
    pickerResolve = null;
    if (resolve) resolve(result);
  }

  /** 把遮罩关掉（框完就关，别让它留在屏幕上）。 */
  function closePicker() {
    if (windows.picker && !windows.picker.isDestroyed()) windows.picker.destroy();
    windows.picker = null;
  }

  /**
   * 选区边框：框完选区之后，留在桌面上直到录制结束。
   *
   * 三个讲究：
   *
   * 1. **边框画在选区外面**（窗口比选区大一圈，边框正好占那一圈）。
   *    画在里面的话，这圈线会被录进画面——录出来的视频边上多一道杠。
   * 2. **鼠标点不到它**（setIgnoreMouseEvents）：录制的时候用户还要
   *    用电脑，这块玻璃不能把点击都吃了。
   * 3. **不抢焦点**（focusable: false）：录制的时候别把用户正在写的
   *    窗口挤到后面去。
   *
   * @param {object} display 选区所在的那块显示器
   * @param {object} rect 选区（DIP，相对显示器的左上角）
   */
  function showRegionFrame({ display, rect }) {
    closeRegionFrame();
    // 边框的厚度（ DIP）。窗口比选区大出这么一圈，
    // 边框就正好落在选区外面。
    const pad = 2;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const win = new BrowserWindow({
      x: Math.round(display.bounds.x + rect.x - pad),
      y: Math.round(display.bounds.y + rect.y - pad),
      width: width + pad * 2,
      height: height + pad * 2,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 录制的时候别把焦点抢走。
      focusable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // **点击要穿过去**：录制的时候用户照常用电脑，
    // 这块玻璃不能把点击都吃了。
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(join(pluginDir, 'pages', 'region-frame.html'));
    windows.frame = track(win, 'frame');
    win.on('closed', () => {
      forget('frame', win);
    });
  }

  /** 选区边框：录制结束就撤掉。 */
  function closeRegionFrame() {
    if (windows.frame && !windows.frame.isDestroyed()) windows.frame.destroy();
    windows.frame = null;
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

  /**
   * 控制条：置顶的小浮窗。
   *
   * **显示时不抢焦点**（showInactive）：控制条是录着的时候冒出来的东西，
   * 用户正在写文档呢，它一抢焦点，别的窗口就被挤到后面去了。
   *
   * 在面板里尤其要命：面板失焦会**自己收起来**，界面落点一摘，
   * 页面就再也收不到周期数据了——录制中的那个按钮会一直停在「停止录制」，
   * 时长也不走了（看着像卡住了）。
   *
   * 用户**点**它的时候焦点照常过去（那是用户自己要操作它）。
   */
  function showControl() {
    if (windows.control && !windows.control.isDestroyed()) {
      windows.control.showInactive();
      return windows.control;
    }
    const win = new BrowserWindow({
      // 先藏着，页面画好了再显示：show 之前得有东西可看，
      // 否则会闪一下空白的小框。
      show: false,
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
    windows.control = track(win, 'control');
    win.on('closed', () => {
      forget('control', win);
    });
    win.loadFile(join(pluginDir, 'pages', 'control.html')).then(
      () => {
        if (!win.isDestroyed()) win.showInactive();
      },
      () => {}
    );
    return win;
  }

  function hideControl() {
    if (windows.control && !windows.control.isDestroyed()) windows.control.destroy();
    windows.control = null;
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
    showRegionFrame,
    closeRegionFrame,
    sendTo,
    showControl,
    hideControl,
    destroyAll,
    roleOf: (contentsId) => roles.get(contentsId) || '',
  };
}
