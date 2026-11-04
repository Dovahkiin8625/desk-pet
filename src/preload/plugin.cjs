const { contextBridge, ipcRenderer } = require('electron');

/**
 * 插件窗口**专用**的 preload。
 *
 * 为什么不给它复用 src/preload/index.cjs：那份挂着 moveWindowBy /
 * switchModel / saveSettings 这些能力——那是桌宠自己的，不该给插件。
 * 插件只需要「显示什么」「用户按了什么」和「控制我这个窗口」。
 */

/**
 * 插件的 id 与形态从 URL 的查询参数里来。
 *
 * 不用 `additionalArguments` 传：沙箱里的 `process` 没有 `argv`，
 * 而查询参数是两边都拿得到的东西（宿主拼 URL 时写进去的）。
 */
function readParams() {
  try {
    const search = new URL(location.href).search;
    const params = new URLSearchParams(search);
    return {
      pluginId: params.get('plugin') || '',
      mode: params.get('mode') || 'window',
    };
  } catch {
    return { pluginId: '', mode: 'window' };
  }
}

const { pluginId, mode } = readParams();

contextBridge.exposeInMainWorld('plugin', {
  /** 插件的 id（哪个插件的窗口）。 */
  id: pluginId,
  /** 窗口形态：`window` 或 `widget`。 */
  mode,

  // —— 通用声明式界面 ——
  // 宿主把插件的页面推过来，页面照着画。
  onPage: (cb) => {
    ipcRenderer.on('plugin:page', (_e, page) => cb(page));
  },
  // 插件页里的一个动作（回车、点按钮……）。
  action: (actionId, value) => ipcRenderer.invoke('plugin:action', { actionId, value }),

  // —— 插件自己的页面 ——
  // 数据由宿主喂：打开时给一次，之后按 refreshMs 周期推。
  data: () => ipcRenderer.invoke('plugin:data'),
  onData: (cb) => {
    ipcRenderer.on('plugin:data', (_e, data) => cb(data));
  },
  onTick: (cb) => {
    ipcRenderer.on('plugin:tick', (_e, data) => cb(data));
  },
  act: (actionId, payload) => ipcRenderer.invoke('plugin:act', { actionId, payload }),

  // —— 窗口控制 ——
  window: {
    state: () => ipcRenderer.invoke('plugin:window:state'),
    // 置顶开关：小部件永远置顶，独立窗口由用户决定。
    setAlwaysOnTop: (enabled) => ipcRenderer.invoke('plugin:window:alwaysOnTop', Boolean(enabled)),
    // 在「独立窗口」与「桌面小部件」之间切换。
    setMode: (m) => ipcRenderer.invoke('plugin:window:mode', String(m || '')),
    close: () => ipcRenderer.invoke('plugin:window:close'),
  },

  // 页面注册好监听器了：主进程在这之前发来的消息会被丢弃，
  // 所以要先报到，再让主进程把排队等着的东西补发过来。
  reportReady: () => ipcRenderer.send('plugin:ready'),
});
