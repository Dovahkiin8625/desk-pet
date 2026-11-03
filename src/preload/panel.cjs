const { contextBridge, ipcRenderer } = require('electron');

/**
 * 插件面板**专用**的 preload。
 *
 * 为什么不给它复用 src/preload/index.cjs：那份是宠物窗口与设置窗口共用的，
 * 上面挂着 moveWindowBy / switchModel / saveSettings 这些能力。
 * 面板窗口只需要「显示什么」和「用户按了什么」，
 * 多给它一份能力就多一份攻击面。
 */
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
  // 回到搜索视图。
  back: () => ipcRenderer.send('panel:back'),
  // 关掉面板。
  close: () => ipcRenderer.send('panel:close'),
});
