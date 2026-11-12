# 插件的独立窗口：宽版与窄版 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件在「搜索框里打开」与「新窗口打开」时是两种形态——面板是窄的手机版，独立窗口是宽的 PC 版（默认 720×560），并且记住用户拖过的窗口尺寸。

**Architecture:** 三层。

1. **尺寸**：清单里的 `window.width/height` 就是独立窗口的尺寸；没写 `window` 段的插件用共享层合成的默认规格（720×560）。用户拖过的尺寸记在 `plugins.json` 的 `windowSizes` 段里，建窗时优先用它，标题栏的「⛶」按钮能恢复清单里的尺寸。
2. **响应式**：宽窄由**可用宽度**决定，断点 **560px** 一个数。宿主画的积木界面用容器查询（`.surface` + `@container surface (min-width: 560px)`），插件自带页面用媒体查询（`@media (min-width: 560px)`）——容器查询跨不过 iframe 边界，只能这样。
3. **容器套在宽度等于 iframe 宽度的那一层**（面板的 `<section id="plugin">`、独立窗口壳的 `#win`）：这样容器量到的数就是插件页的视口宽度，两个机制量的是同一个盒子，不会出现「积木已宽、插件页还窄」的混搭。

**Tech Stack:** Electron 45（Chromium 140）、原生 ESM、node:test（单元）、Playwright + Electron（端到端）、CSS 容器查询与媒体查询。

**Spec:** `docs/superpowers/specs/2026-11-12-plugin-window-responsive-design.md`

## Global Constraints

- 断点是 **560px**，一个数。不要出现第二个阈值。
- **面板这一侧外观不变**：宽度 420、积木单列、插件页面按内容撑高。
- 不给插件协议加字段、不新增块类型、不动小部件的尺寸与布局。
- 窗口尺寸上下限 **200×120 ～ 1200×900** 不变（`PLUGIN_WINDOW_LIMITS`）。
- 每个内置插件的独立窗口宽度 ≥ **620**（减去壳的边框与内边距后内容区仍 ≥ 560 → 宽版成立）。
- 注释保持简洁，不加解释性注释；UI 里不出现解释代码逻辑的文字。
- 提交信息用中文，格式 `feat(scope): …` / `test(scope): …` / `docs(scope): …` / `fix(scope): …`。
- 每个任务末尾提交一次，不要把两个任务塞进一次提交。
- **音乐播放器的页面在动手前有未提交的改动**（工作区里 `plugins/music-player/pages/*` 已被修改）：只在现有文件上**追加**宽版规则，不要覆盖既有改动。动它之前先 `git diff plugins/music-player` 看清楚。
- E2E 会真的开窗口——别在别人开会时跑。录屏插件的 e2e 在本机多显示器环境里必挂（与代码改动无关），本计划不碰它。

## Review Focus

1. 用户把独立窗口拖到 560 以下 → 宽版要**整个**退回窄版（积木与插件页同时退回，不是半吊子）。
2. 记住的尺寸越界（清单写 999999、用户拖出屏幕）→ 必须被夹到 200×120 ～ 1200×900。
3. **小部件**被拖动 → 不该被记成窗口尺寸（小部件的尺寸是清单定的）。
4. 清单里没写 `window` 段的插件 → 也要按 720×560 打开（默认规格）。
5. 面板里的插件页面仍然**按内容撑高**（面板的高度契约：页面报多高、面板开多高），这轮改动不能破坏它。
6. 面板里的积木界面仍然单列（容器查询在面板里不命中）。

---

### Task 1: 共享层：默认窗口尺寸改成 720×560

**Files:**
- Modify: `src/shared/plugin.js:33-40`（`PLUGIN_WINDOW_LIMITS`）
- Test: `test/unit/plugin-window-spec.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `PLUGIN_WINDOW_LIMITS.width === 720`、`PLUGIN_WINDOW_LIMITS.height === 560`；`defaultWindowSpec(manifest)` 与 `resolveWindowSpec(manifest, 'window')` 仍以这两个字段为默认。上下限四个字段不变。

- [ ] **Step 1: 写失败的测试**

在 `test/unit/plugin-window-spec.test.js` 末尾加：

```js
test('默认的独立窗口是宽版：够宽才切得出宽版布局', () => {
  const spec = defaultWindowSpec({ name: '待办' });
  assert.equal(spec.width, 720);
  assert.equal(spec.height, 560);
  // 上下限不动。
  assert.equal(PLUGIN_WINDOW_LIMITS.minWidth, 200);
  assert.equal(PLUGIN_WINDOW_LIMITS.minHeight, 120);
  assert.equal(PLUGIN_WINDOW_LIMITS.maxWidth, 1200);
  assert.equal(PLUGIN_WINDOW_LIMITS.maxHeight, 900);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/plugin-window-spec.test.js`
Expected: FAIL —— `spec.width` 是 360（期望 720）。

- [ ] **Step 3: 改默认值**

`src/shared/plugin.js` 的 `PLUGIN_WINDOW_LIMITS`：`width: 360` → `720`，`height: 420` → `560`。上下限四个字段一字不动。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/unit/plugin-window-spec.test.js`
Expected: PASS（全部 ok）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/plugin.js test/unit/plugin-window-spec.test.js
git commit -m "feat(plugin): 独立窗口的默认尺寸改成 720×560"
```

---

### Task 2: 内置插件清单的窗口尺寸

**Files:**
- Modify: `plugins/todos/plugin.json`、`plugins/reminders/plugin.json`、`plugins/weather/plugin.json`、`plugins/system/plugin.json`、`plugins/pomodoro/plugin.json`、`plugins/clipboard/plugin.json`、`plugins/chat-history/plugin.json`、`plugins/music-player/plugin.json`、`plugins/tasks/plugin.json`
- Test: `test/unit/plugin-builtin-contracts.test.js`

**Interfaces:**
- Consumes: Task 1 的 `PLUGIN_WINDOW_LIMITS`
- Produces: 10 个内置插件 `window` 段的尺寸如下（screen-recorder 不动）：

| 插件 | width | height |
|---|---|---|
| todos | 640 | 600 |
| reminders | 640 | 600 |
| weather | 620 | 520 |
| system | 640 | 480 |
| pomodoro | 620 | 520 |
| clipboard | 720 | 560 |
| chat-history | 860 | 680 |
| music-player | 780 | 620 |
| tasks | 760 | 620 |
| screen-recorder | 900 | 620（不动） |

- [ ] **Step 1: 写失败的测试**

在 `test/unit/plugin-builtin-contracts.test.js` 里加（`IDS` 现在只列了 5 个，另建一个全量清单）：

```js
const ALL_IDS = [
  'chat-history', 'clipboard', 'music-player', 'pomodoro', 'reminders',
  'screen-recorder', 'system', 'tasks', 'todos', 'weather',
];

test('内置插件：独立窗口都是宽版（宽度 ≥ 620，内容区才够 560）', async () => {
  for (const id of ALL_IDS) {
    const raw = JSON.parse(await readFile(join(PLUGINS_DIR, id, 'plugin.json'), 'utf8'));
    const spec = resolveWindowSpec(raw, PLUGIN_WINDOW_MODE.WINDOW);
    assert.ok(spec.width >= 620, `插件「${id}」的窗口宽度 ${spec.width} 不够宽`);
    assert.ok(spec.height >= 480, `插件「${id}」的窗口高度 ${spec.height} 不够高`);
  }
});
```

（`resolveWindowSpec` 与 `PLUGIN_WINDOW_MODE` 要从 `../../src/shared/plugin.js` 导入——该文件已经导入了 `validateManifest`，把这两个加进那一行。）

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/plugin-builtin-contracts.test.js`
Expected: FAIL —— 插件「todos」的窗口宽度 320 不够宽。

- [ ] **Step 3: 改 9 个清单**

按上表改这 9 个 `plugin.json` 的 `window.width` / `window.height`，**只改这两个数**，别的字段一字不动。
`plugins/music-player/plugin.json` 已有未提交改动：只改 `window` 里的两个数，别碰别的（改完 `git diff plugins/music-player/plugin.json` 看一眼，确认没有把别人的改动带进来）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/unit/plugin-builtin-contracts.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add plugins/*/plugin.json test/unit/plugin-builtin-contracts.test.js
git commit -m "feat(plugin): 内置插件的独立窗口调成 PC 尺寸"
```

---

### Task 3: 宿主：记住独立窗口的尺寸

**Files:**
- Modify: `src/main/plugins/host.js`（prefs 读写处约 146–168 行、启动时读 prefs 处约 195–216 行、返回对象约 845–934 行）
- Test: `test/unit/plugin-host.test.js`

**Interfaces:**
- Consumes: `PLUGIN_WINDOW_LIMITS`（Task 1）
- Produces:
  - `host.getWindowSize(id) -> { width: number, height: number } | null`
  - `host.setWindowSize(id, { width, height }) -> Promise<boolean>`（越界夹到上下限；写盘失败返回 false）
  - 落盘位置：`<userData>/plugins.json` 的 `windowSizes` 段，形状 `{ "<pluginId>": { "width": n, "height": n } }`

- [ ] **Step 1: 写失败的测试**

在 `test/unit/plugin-host.test.js` 里加（同文件里已经有 `makePlugin` / `fakeAssistant`，
造宿主的写法照抄那一段：`makePlugin(root, 'todos', { id: 'todos', name: '待办' })` →
`createPluginHost({ rootDir: root, userDataDir: userData, assistant: fakeAssistant(), openSettings: () => {} })` →
`await host.load()`）：

```js
test('宿主：记住独立窗口的尺寸（落在 plugins.json 的 windowSizes 里）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = join(root, 'userdata');
  await mkdir(userData, { recursive: true });
  try {
    await makePlugin(root, 'todos', { id: 'todos', name: '待办' });
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    assert.equal(host.getWindowSize('todos'), null);
    assert.equal(await host.setWindowSize('todos', { width: 800, height: 600 }), true);
    assert.deepEqual(host.getWindowSize('todos'), { width: 800, height: 600 });

    const saved = JSON.parse(await readFile(join(userData, 'plugins.json'), 'utf8'));
    assert.deepEqual(saved.windowSizes.todos, { width: 800, height: 600 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：记住的尺寸会被夹到上下限里', async () => {
  // …同样的搭法（临时目录 + 造插件 + 造宿主 + load）…
  await host.setWindowSize('todos', { width: 999999, height: 1 });
  assert.deepEqual(host.getWindowSize('todos'), {
    width: PLUGIN_WINDOW_LIMITS.maxWidth,
    height: PLUGIN_WINDOW_LIMITS.minHeight,
  });
});
```

（该文件已经 import 了 `PLUGIN_WINDOW_LIMITS`；`readFile` 若没 import 就加上。）

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/plugin-host.test.js`
Expected: FAIL —— `host.getWindowSize is not a function`。

- [ ] **Step 3: 实现**

在 `src/main/plugins/host.js` 里：

- 启动时读 prefs 的地方（与 `configStore` 并排）建一个 `windowSizeStore`：

  ```js
  const windowSizeStore = new Map(
    Object.entries(prefs?.windowSizes && typeof prefs.windowSizes === 'object' ? prefs.windowSizes : {})
      .filter(([, v]) => v && typeof v === 'object')
      .map(([k, v]) => [k, { width: Number(v.width) || 0, height: Number(v.height) || 0 }])
  );
  ```

- 两个函数（放在 `setConfig` 旁边）：

  ```js
  function getWindowSize(id) {
    const size = windowSizeStore.get(String(id || ''));
    return size ? { ...size } : null;
  }

  async function setWindowSize(id, size) {
    const key = String(id || '');
    if (!key) return false;
    const width = Math.min(PLUGIN_WINDOW_LIMITS.maxWidth, Math.max(PLUGIN_WINDOW_LIMITS.minWidth, Math.round(Number(size?.width) || 0)));
    const height = Math.min(PLUGIN_WINDOW_LIMITS.maxHeight, Math.max(PLUGIN_WINDOW_LIMITS.minHeight, Math.round(Number(size?.height) || 0)));
    windowSizeStore.set(key, { width, height });
    prefs = { ...prefs, windowSizes: Object.fromEntries(windowSizeStore) };
    try {
      await writeJson(userDataDir, PREFS_FILE, prefs);
    } catch (err) {
      console.warn('[desk-pet] 窗口尺寸保存失败：', err?.message);
      return false;
    }
    return true;
  }
  ```

  （`PLUGIN_WINDOW_LIMITS` 要加进该文件从 `../../src/shared/plugin.js` 的 import 列表。）

- 返回对象里加两行：`getWindowSize`、`setWindowSize`。

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/unit/plugin-host.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/plugins/host.js test/unit/plugin-host.test.js
git commit -m "feat(plugin): 宿主记住每个插件的窗口尺寸"
```

---

### Task 4: 窗口控制器：用记住的尺寸开窗、拖动后写回、恢复默认尺寸

**Files:**
- Modify: `src/main/plugins/window.js`（`createWindow` 约 112–148 行；IPC 段约 359–389 行）
- Modify: `src/preload/plugin.cjs`（`window` 那段，约 105–113 行）
- Modify: `src/renderer/plugin-window/index.html`（标题栏按钮，约 107–113 行）
- Modify: `src/renderer/plugin-window/main.js`（按钮处理，约 61–90 行）
- Test: `test/e2e/plugin-detach.spec.js`

**Interfaces:**
- Consumes: Task 3 的 `host.getWindowSize(id)`、`host.setWindowSize(id, size)`
- Produces:
  - IPC `plugin:window:resetSize`（invoke，无参，返回 boolean）
  - preload：`window.plugin.window.resetSize() -> Promise<boolean>`
  - 壳里的按钮 `#reset-size`（标题栏里，排在 `#pin` 前面）

- [ ] **Step 1: 写失败的端到端测试**

在 `test/e2e/plugin-detach.spec.js` 里加一个 test（复用该文件现成的 `launch` / `openPanel` / `findWindow`）：

```js
test('独立窗口：比面板宽，拖过的尺寸被记住，⤢ 能恢复默认', async () => {
  const { app, pet } = await launch();
  try {
    const panel = await openPanel(app, pet);
    await panel.fill('#query', 'daiban');
    await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, { timeout: 10000 });
    await panel.click('#results li:has-text("待办")');
    await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
    await panel.click('#detach');

    const win = await findWindow(app, '/renderer/plugin-window/index.html');
    expect(win, '待办的独立窗口没有出现').not.toBeNull();
    await win.waitForLoadState('domcontentloaded');

    // 独立窗口比面板宽得多（清单里待办是 640×600）。
    const size = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getURL().includes('/renderer/plugin-window/index.html'));
      return w ? w.getSize() : null;
    });
    expect(size[0]).toBeGreaterThanOrEqual(620);

    // 拖过之后：尺寸被记住（重新打开还是这个大小）。
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getURL().includes('/renderer/plugin-window/index.html'));
      w.setSize(700, 500);
    });
    await new Promise((r) => setTimeout(r, 800)); // 等去抖写盘
    await win.click('#close');
    await new Promise((r) => setTimeout(r, 500));

    // 面板在分离时收起来了：再打开一次，回到搜索视图。
    await openPanel(app, pet);
    await panel.fill('#query', 'daiban');
    await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, { timeout: 10000 });
    await panel.click('#results li:has-text("待办")');
    await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
    await panel.click('#detach');
    const win2 = await findWindow(app, '/renderer/plugin-window/index.html');
    await win2.waitForLoadState('domcontentloaded');
    const size2 = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getURL().includes('/renderer/plugin-window/index.html'));
      return w ? w.getSize() : null;
    });
    expect(size2[0]).toBe(700);
    expect(size2[1]).toBe(500);

    // ⛶：恢复成清单里的尺寸（待办 640×600）。
    await win2.click('#reset-size');
    await new Promise((r) => setTimeout(r, 500));
    const size3 = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getURL().includes('/renderer/plugin-window/index.html'));
      return w ? w.getSize() : null;
    });
    expect(size3[0]).toBe(640);
    expect(size3[1]).toBe(600);
  } finally {
    await app.close();
  }
});
```

（待办的搜索关键词用 `daiban`——它在 `plugins/todos/plugin.json` 的 `keywords` 里；若清单里没有这个关键词，就用清单里实际有的那个中文词「待办」。）

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx playwright test test/e2e/plugin-detach.spec.js`
Expected: FAIL —— `#reset-size` 不存在（`win2.click('#reset-size')` 超时），或尺寸仍是清单值（没记住）。

- [ ] **Step 3: 实现主进程那一半**

`src/main/plugins/window.js`：

- `createWindow` 里算尺寸（替掉现在的 `width: spec.width, height: spec.height`）：

  ```js
  const remembered = isWidget ? null : host.getWindowSize?.(pluginId);
  const width = remembered?.width || spec.width;
  const height = remembered?.height || spec.height;
  ```

  然后 `new BrowserWindow({ width, height, … })`。

- 记住拖动（**只在窗口形态**；小部件的尺寸是清单定的）：

  ```js
  if (!isWidget) {
    let timer = null;
    win.on('resize', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const [w, h] = win.getSize();
        void host.setWindowSize?.(pluginId, { width: w, height: h });
      }, 400);
    });
  }
  ```

- 恢复默认尺寸的 IPC（放在 `plugin:window:close` 旁边）：

  ```js
  ipcMain.handle('plugin:window:resetSize', (event) => {
    const pluginId = senderPluginId(event);
    const entry = pluginId ? entryOf(pluginId) : null;
    if (!entry || entry.mode === PLUGIN_WINDOW_MODE.WIDGET) return false;
    const spec = host.spec(pluginId, PLUGIN_WINDOW_MODE.WINDOW);
    if (!spec) return false;
    entry.win.setBounds({ ...entry.win.getBounds(), width: spec.width, height: spec.height });
    void host.setWindowSize?.(pluginId, { width: spec.width, height: spec.height });
    return true;
  });
  ```

- [ ] **Step 4: 实现渲染层那一半**

`src/preload/plugin.cjs` 的 `window` 那段加一行：

```js
resetSize: () => ipcRenderer.invoke('plugin:window:resetSize'),
```

`src/renderer/plugin-window/index.html` 的标题栏里，在 `#pin` **前面**加：

```html
<button id="reset-size" title="恢复默认尺寸">⛶</button>
```

`src/renderer/plugin-window/main.js`：取元素、加事件、在 `syncState()` 里像 `pin` 那样按形态藏起来（小部件里没有「默认尺寸」这回事）：

```js
const resetSizeEl = document.getElementById('reset-size');
// ……
resetSizeEl.hidden = state.mode === 'widget';
// ……
resetSizeEl.addEventListener('click', () => {
  void window.plugin?.window?.resetSize?.();
});
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npx playwright test test/e2e/plugin-detach.spec.js`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/plugins/window.js src/preload/plugin.cjs src/renderer/plugin-window/index.html src/renderer/plugin-window/main.js test/e2e/plugin-detach.spec.js
git commit -m "feat(plugin): 独立窗口记住拖过的尺寸，并能恢复默认"
```

---

### Task 5: 响应式：容器套在 iframe 宽度那一层，积木宽版分两列

**Files:**
- Modify: `src/renderer/panel/index.html`（`<section id="plugin">`，约 228 行）
- Modify: `src/renderer/plugin-window/index.html`（`#win`，约 106 行）
- Modify: `src/renderer/ui/blocks.css`（文件末尾追加宽版规则）
- Modify: `src/renderer/ui/theme.css`（`.surface` 那段注释，约 146–158 行）
- Test: `test/e2e/plugin-responsive.spec.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `src/renderer/ui/theme.css` 里已有的 `.surface` 类成为**唯一**的宽版判据（容器名 `surface`、类型 `inline-size`）——本任务不改这个类本身，只改它上面的注释。
  - 积木宽版规则：`.block-list` 两列、`.block-settings` 两列，断点 560px。

- [ ] **Step 1: 写失败的端到端测试**

新建 `test/e2e/plugin-responsive.spec.js`（照抄 `test/e2e/plugin-detach.spec.js` 的 `launch` / `openPanel` / `findWindow`，`USER_DATA` 用 `join(ROOT, '.tmp-e2e-responsive')`）：

```js
test('宽窄由宽度决定：面板窄版、独立窗口宽版、拖窄了又变窄版', async () => {
  const { app, pet } = await launch();
  try {
    const panel = await openPanel(app, pet);
    await panel.fill('#query', 'daiban');
    await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, { timeout: 10000 });
    await panel.click('#results li:has-text("待办")');
    await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });

    // 待办是空的时画的是「空态」块，没有列表——先加一条，列表才在。
    await panel.fill('#plugin-body input[type="text"]', '写测试');
    await panel.press('#plugin-body input[type="text"]', 'Enter');
    await panel.waitForFunction(() => document.querySelector('.block-list'), null, { timeout: 10000 });

    // 面板里：单列（容器查询不命中）。
    const inPanel = await panel.evaluate(() => {
      const list = document.querySelector('.block-list');
      return list ? getComputedStyle(list).columnCount : 'none';
    });
    expect(inPanel).toBe('auto');

    // 独立窗口：两列。
    await panel.click('#detach');
    const win = await findWindow(app, '/renderer/plugin-window/index.html');
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => document.querySelector('.block-list'), null, { timeout: 10000 });
    const inWindow = await win.evaluate(() => getComputedStyle(document.querySelector('.block-list')).columnCount);
    expect(inWindow).toBe('2');

    // 拖窄到 560 以下：退回窄版。
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getURL().includes('/renderer/plugin-window/index.html'));
      w.setSize(500, 500);
    });
    await new Promise((r) => setTimeout(r, 400));
    const narrowed = await win.evaluate(() => getComputedStyle(document.querySelector('.block-list')).columnCount);
    expect(narrowed).toBe('auto');
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx playwright test test/e2e/plugin-responsive.spec.js`
Expected: FAIL —— 独立窗口里 `columnCount` 是 `auto`（宽版规则还不存在）。

- [ ] **Step 3: 套容器**

`src/renderer/panel/index.html`：`<section id="plugin" hidden>` → `<section id="plugin" class="surface" hidden>`
`src/renderer/plugin-window/index.html`：`<div id="win" data-mode="window">` → `<div id="win" class="surface" data-mode="window">`

**为什么是这两层**：它们的宽度**等于 iframe 的宽度**（面板 ≈394、窗口 = 窗口宽 − 2），
所以容器量到的数就是插件页的视口宽度——积木与插件页不会一个宽版一个窄版。

- [ ] **Step 4: 加宽版规则**

`src/renderer/ui/blocks.css` 末尾追加：

```css
/* 宽版（独立窗口）：条目型内容分两列，一屏看完更多。 */
@container surface (min-width: 560px) {
  .block-list { columns: 2; column-gap: 20px; }
  .block-list li { break-inside: avoid; }
  .block-settings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; }
}
```

- [ ] **Step 5: 改对 theme.css 的注释**

`src/renderer/ui/theme.css` 的 `.surface` 那段注释改成：容器查询给**宿主画的积木界面**用
（宿主给内容区套 `.surface`）；**插件自带页面在 iframe 里，跨不过 iframe 边界**，
要按宽度切版就用 `@media (min-width: 560px)`（页面自己的视口宽度就是 iframe 的宽度）。
注释保持三五行，不要长篇。

- [ ] **Step 6: 跑测试，确认通过**

Run: `npx playwright test test/e2e/plugin-responsive.spec.js`
Expected: PASS。

再跑一次已有的面板用例，确认面板没被改坏：

Run: `npx playwright test test/e2e/plugin-surface.spec.js`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/panel/index.html src/renderer/plugin-window/index.html src/renderer/ui/blocks.css src/renderer/ui/theme.css test/e2e/plugin-responsive.spec.js
git commit -m "feat(plugin): 宽窄由宽度决定，积木界面在宽窗口里分两列"
```

---

### Task 6: 插件自带页面的宽版布局（5 个内置插件）

**Files:**
- Modify: `plugins/music-player/pages/player.html`
- Modify: `plugins/chat-history/pages/history.html`
- Modify: `plugins/clipboard/pages/history.css`
- Modify: `plugins/tasks/pages/board.html`
- Modify: `plugins/screen-recorder/pages/studio.css`
- Test: `test/e2e/plugin-responsive.spec.js`（接着 Task 5 的文件加）

**Interfaces:**
- Consumes: Task 5 的断点 560px（同一个数）
- Produces: 每个自带页面的插件一份宽版布局，窄版（面板里、小部件里）的样子**一字不变**。

各插件的宽版长什么样（照这张表实现，不要另发挥）：

| 插件 | 文件 | 宽版规则（`@media (min-width: 560px)` 里） |
|---|---|---|
| music-player | `pages/player.html` | `#wrap` 变两栏：`grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)`；`#head` 跨两列（`grid-column: 1 / -1`）；`#now` `#bar` `#times` `#controls` 在第 1 列；`#pl-bar` `#pl-new-row` `#lib-head` `#list` 在第 2 列；`#list` 的 `max-height` 在宽版去掉（让它铺满右栏）。`#wrap` 原本是 `display: flex; flex-direction: column`，宽版改成 grid。 |
| chat-history | `pages/history.html` | `#list` 变两栏：`display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; align-items: start;`；`.day` 用 `display: contents`（让组里的块直接进格子）；`.day-title` 跨两列（`grid-column: 1 / -1`）。 |
| clipboard | `pages/history.css` | `.clip-list` 变两栏：`display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px;`；`.clip-list .group`（分组标题）跨两列（`grid-column: 1 / -1`）。 |
| tasks | `pages/board.html` | `#overview` 变两栏：`display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; align-items: start;`。三个分节（`#current-sec` `#pending-sec` `#tasks-sec`）各自带标题，自动排成两列。 |
| screen-recorder | `pages/studio.css` | 它自己的 `.studio` **就是那个 `surface` 容器**，所以继续用容器查询：把 `@container surface (max-width: 460px)` 的阈值改成 `559px`，与 560 断点对齐。**面板里与窗口里的样子都不变。** |

- [ ] **Step 1: 写失败的端到端测试**

在 `test/e2e/plugin-responsive.spec.js` 里加（同一个 app 实例里依次开 4 个插件的独立窗口；录屏不在这里断言——本机多显示器环境会让录屏的 e2e 必挂）：

```js
const CASES = [
  { id: 'music-player', query: 'yinyue', sel: '#wrap' },
  { id: 'chat-history', query: 'jiaoli', sel: '#list' },
  { id: 'clipboard', query: 'jiban', sel: '.clip-list' },
  { id: 'tasks', query: 'houtai', sel: '#overview' },
];

test('插件自带页面：独立窗口里是宽版（两栏），面板里是窄版', async () => {
  const { app, pet } = await launch();
  try {
    for (const c of CASES) {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', c.query);
      await panel.waitForFunction((id) => window.__panel?.resultIds?.includes(id), c.id, { timeout: 10000 });
      await panel.click(`#results li[data-plugin-id="${c.id}"]`);

      // 面板里：单栏（窄版）。
      const narrow = await panel.evaluate((sel) => {
        const frame = document.getElementById('plugin-frame');
        const doc = frame?.contentDocument;
        const el = doc?.querySelector(sel);
        return el ? getComputedStyle(el).gridTemplateColumns : 'none';
      }, c.sel);
      expect(narrow, `${c.id} 在面板里不该是两栏`).toBe('none');

      // 独立窗口里：两栏（宽版）。
      await panel.click('#detach');
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      await win.waitForLoadState('domcontentloaded');
      const frame = win.frameLocator('#plugin-frame');
      await frame.locator(c.sel).first().waitFor({ timeout: 10000 });
      const wide = await frame.locator(c.sel).first().evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns
      );
      expect(wide.split(' ').length, `${c.id} 在独立窗口里不是两栏`).toBe(2);

      await win.click('#close');
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    await app.close();
  }
});
```

（`#results li` 的行上有 `data-plugin-id`（见 `src/renderer/panel/main.js` 的 `li.dataset.pluginId`）✓；搜索词用各插件 `keywords` 里的拼音：music-player 有 `yinyue`、chat-history 有 `jiaoli`… 若某个词不在清单里，改用清单里实际有的那个。）

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx playwright test test/e2e/plugin-responsive.spec.js`
Expected: FAIL —— 独立窗口里 `gridTemplateColumns` 还是 `none`（宽版规则还不存在）。

- [ ] **Step 3: 写 5 个插件的宽版**

按上面那张表改 5 个文件，**只在文件末尾（或紧跟相关选择器的地方）追加** `@media (min-width: 560px) { … }`，不要动窄版的规则。

`plugins/music-player/pages/player.html` 已有未提交改动：先 `git diff plugins/music-player/pages/player.html` 看清楚，改完再 diff 一遍，确认没有覆盖既有改动。

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx playwright test test/e2e/plugin-responsive.spec.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add plugins/music-player/pages/player.html plugins/chat-history/pages/history.html plugins/clipboard/pages/history.css plugins/tasks/pages/board.html plugins/screen-recorder/pages/studio.css test/e2e/plugin-responsive.spec.js
git commit -m "feat(plugin): 自带页面的插件补上宽版布局"
```

---

### Task 7: 文档

**Files:**
- Modify: `docs/开发说明/插件开发指南.md`
- Modify: `docs/开发说明/插件系统架构.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1–6 的最终行为
- Produces: 三份文档里的说法与代码一致。

- [ ] **Step 1: 改插件开发指南**

在「窗口与小部件」那节里补：

- `window.width/height` 是**独立窗口**的尺寸（清单里的值）；没写 `window` 段时宿主合成 720×560。
- **用户拖过的尺寸会被记住**（存在 `plugins.json` 的 `windowSizes` 段），下次打开按上次的开；独立窗口标题栏的「⛶」按钮恢复清单里的尺寸。
- 插件自带页面在窄的时候（面板里、约 394 宽）与宽的时候（独立窗口里）可以有两套布局：
  **用 `@media (min-width: 560px)`**（页面自己的视口宽度就是 iframe 的宽度）。
  容器查询跨不过 iframe 边界，插件页面里 `@container surface (…)` 查不到宿主的东西——
  要用就在**自己的页面里**定义容器（录屏的 `.studio` 就是这么做的）。
- 窄版是默认，宽版在媒体查询里覆盖；窄版的样子不要动（面板里就靠它）。

- [ ] **Step 2: 改插件系统架构**

在「窗口与小部件」那节补：

- 尺寸的来源：清单 → 记住的（`windowSizes`）→ 清单里的默认值；小部件不参与记忆。
- 两个响应式机制与它们的容器位置（面板 `<section id="plugin">`、窗口壳 `#win`——宽度等于 iframe 宽度，所以两个机制量的是同一个盒子）。
- 断点 560px 一个数。

- [ ] **Step 3: 改 README**

「独立窗口与桌面小部件」那节补一句：独立窗口默认 720×560（内置插件各有各的尺寸），
拖过的尺寸会被记住，标题栏的「⛶」能恢复默认。

- [ ] **Step 4: 跑一遍全部单元测试**

Run: `npm run test:unit`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add docs/开发说明/插件开发指南.md docs/开发说明/插件系统架构.md README.md
git commit -m "docs(plugin): 写清宽窄两版与窗口尺寸的记忆"
```

---

## 自查（对照 spec）

| spec 的要求 | 在哪个任务 |
|---|---|
| G1 默认 720×560、内置插件尺寸调大 | Task 1、Task 2 |
| G2 宽窄由宽度决定、面板与窗口是两种东西 | Task 5、Task 6 |
| G3 积木宽版分两列 | Task 5 |
| G4 插件自带页面各有一版宽布局 | Task 6 |
| G5 记住拖过的尺寸 + 恢复默认 | Task 3、Task 4 |
| G6 面板外观不变 | Task 5（面板里仍是单列，由 e2e 断言） |
| 非目标：不加协议字段、不加块类型、不动小部件 | 全部任务都没碰 ✓ |
| Review Focus 1（拖窄要整个退回窄版） | Task 5 的 e2e |
| Review Focus 2（尺寸越界要夹住） | Task 3 的单元测试 |
| Review Focus 3（小部件的拖动不记） | Task 4：`resize` 监听只在窗口形态挂 ✓（小部件那段代码路径不写盘） |
| Review Focus 4（没写 window 段的按 720×560） | Task 1 的单元测试 |
| Review Focus 5（面板按内容撑高的契约） | Task 5 跑 `plugin-surface.spec.js` 回归 ✓ |
| Review Focus 6（面板里积木仍单列） | Task 5 的 e2e ✓ |
