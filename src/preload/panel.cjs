const { contextBridge, ipcRenderer } = require('electron');

/**
 * 插件面板**专用**的 preload。
 *
 * 为什么不给它复用 src/preload/index.cjs：那份是宠物窗口与设置窗口共用的，
 * 上面挂着 moveWindowBy / switchModel / saveSettings 这些能力。
 * 面板窗口只需要「显示什么」和「用户按了什么」，
 * 多给它一份能力就多一份攻击面。
 */

/** 面板当前打开的是哪个插件（surface 的 IPC 要带着它）。 */
let currentPluginId = '';

contextBridge.exposeInMainWorld('panel', {
  // 主进程要显示一个视图（搜索视图 or 插件界面）。
  onView: (cb) => {
    ipcRenderer.on('panel:view', (_e, view) => cb(view));
  },
  // 插件清单（搜索用）：一次性下发，页面本地做模糊匹配。
  onPlugins: (cb) => {
    ipcRenderer.on('panel:plugins', (_e, plugins) => cb(plugins));
  },
  // 页面注册好监听器了：主进程在这之前发来的消息会被丢弃，
  // 所以要先报到，再让主进程把排队等着的东西补发过来。
  reportReady: () => ipcRenderer.send('panel:ready'),
  // 内容画完之后把高度报回去：窗口要按内容撑开。
  // 不然窗口下半截是透明的，而透明的那部分仍会吃掉桌面的点击。
  reportSize: (height) => ipcRenderer.send('panel:size', { height }),
  // 打开一个插件（点结果或按回车）。
  open: (pluginId) => ipcRenderer.send('panel:open', pluginId),
  // 把插件分离出去：`window` = 独立窗口，`widget` = 桌面小部件。
  detach: (pluginId, mode) =>
    ipcRenderer.send('panel:detach', { pluginId: String(pluginId || ''), mode: String(mode || '') }),
  // 本机程序清单：一次性拿下来，页面本地做模糊搜索。
  //
  // 用 invoke 而不是 send：主进程要等索引扫完才能给清单，
  // 页面得**等到**那份清单才能搜程序。
  apps: () => ipcRenderer.invoke('panel:apps'),
  // 启动一个本机程序：回车就启动（像 uTools 那样）。
  launch: (appId) => ipcRenderer.invoke('panel:launch', String(appId ?? '')),
  // 索引重建了：主进程把新清单推过来。
  onApps: (cb) => {
    ipcRenderer.on('panel:appsChanged', (_e, apps) => cb(apps));
  },
  // 和桌宠聊天：文本直接发给主进程。
  //
  // 不走插件动作通道——那条路带「请求序号」，会把后发的插件点击
  // 当成「作废之前的请求」，聊天会被误丢掉。
  chat: (text) => ipcRenderer.send('panel:chat', String(text ?? '')),
  // 插件里的一个动作。
  action: (pluginId, actionId, value) =>
    ipcRenderer.send('panel:action', { pluginId, actionId, value }),
  // 面板当前打开的是哪个插件：surface 的请求要带着它，
  // 宿主才知道该把数据送给谁。
  setCurrentPlugin: (pluginId) => {
    currentPluginId = String(pluginId || '');
  },
  // 插件自带页面用的通道（面板工作台里的 iframe 走这条）。
  //
  // 与插件壳上的 window.plugin **同名同形**：
  // 插件页面不该知道自己身处面板还是独立窗口（见 src/renderer/ui/pluginPage.js）。
  //
  // **三个会返回值的接口，返回的都是「裸值」**——
  // 与插件壳那边一致（那边 invoke 回来的是 `host.data()` / `host.act()` 的原样）。
  // 页面助手就不用分身处何处，两边拿到的东西是同一个形状。
  // （**推送**那条路不一样：推上来的都包成 `{ pluginId, data }`，
  // 因为面板会在插件之间来回切，得带得清是给谁的。）
  surface: {
    data: () => ipcRenderer.invoke('panel:surface:data', { pluginId: currentPluginId }),
    onData: (cb) => {
      ipcRenderer.on('panel:surface:data', (_e, payload) => cb(payload));
    },
    onTick: (cb) => {
      ipcRenderer.on('panel:surface:tick', (_e, payload) => cb(payload));
    },
    act: (actionId, payload) =>
      ipcRenderer.invoke('panel:surface:act', { pluginId: currentPluginId, actionId, payload }),
    // **invoke 而不是 send**：send 没有回执，页面那边
    // `surface.action(...).then(...)` 会拿到 undefined 而不是一个 Promise。
    action: (actionId, value) =>
      ipcRenderer.invoke('panel:surface:action', { pluginId: currentPluginId, actionId, value }),
  },
  // 回到搜索视图。
  back: () => ipcRenderer.send('panel:back'),
  // 关掉面板。
  close: () => ipcRenderer.send('panel:close'),
});
