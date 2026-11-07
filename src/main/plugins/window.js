import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { appUrl } from '../protocol.js';
import { placeBesidePet } from '../placement.js';
import { PLUGIN_WINDOW_MODE } from '../../shared/plugin.js';

/**
 * 插件的独立窗口与桌面小部件。
 *
 * 一个插件可以有两种「脱离面板」的形态：
 *
 * - **独立窗口**（`window`）：自己的窗口，能调整大小、能置顶、能拖到别处去；
 * - **桌面小部件**（`widget`）：无边框、透明、常驻桌面，像系统监控那样挂在那儿。
 *
 * 两种形态用的是同一个窗口实例：切形态就是改窗口的样式与尺寸，
 * 重新加载页面。插件自己的页面（清单里的 `page`）优先；
 * 没有就套一层通用的声明式界面（src/renderer/plugin-window/），
 * 于是**任何**插件都能一键分离出去，不必自己写页面。
 */

/** 插件窗口与桌宠之间的间距（像素）。 */
const GAP = 8;

export function createPluginWindowController({
  rootDir,
  host,
  getPetWindow,
  getPetRect,
  getDisplays,
  surfaces,
}) {
  /** pluginId → { win, mode, pluginId, contentsId, ownPage, surface }。 */
  const windows = new Map();
  /** webContents.id → pluginId：IPC 来了要认得出是哪个窗口。 */
  const byContents = new Map();

  /** 这个 pluginId 现在有没有窗口开着。 */
  function entryOf(pluginId) {
    const entry = windows.get(pluginId);
    if (!entry) return null;
    if (!entry.win || entry.win.isDestroyed()) {
      windows.delete(pluginId);
      return null;
    }
    return entry;
  }

  /** 把插件窗口摆在桌宠旁边。 */
  function place(win) {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getSize();
    const chosen = placeBesidePet({
      petWindow: getPetWindow?.(),
      petRect: getPetRect?.(),
      displays: getDisplays?.() || [],
      width: w,
      height: h,
      gap: GAP,
    });
    win.setPosition(chosen.x, chosen.y);
  }

  /**
   * 插件的界面：地址 + 「归谁管」。
   *
   * `url` 是窗口要加载的地址；`ownPage` 说的是界面是不是由插件自己的页面负责
   * （不是的话，宿主画积木）。
   *
   * **独立窗口永远是壳**：壳里再装插件自己的页面（如果有）。
   * 这样面板工作台与独立窗口结构完全相同，只有容器宽度不同——
   * 同一份页面两处用，界面天然是一套。
   *
   * 清单里写了 `page` 但文件不在磁盘上（路径写错、文件被删）——
   * 那不算「有页面」：那个页面装不进去，窗口只剩一片空白。
   * 这种插件要退回积木界面，照样能干活。
   * （host.pageUrl() 就是按「文件在不在」给答复的；查一次就够。）
   *
   * **小部件这一轮不动**：插件的页面原样加载（带 preload），
   * 壳不参与，页面没了就是它自己的事（既有行为）。
   */
  function resolveSurface(pluginId, mode) {
    // 插件没了就没有 URL：spec 缺了也可能是「这个形态它没有」，
    // 那两种情况要分开，所以先看一眼插件还在不在。
    const record = host.get(pluginId);
    if (!record) return null;
    const spec = host.spec(pluginId, mode);
    const query = new URLSearchParams({ plugin: pluginId, mode });

    if (mode === PLUGIN_WINDOW_MODE.WIDGET) {
      // 小部件：插件的页面原样加载（带 preload），壳不参与。
      // 这里看的是 **widget 段**里的页面（spec.page）——
      // host.pageUrl() 只认 window 段，两者不是一回事。
      if (spec?.page) {
        return {
          url: appUrl(`${host.baseUrl(pluginId)}/${spec.page}?${query}`),
          ownPage: true,
        };
      }
      return { url: appUrl(`/src/renderer/plugin-window/index.html?${query}`), ownPage: false };
    }

    // 页面**不存在**时 host.pageUrl() 给空串 → 壳里画积木，不开白窗口。
    const pluginPage = host.pageUrl?.(pluginId) || '';
    if (pluginPage) query.set('src', pluginPage);
    return {
      url: appUrl(`/src/renderer/plugin-window/index.html?${query}`),
      ownPage: Boolean(pluginPage),
    };
  }

  /** 建一个插件窗口。 */
  function createWindow(pluginId, mode) {
    const record = host.get(pluginId);
    if (!record) return null;
    const isWidget = mode === PLUGIN_WINDOW_MODE.WIDGET;
    const spec = host.spec(pluginId, mode);
    if (!spec) return null;
    const surface = resolveSurface(pluginId, mode);
    if (!surface) return null;
    const url = surface.url;
    // 「有没有自带页面」在建窗时定一次就够：
    // 它要查磁盘（host.pageUrl() 判文件在不在），每次刷新都查一遍是白花钱。
    const ownPage = surface.ownPage;

    const win = new BrowserWindow({
      width: spec.width,
      height: spec.height,
      show: false,
      // 小部件是透明的；独立窗口是实心的（卡片自己有底色）。
      transparent: isWidget,
      frame: false,
      hasShadow: !isWidget,
      resizable: !isWidget,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // 小部件不进任务栏：它是桌面的一部分，不是「一个应用窗口」。
      skipTaskbar: isWidget,
      alwaysOnTop: spec.alwaysOnTop,
      backgroundColor: isWidget ? '#00000000' : '#fffdf8',
      webPreferences: {
        preload: join(rootDir, 'src', 'preload', 'plugin.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    // 小部件永远置顶；独立窗口的置顶由用户 toggle 决定。
    if (isWidget) win.setAlwaysOnTop(true, 'floating');
    else if (spec.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');

    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[desk-pet] 插件窗口加载失败：', code, desc);
    });

    // 窗口的 webContents id **在这里就存下来**。
    //
    // 不能等到 'closed' 里再读 `win.webContents.id`：那时窗口已经销毁了，
    // 那个属性读起来会把**主进程整个冻住**（窗口关不掉、程序退不出去——
    // 表现为「点了退出，程序却不退」）。这里读一次，存下来就够用了。
    const contentsId = win.webContents.id;

    const entry = { win, mode, pluginId, contentsId, ownPage, surface: null };
    windows.set(pluginId, entry);
    byContents.set(contentsId, pluginId);

    win.on('closed', () => {
      byContents.delete(contentsId);
      // 窗口没了：这个界面落点也不能留着——tick 会一直推。
      if (entry.surface) surfaces?.detach(pluginId, entry.surface);
      if (windows.get(pluginId) === entry) windows.delete(pluginId);
    });

    // 先挂上 ready-to-show 再加载：页面可能秒开，
    // 顺序反了窗口就永远不显示（show 那一行没人调）。
    win.once('ready-to-show', () => {
      place(win);
      win.show();
    });
    win.loadURL(url);
    return entry;
  }

  /**
   * 打开（或聚焦）一个插件的独立窗口。
   *
   * 已经在开着就聚焦它；形态不同就切形态——
   * 「在小部件与独立窗口之间切换」是同一个窗口的两种样子。
   */
  function open(pluginId, mode = PLUGIN_WINDOW_MODE.WINDOW) {
    const record = host.get(pluginId);
    if (!record) return { ok: false, message: '没有这个插件' };
    const wantMode = mode === PLUGIN_WINDOW_MODE.WIDGET ? PLUGIN_WINDOW_MODE.WIDGET : PLUGIN_WINDOW_MODE.WINDOW;
    // 独立窗口：每个插件都有（没写 `window` 段就合成一份默认的）。
    // 小部件：仍然要插件自己声明——它要占着用户的桌面。
    const spec = host.spec(pluginId, wantMode);
    if (!spec) {
      return {
        ok: false,
        message: wantMode === PLUGIN_WINDOW_MODE.WIDGET ? '这个插件没有小部件形态' : '这个插件不能分离成独立窗口',
      };
    }
    const existing = entryOf(pluginId);
    if (existing) {
      if (existing.mode !== wantMode) {
        switchMode(pluginId, wantMode);
      } else {
        existing.win.focus();
      }
      return { ok: true, mode: wantMode };
    }
    const entry = createWindow(pluginId, wantMode);
    if (!entry) return { ok: false, message: '窗口建不出来' };
    return { ok: true, mode: wantMode };
  }

  /** 关掉一个插件的窗口。 */
  function close(pluginId) {
    const entry = entryOf(pluginId);
    if (!entry) return { ok: false };
    entry.win.destroy();
    return { ok: true };
  }

  /** 退出前把插件窗口全部拆掉（见返回值处的说明）。 */
  function destroyAll() {
    for (const entry of windows.values()) {
      if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
    }
    windows.clear();
    byContents.clear();
  }

  /** 切形态：重建窗口（透明与否、尺寸、置顶规则都不一样）。 */
  function switchMode(pluginId, mode) {
    const entry = entryOf(pluginId);
    if (!entry) return open(pluginId, mode);
    // 形态变了，窗口的样式也得跟着变（透明、置顶规则、尺寸都不一样），
    // 所以重建一个，而不是在原来那个上改。
    //
    // 置顶状态**不跟着带过去**：小部件永远置顶，
    // 把它带成独立窗口的话，用户会得到一个莫名其妙压着别人的窗口。
    entry.win.destroy();
    const next = createWindow(pluginId, mode);
    return { ok: Boolean(next), mode };
  }

  /** 窗口当前的形态与能力（渲染层要据此决定按钮画不画）。 */
  function stateOf(pluginId) {
    const record = host.get(pluginId);
    const entry = entryOf(pluginId);
    const mode = entry?.mode || PLUGIN_WINDOW_MODE.WINDOW;
    return {
      pluginId,
      mode,
      alwaysOnTop: entry ? entry.win.isAlwaysOnTop() : false,
      // 小部件要插件自己声明：没有 `widget` 段就是没有。
      canWidget: Boolean(host.spec(pluginId, PLUGIN_WINDOW_MODE.WIDGET)),
      title: record?.manifest?.name || pluginId,
    };
  }

  /**
   * 页面就绪：把该给它的东西给它。
   *
   * 自定义页面拿的是插件自己的数据（`data()`）；
   * 通用声明式界面拿的是插件的页面（`page()`）。
   *
   * 窗口这个界面落点**挂到 surface 路由上**：数据由路由推过来，
   * 面板工作台那边开着同一个插件时，两处看到的是同一份。
   *
   * **首份数据走 broadcast**：它要送到**所有**挂着这个插件的界面，
   * 只送窗口这一份的话，面板那边就少了一份。
   */
  async function onReady(pluginId) {
    const entry = entryOf(pluginId);
    if (!entry) return;
    const record = host.get(pluginId);
    if (!record) return;

    // 窗口这个界面落点：数据由 surface 路由推过来。
    const windowSurface = {
      kind: 'window',
      // 形态：小部件与独立窗口的清单段不一样，刷新周期按各自的算。
      mode: entry.mode,
      deliver(kind, payload) {
        const win = entryOf(pluginId)?.win;
        if (!win || win.isDestroyed()) return;
        const channel = kind === 'data' ? 'plugin:data'
          : kind === 'tick' ? 'plugin:tick'
          : 'plugin:page';
        // **不拆包**：宿主推来的统一是 `{ pluginId, data }`，
        // 拆包的是壳（plugin-window/main.js）与插件页面助手。
        //
        // 小部件是**例外**：它的页面是插件自己写的，按 window.plugin 的约定
        // 收**裸数据**（这一轮不改小部件）。
        const body = entry.mode === PLUGIN_WINDOW_MODE.WIDGET ? payload?.data : payload;
        win.webContents.send(channel, body);
      },
    };
    entry.surface = windowSurface;
    surfaces?.attach(pluginId, windowSurface);

    if (entry.ownPage) {
      // 自定义页面：插件自己管界面，宿主只负责喂数据。
      const data = await host.data(pluginId);
      surfaces?.broadcast(pluginId, 'data', data);
    } else {
      // 通用界面：画插件的声明式页面。
      const page = await host.open(pluginId, null);
      surfaces?.broadcast(pluginId, 'page', page);
    }
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  /** 这个 IPC 是不是某个插件窗口发来的；是的话返回它的 pluginId。 */
  function senderPluginId(event) {
    const id = byContents.get(event?.sender?.id);
    return id || null;
  }

  ipcMain.on('plugin:ready', (event) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return;
    void onReady(pluginId);
  });

  ipcMain.handle('plugin:data', async (event) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return null;
    return host.data(pluginId);
  });

  ipcMain.handle('plugin:act', async (event, payload) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return null;
    const actionId = String(payload?.actionId || '');
    return host.act(pluginId, actionId, payload?.payload);
  });

  ipcMain.handle('plugin:action', async (event, payload) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return null;
    const page = await host.action(pluginId, String(payload?.actionId || ''), payload?.value, null);
    // 动作之后的新页面：**所有**挂着这个插件的界面都要重画。
    if (page) surfaces?.broadcast(pluginId, 'page', page);
    return page;
  });

  ipcMain.handle('plugin:window:state', (event) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return null;
    return stateOf(pluginId);
  });

  ipcMain.handle('plugin:window:alwaysOnTop', (event, value) => {
    const pluginId = senderPluginId(event);
    const entry = pluginId ? entryOf(pluginId) : null;
    if (!entry) return false;
    const on = Boolean(value);
    entry.win.setAlwaysOnTop(on, 'floating');
    return entry.win.isAlwaysOnTop();
  });

  ipcMain.handle('plugin:window:mode', (event, mode) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return null;
    const next = String(mode || '') === PLUGIN_WINDOW_MODE.WIDGET
      ? PLUGIN_WINDOW_MODE.WIDGET
      : PLUGIN_WINDOW_MODE.WINDOW;
    const result = switchMode(pluginId, next);
    return result.mode || next;
  });

  ipcMain.handle('plugin:window:close', (event) => {
    const pluginId = senderPluginId(event);
    if (!pluginId) return false;
    close(pluginId);
    return true;
  });

  return {
    open,
    close,
    stateOf,
    /**
     * 退出前把插件窗口全部拆掉。
     *
     * Electron 的正常退出流程（app.quit() → 逐个关窗口）在插件窗口上会**卡住**：
     * 退不出去，进程一直活着（E2E 里表现为 app.close() 永远不返回）。
     *
     * 退出时不需要保留任何界面，所以直接 destroy() 绕开那条流程。
     */
    destroyAll,
    /** 桌宠动了：插件窗口跟着动。 */
    reposition: () => {
      for (const entry of windows.values()) {
        if (entry.win && !entry.win.isDestroyed() && entry.win.isVisible()) place(entry.win);
      }
    },
  };
}
