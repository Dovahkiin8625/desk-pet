const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
 * 拖进来的文件：转发给插件 iframe。
 *
 * 从资源管理器拖文件进来，Chromium 要壳（这一层）收下（dragover 里
 * preventDefault）——插件页面自己在 iframe 里，接不住；它也没有
 * webUtils 可用。所以壳把落在 <iframe> 上的文件换成路径，
 * 再 postMessage 进 iframe，插件自己处理。
 */
function forwardDropsToPluginFrame() {
  const frame = () => document.querySelector('#plugin-frame');
  /** 鼠标点在插件 iframe 里吗（插件没挂着的时候 iframe 宽度是 0）。 */
  const overFrame = (e) => {
    const el = frame();
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const { clientX: x, clientY: y } = e;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!overFrame(e)) return;
    e.preventDefault();
    depth += 1;
    frame()?.contentWindow?.postMessage({ type: 'desk-pet:file-dragenter' }, '*');
  });
  window.addEventListener('dragover', (e) => {
    if (!overFrame(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    if (depth > 0) {
      depth -= 1;
      if (depth === 0) frame()?.contentWindow?.postMessage({ type: 'desk-pet:file-dragleave' }, '*');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!overFrame(e)) return;
    depth = 0;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    const paths = files.map((f) => {
      try {
        return webUtils.getPathForFile(f);
      } catch {
        return '';
      }
    }).filter(Boolean);
    if (paths.length === 0) return;
    e.preventDefault();
    frame()?.contentWindow?.postMessage({ type: 'desk-pet:file-drop', paths }, '*');
  });
}
forwardDropsToPluginFrame();

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
  // 人设名：界面凡是指代「它」的地方都用它。
  personaName: () => ipcRenderer.invoke('pet:personaName'),
  onPersonaName: (cb) => {
    ipcRenderer.on('pet:personaName', (_e, payload) => cb(String(payload?.name ?? payload ?? '')));
  },
  // 主题变了：渲染层据此给 <html> 标 data-theme 与 data-scheme。
  // 当前的主题：刚打开的窗口靠它知道自己该是浅色还是深色。
  theme: () => ipcRenderer.invoke('pet:theme'),
  onTheme: (cb) => {
    ipcRenderer.on('pet:theme', (_e, theme) => cb(theme));
  },
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
  //
  // **用 invoke 而不是 send**：主进程会把高度**夹到屏幕装得下的上限**，
  // 页面得知道自己实际拿到了多少高度，才好把超出的部分放进内部滚动。
  // （只报不回的，页面只能按内容摆 iframe，多出来的那一截会被窗口裁掉。）
  reportSize: (height) => ipcRenderer.invoke('panel:size', { height }),
  // 打开一个插件（点结果或按回车）。
  open: (pluginId) => ipcRenderer.send('panel:open', pluginId),
  // 打开一个插件，并把输入框里那段文字交给它。
  openInput: (pluginId, text) =>
    ipcRenderer.send('panel:openInput', { pluginId: String(pluginId || ''), text: String(text || '') }),
  // 输入框里的字：主进程要知道它当前是什么（插件要「吃」它）。
  setQuery: (text) => ipcRenderer.send('panel:query', String(text ?? '')),
  // 面板打开时主进程把剪贴板里最近的文本递过来，填进输入框。
  onPrefill: (cb) => {
    ipcRenderer.on('panel:prefill', (_e, text) => cb(text));
  },
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
  // 查本机文件：主进程去查 Windows 搜索索引（Win+S 用的就是它）。
  //
  // 文件可能有成千上万个，搬不进渲染层，只能现查现给。
  files: (query) => ipcRenderer.invoke('panel:files', String(query ?? '')),
  // 抽图标：给搜索结果显示程序与文件自己的图标。
  //
  // 传的是路径，回来的是「路径 → data URL」。
  icons: (paths) => ipcRenderer.invoke('panel:icons', Array.isArray(paths) ? paths : []),
  // 系统设置页清单：一次性下发，页面本地搜索。
  onSettings: (cb) => {
    ipcRenderer.on('panel:settings', (_e, list) => cb(list));
  },
  // 文件拖放：Electron 32 起 File.path 已被移除，
  // 真实的路径要用 webUtils.getPathForFile 从 File 对象里取
  // （它只能在 preload 里调，所以由 preload 代劳）。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  // 打开一个条目（文件、设置页、上网搜）：主进程去调系统的打开动作。
  openItem: (item) => ipcRenderer.invoke('panel:openItem', item || {}),
  // 右键菜单：主进程弹原生菜单（打开 / 打开所在目录）。
  contextMenu: (item) => ipcRenderer.send('panel:contextMenu', item || {}),
  // 主进程那边做完一件事的结果（显示在搜索视图底部那行）。
  onStatus: (cb) => {
    ipcRenderer.on('panel:status', (_e, text) => cb(text));
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
    // 人设名：iframe 里的插件页面要能读（换名时跟着 UI 一起变）。
    personaName: () => ipcRenderer.invoke('pet:personaName'),
    onPersonaName: (cb) => {
      ipcRenderer.on('pet:personaName', (_e, payload) =>
        cb(String(payload?.name ?? payload ?? ''))
      );
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
