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

/**
 * 订阅「推来的数据」的回调。
 *
 * 推送的监听器只装一次、各处订阅者共用：
 * 面板会在插件之间来回切，每切一次就多一个订阅者——
 * 各自 `ipcRenderer.on` 的话，推来的数据会被送到所有**旧**插件的回调上。
 */
const dataSubscribers = new Set();
const tickSubscribers = new Set();

/**
 * 最近一次推来的数据。
 *
 * 插件页面在 iframe 里，要等**加载完**才跑脚本、才订阅 onData——
 * 而宿主在面板打开插件的那一刻就把数据推过来了（那时 iframe 还没就位）。
 * 推送是不排队的，不留一份在这儿，那份数据就永远丢了。
 *
 * **按插件 id 存**：面板会在插件之间来回切，
 * 留着上一个插件的数据给下一个看，就是串台了。
 */
let pendingData = null;

/**
 * 推来的数据：转给所有订阅者。
 *
 * @param {object} payload 信封 `{ pluginId, data }`
 */
function deliverData(payload) {
  pendingData = payload;
  for (const cb of dataSubscribers) {
    try {
      cb(payload);
    } catch (err) {
      // 旧插件的页面已经被换掉了：它的回调已经没用了，扔掉就是。
      dataSubscribers.delete(cb);
    }
  }
}

/** 推来的周期数据：转给所有订阅者。 */
function deliverTick(payload) {
  for (const cb of tickSubscribers) {
    try {
      cb(payload);
    } catch (err) {
      tickSubscribers.delete(cb);
    }
  }
}

ipcRenderer.on('panel:surface:data', (_e, payload) => deliverData(payload));
ipcRenderer.on('panel:surface:tick', (_e, payload) => deliverTick(payload));

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
      dataSubscribers.add(cb);
      // 订阅之前推来的那份数据：补给它（插件页面加载得慢，
      // 宿主早就把第一份数据推过来了）。
      // 只补**当前插件**的那份：别的插件的数据串过来就是串台了。
      if (pendingData && pendingData.pluginId === currentPluginId) cb(pendingData);
    },
    onTick: (cb) => {
      tickSubscribers.add(cb);
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
