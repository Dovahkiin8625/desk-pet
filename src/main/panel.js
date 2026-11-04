import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { appUrl } from './protocol.js';
import { placeBesidePet } from './placement.js';
import {
  makeSearchView,
  makePluginView,
  SEARCH_VIEW_HEIGHT,
  MAX_VIEW_HEIGHT,
} from '../shared/panel.js';
import { BUILTIN_SETTINGS, builtinFeatures, isBuiltin, builtinPage, builtinAction } from './builtins.js';

/**
 * 插件面板：桌宠的「uTools 式」入口。
 *
 * 左键点一下桌宠，这个面板就弹在桌宠旁边：
 * 上面一个搜索框，下面一列模糊匹配出来的插件；
 * 点一下或者按回车，就打开那个插件的界面（同一个窗口换内容）。
 *
 * 三条硬约束（与气泡同源，每一条都对应一个踩过的坑）：
 *
 * 1. **懒创建**：窗口在第一次点桌宠时才建。
 *    `app.firstWindow()` 认的是「第一个窗口」，E2E 靠它找宠物窗口——
 *    面板若在启动时就存在，整个 e2e 套件都会超时。
 * 2. **就绪握手**：`webContents.send` 对尚未注册监听器的页面是**丢弃**而不是排队。
 *    面板页要回「我准备好了」，在那之前的视图排队等着——
 *    否则用户点的第一个插件会打开成一片空白。
 * 3. **失焦即收**：点面板外面就收起（带一小段抖动保护，
 *    免得刚弹出时的假失焦把它立刻关掉）。
 */

/** 面板与桌宠之间的间距（像素）。 */
const GAP = 8;

/** 面板的尺寸。内容超出时在面板内部滚动。 */
const PANEL_WIDTH = 420;

/** 面板高度的下限（窗口按内容撑开，但要有边界）。 */
const MIN_HEIGHT = 160;

/** 失焦后多久才收起来：躲开「刚弹出时的假失焦」。 */
const BLUR_GRACE_MS = 300;

export function createPanelController({
  rootDir,
  getPetWindow,
  getPetRect,
  getDisplays,
  plugins,
  apps,
  assistant,
  openSettings,
  onChat,
}) {
  let win = null;
  let ready = false;
  // 页面还没就绪时要发的第一个视图（null = 还没有要发的）。
  let pendingView = null;
  // 当前打开的是哪个插件（null = 搜索视图）。
  let currentPluginId = null;
  // 请求序号：只有最后一次请求允许提交页面。
  //
  // 插件的 open/action 是**异步**的（读剪贴板、查天气都要等）：
  // 用户点「剪贴板」又点「待办」时，先发的那个可能后到——
  // 不看序号的话，最后落地的界面会是用户**先**点的那个。
  let requestSeq = 0;
  // 上次显示的时刻：失焦保护用。
  let shownAt = 0;

  function send(channel, payload) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  /**
   * 搜索清单：内置功能 + 磁盘上的插件。
   *
   * 内置功能（设置、聊天记录）与插件**摆在同一张清单里**：
   * 它们都是「面板里能搜到、能打开的东西」，用户不该为它们分两套心智。
   * 区别只在能不能被关掉——内置的不能。
   */
  function searchList() {
    return [...builtinFeatures(), ...plugins.list()];
  }

  /** 把当前视图发给页面。 */
  function sendView(view) {
    send('panel:view', view);
  }

  /** 把面板摆到桌宠旁边。 */
  function place() {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getSize();
    const chosen = placeBesidePet({
      petWindow: getPetWindow(),
      // 贴着桌宠**本体**：桌宠窗口上半截常常是空的，
      // 按窗口摆面板会浮在角色头顶老高的地方。
      petRect: getPetRect?.(),
      displays: getDisplays(),
      width: w,
      height: h,
      gap: GAP,
    });
    win.setPosition(chosen.x, chosen.y);
  }

  /** 显示面板并把焦点交给它。 */
  function reveal() {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) {
      place();
      win.show();
    }
    win.focus();
    shownAt = Date.now();
  }

  function hide() {
    if (!win || win.isDestroyed()) return;
    currentPluginId = null;
    win.hide();
  }

  /**
   * 打开面板。
   *
   * 已经开着的时候**回到搜索视图**：点桌宠就是「我要搜索」，
   * 规则简单才不用猜——用户再点一次就再搜一次。
   */
  function show() {
    if (!win || win.isDestroyed()) {
      createWindow();
      pendingView = makeSearchView();
      return;
    }
    if (!ready) {
      pendingView = makeSearchView();
      return;
    }
    currentPluginId = null;
    sendView(makeSearchView());
    reveal();
  }

  function createWindow() {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: SEARCH_VIEW_HEIGHT,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(rootDir, 'src', 'preload', 'panel.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 隐藏的窗口会被 Chromium **冻结**（后台节流）：
        // 面板收起来后再点开，页面要等它「醒过来」才画得出来，
        // 表现得像面板失灵。气泡与宠物窗口都有同一行——三处都要关。
        backgroundThrottling: false,
      },
    });
    // 层级要高于桌宠：桌宠用的是普通 alwaysOnTop（'floating' 级），
    // 两个同级的置顶窗口相对顺序是未定义的——面板会被桌宠盖住。
    win.setAlwaysOnTop(true, 'screen-saver');
    // 导航防护：窗口只该显示 app:// 下的页面（与宠物窗口同一道门）。
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadURL(appUrl('/src/renderer/panel/index.html'));
    // 页面加载失败：面板会永远等不到「我准备好了」，
    // 于是每次点桌宠都只是把视图排队等着——用户看到的是「点了没反应」。
    // 记一行日志并把窗口拆掉：下一次点桌宠会重新建一个（也许就成了）。
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[desk-pet] 插件面板加载失败：', code, desc);
      if (win && !win.isDestroyed()) win.destroy();
    });
    win.on('blur', () => {
      // 刚弹出时的失焦是假的：show() 与 focus() 之间会抖一下。
      if (Date.now() - shownAt < BLUR_GRACE_MS) return;
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      hide();
    });
    // 抓住这个窗口自己：旧窗口的 closed 事件不能把新窗口的引用清掉
    // （那会让面板变成「看得见但没人管」的孤儿窗口）。
    const created = win;
    created.on('closed', () => {
      if (win !== created) return;
      win = null;
      ready = false;
      pendingView = null;
      currentPluginId = null;
    });
  }

  /**
   * 插件在异步动作之后刷新页面（天气查询就是这种）。
   *
   * 用户要是已经切到别的插件了，这次刷新就别抢——
   * 面板上显示的东西必须始终是用户正在看的那一个。
   */
  function update(page) {
    if (!page) return;
    if (currentPluginId !== page.pluginId) return;
    sendView(makePluginView(page));
  }

  /** 打开一个插件。 */
  async function openPlugin(pluginId) {
    const token = ++requestSeq;
    // 内置功能不走插件宿主：它们是程序自带的，不是插件。
    if (isBuiltin(pluginId)) {
      openBuiltin(pluginId);
      return;
    }
    const page = await plugins.open(pluginId, update);
    // 期间用户又点了别的：这一次的结果作废。
    if (token !== requestSeq) return;
    // null 表示「这个插件开了别的东西」（设置窗口）：面板就没用了。
    if (!page) {
      hide();
      return;
    }
    currentPluginId = pluginId;
    sendView(makePluginView(page));
  }

  /**
   * 打开一个内置功能。
   *
   * 「设置」开的是**另一个窗口**（设置窗口）：面板这时候就该收起来，
   * 否则两块界面叠在一起，用户不知道该看哪儿。
   * 其余内置功能（聊天记录）就画在面板里。
   */
  function openBuiltin(pluginId) {
    if (pluginId === BUILTIN_SETTINGS) {
      hide();
      openSettings?.();
      return;
    }
    const page = builtinPage(pluginId, assistant);
    if (!page) {
      hide();
      return;
    }
    currentPluginId = pluginId;
    sendView(makePluginView(page));
  }

  /** 处理插件里的一个动作。 */
  async function handleAction(pluginId, actionId, value) {
    const token = ++requestSeq;
    if (isBuiltin(pluginId)) {
      const page = builtinAction(pluginId, actionId, assistant);
      if (!page) return;
      currentPluginId = pluginId;
      sendView(makePluginView(page));
      return;
    }
    const page = await plugins.action(pluginId, actionId, value, update);
    if (token !== requestSeq) return;
    if (!page) {
      hide();
      return;
    }
    currentPluginId = pluginId;
    sendView(makePluginView(page));
  }

  // 页面就绪：把插件清单与第一个视图发过去。
  ipcMain.on('panel:ready', (event) => {
    if (!win || event.sender !== win.webContents) return;
    ready = true;
    // 清单要先发：页面要靠它做本地模糊搜索。
    send('panel:plugins', searchList());
    sendView(pendingView || makeSearchView());
    pendingView = null;
    reveal();
  });

  // 本机程序清单：页面主动要（主进程会等索引扫完）。
  //
  // 走 invoke 而不是 send：清单是**异步**才有的（要扫盘），
  // 页面得拿到一份完整的清单才能搜程序。
  ipcMain.handle('panel:apps', async (event) => {
    if (!win || event.sender !== win.webContents) return [];
    try {
      return await apps.list();
    } catch (err) {
      console.warn('[desk-pet] 取本机程序清单失败：', err?.message || err);
      return [];
    }
  });

  // 启动一个本机程序（回车）。
  ipcMain.handle('panel:launch', async (event, appId) => {
    if (!win || event.sender !== win.webContents) {
      return { ok: false, message: '面板不在了' };
    }
    try {
      return await apps.launch(String(appId || ''));
    } catch (err) {
      console.warn('[desk-pet] 启动程序失败：', err?.message || err);
      return { ok: false, message: `打不开：${err?.message || err}` };
    }
  });

  // 索引重建完了：把新清单推给页面（页面本地搜索，不用重扫）。
  apps?.onChange?.((list) => {
    send('panel:appsChanged', list);
  });

  // 插件清单变了（在设置窗口里开关了插件）：
  // 把新清单推给页面，搜索结果跟着变。
  plugins.onChange?.(() => {
    send('panel:plugins', searchList());
  });

  // 打开某个插件（点结果或按回车）。
  ipcMain.on('panel:open', (event, pluginId) => {
    if (!win || event.sender !== win.webContents) return;
    openPlugin(String(pluginId || '')).catch((err) => {
      // 一定要接住：插件里抛错不该变成主进程的未处理错误，
      // 而面板该继续能用。
      console.warn('[desk-pet] 打开插件失败：', err?.message || err);
    });
  });

  // 把插件分离出去：开一个独立窗口，或者变成桌面小部件。
  //
  // 面板这时就该收起来了：插件已经在自己的窗口里了，
  // 两个界面抢同一件事只会让人不知道该看哪儿。
  ipcMain.on('panel:detach', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    const pluginId = String(payload?.pluginId || '');
    const mode = String(payload?.mode || 'window');
    const result = plugins.openWindow?.(pluginId, mode);
    // 开不出来（插件不支持这种形态）：面板留着，别把人踢回搜索。
    if (!result || result.ok === false) return;
    hide();
  });

  // 插件里的一个动作。
  ipcMain.on('panel:action', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    const { pluginId, actionId, value } = payload || {};
    handleAction(String(pluginId || ''), String(actionId || ''), value).catch((err) => {
      console.warn('[desk-pet] 插件动作失败：', err?.message || err);
    });
  });

  // 回到搜索视图。
  ipcMain.on('panel:back', (event) => {
    if (!win || event.sender !== win.webContents) return;
    currentPluginId = null;
    sendView(makeSearchView());
  });

  // 页面量出了内容高度：窗口按内容撑开。
  //
  // 不按内容撑开的话，插件页面下方会剩下一截**透明**的窗口——
  // Windows 没有逐像素命中测试，那一截照样会吃掉桌面的点击。
  ipcMain.on('panel:size', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    const height = Math.round(
      Math.min(MAX_VIEW_HEIGHT, Math.max(MIN_HEIGHT, Number(payload?.height) || MIN_HEIGHT))
    );
    const [w, h] = win.getSize();
    if (h === height) return;
    win.setBounds({ ...win.getBounds(), width: w, height });
    // 尺寸变了，位置要重新摆（否则会跟桌宠错开）。
    place();
  });

  // 关掉面板（Esc 或点右上角的 ×）。
  ipcMain.on('panel:close', (event) => {
    if (!win || event.sender !== win.webContents) return;
    hide();
  });

  // 和桌宠聊天。
  //
  // **不经过 requestSeq**：那是给「异步返回页面」的插件动作用的，
  // 聊天没有页面要返回，也不该被后来的插件点击作废。
  ipcMain.on('panel:chat', (event, text) => {
    if (!win || event.sender !== win.webContents) return;
    const value = String(text || '').trim();
    if (!value) return;
    // **先把面板收起来**：气泡与面板用同一套摆位算法，
    // 气泡会正好落在面板上把它盖住（气泡不透明）。
    // 而且消息已经发出去了，留着面板只是多一个竞争界面。
    hide();
    // 一定要接住：主进程里的聊天失败不该变成未处理的拒绝。
    void Promise.resolve(onChat?.(value)).catch?.((err) => {
      console.warn('[desk-pet] 聊天失败：', err?.message || err);
    });
  });

  return {
    show,
    hide,
    /** 桌宠窗口移动后重新摆位。 */
    reposition: () => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      place();
    },
    /** 桌宠被隐藏时：面板也不该留在桌面上。 */
    onPetHidden: () => {
      if (win && !win.isDestroyed() && win.isVisible()) hide();
    },
  };
}
