# 录屏插件重做 —— 实施计划（第二期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录屏的界面换成**一套**响应式的暖色卡片（面板工作台与独立窗口共用同一份），切模式与开始录制不再卡，GIF 逐帧不再拖慢界面。

**Architecture:** 录屏写一个自己的页面 `pages/studio.html`（走 `app://`，链宿主的主题），宿主把它装进面板工作台与独立窗口两处（第一期做好的那套）。性能上分四刀：目标列表**一次列全、缓存起来**；捕获窗口**常驻不销毁**；录制的字节**流式写盘**；GIF 编码器改成**全局调色板**，颜色缓存跨帧复用。

**Tech Stack:** Electron 45（主进程 + preload）、`app://` 自定义协议、`desktopCapturer` / `MediaRecorder` / `MediaStream`、纯 JS 的 GIF89a 编码器、`node --test`（单元）、`@playwright/test` `_electron`（端到端）。

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-surface-design.md`（§6 录屏插件改动、§7 性能改动）

**前置**：第一期（`docs/superpowers/plans/2026-11-05-plugin-surface.md`）必须**先做完**——
录屏的自带页面要靠它才能装进面板工作台与独立窗口。

## Global Constraints

以下几条来自 spec，**每个任务都隐含包含**：

- 录屏**保留三个自建窗口**：隐藏的捕获页、选区遮罩、桌面控制条。它们是**录屏业务**，不是插件界面。
- 录屏的**隐藏捕获页继续走 `file://`**：它在 `persist:screen-recorder` 分区里，
  分区没有注册 `app://` 协议；`file://` 在 Chromium 里是 secure context，
  `navigator.mediaDevices` 能用（已实测）。
- 录屏的**界面页走 `app://`**（`pages/studio.html`）：它要链宿主的主题、
  用 ES module、并且被宿主装进两处。
- 录屏的 `tick(ctx)` 必须**便宜**：清单声明了 `refreshMs: 250`，
  所以 `tick` 里只读内存，**不许**调 `getSources()` 或读磁盘。
- `meta(ctx)` 返回 `{ title, subtitle, status }`——宿主只取这三个（带自带页面的插件，
  `page(ctx)` 不许做重活）。
- 录屏的**快捷键只在界面开着时生效**：录屏的独立窗口开着，或面板正显示录屏。
- 视觉一律走**桌宠的暖色卡片风**：`theme.css` 的变量与组件，不写死颜色。
- 录屏**没有小部件形态**：清单里不写 `widget` 段。
- 配置文件还是 `userData/screen-recorder.json`，原子写（先 `.tmp` 再 `rename`）。
- 文件名还是 `录屏_YYYYMMDD_HHMMSS.mp4` / `.gif`，重名自动加 `_2`。
- 全项目文案是中文；注释写中文，解释「为什么」。
- 提交信息沿用仓库风格：`feat(录屏): 描述` / `fix(录屏): 描述`。

## Review Focus

| # | 输入 / 情况 | 合理的人会期望 | 落在 |
| --- | --- | --- | --- |
| 1 | 录制**中途**失败（写盘失败、轨道断了） | 不留下一个「看着像录好了其实是坏的」文件 | Task 4 |
| 2 | 录**很长**一段（几分钟） | 内存**不随录制时长增长**（不攒全量字节） | Task 4 |
| 3 | 目标窗口在录制**途中被关掉** | 录制自动停下来，**已经录的照样存下来** | Task 2 |
| 4 | 选区模式下用户**取消**框选 | 回到空闲，什么都不发生，不留下半个文件 | Task 3 |
| 5 | GIF 的画面**颜色很多**（超过 256 色） | 量化到 256 色，索引不越界，文件能正常解开 | Task 5 |

---

## 与 spec 的一处偏差（先说清楚）

spec §7.5 写的是「量化 + LZW 搬进 **Web Worker**」。实施时发现这条路走不通，
于是换了做法：

- 捕获页走 `file://`，而 **Chromium 默认禁止 `file://` 页面创建 Worker**
  （Worker 脚本的 origin 是 `null`，被拦掉）。blob: Worker 也不行（同样的原因）。
- 真正让 GIF 卡的不是「量化」也不是「LZW」，而是 **`mapIndices()` 每帧重建颜色缓存**：
  它的注释自己写着「每帧 23 万像素 × 256 色线性查找，单帧要 200ms 以上」。
  而缓存**没法跨帧复用**——因为**每帧的调色板都不一样**，上一帧的索引在新调色板上是错的。

所以本计划改成：**整段 GIF 用一份全局调色板**（第一帧量化出来），
颜色缓存于是可以跨帧复用，每帧的映射从 200ms 降到几毫秒——
**Worker 就不必要了**。附带好处：文件更小（一张全局颜色表，不用每帧一张局部表）。

代价：调色板由第一帧决定，画面剧变时颜色可能不够准。这是 GIF 编码器的常见取舍。

---

## 文件结构

**新建：**

| 文件 | 职责 |
| --- | --- |
| `plugins/screen-recorder/lib/targets.js` | 可录目标的缓存：一次列全，切模式只切缓存 |
| `plugins/screen-recorder/pages/studio.html` | 录屏的界面（面板工作台与独立窗口共用这一份） |
| `plugins/screen-recorder/pages/studio.css` | 它的样式：暖色卡片 + 容器查询 |
| `plugins/screen-recorder/pages/studio.js` | 它的逻辑：读状态、发动作 |
| `test/unit/screen-recorder-targets.test.js` | 目标缓存的单元测试 |

**修改：**

| 文件 | 改什么 |
| --- | --- |
| `plugins/screen-recorder/plugin.json` | 加 `window` 段（指向 `pages/studio.html`） |
| `plugins/screen-recorder/main.js` | 加 `meta(ctx)` 与 `act(ctx, …)`；用目标缓存；新的快捷键语义 |
| `plugins/screen-recorder/lib/capture.js` | 用缓存的目标；捕获窗口常驻；流式写盘；选区截图走二进制 |
| `plugins/screen-recorder/lib/windows.js` | 捕获窗口常驻 + 预热；删掉工作台窗口 |
| `plugins/screen-recorder/lib/page.js` | 降级为兜底（不再列目标） |
| `plugins/screen-recorder/pages/recorder.js` | 分块发字节；`requestVideoFrameCallback` |
| `plugins/screen-recorder/pages/picker.js` | 收 PNG 字节而不是 base64 |
| `plugins/screen-recorder/web/gif.js` | 全局调色板 + 跨帧复用颜色缓存 |
| `plugins/screen-recorder/pages/control.html` | 按新设计系统重画 |
| `test/unit/screen-recorder-gif.test.js` | 断言改成「全局调色板」 |
| `test/e2e/screen-recorder.spec.js` | 工作台 → 界面页；快捷键语义；切模式不重列 |

**删除：**

| 文件 | 为什么 |
| --- | --- |
| `plugins/screen-recorder/pages/workbench.html` | 被 `studio.html` 取代 |
| `plugins/screen-recorder/pages/workbench.js` | 同上 |

---

## Task 1: 目标列表缓存——切模式不再等系统

**Files:**
- Create: `plugins/screen-recorder/lib/targets.js`
- Create: `test/unit/screen-recorder-targets.test.js`
- Modify: `plugins/screen-recorder/lib/capture.js`
- Modify: `plugins/screen-recorder/main.js`

**Interfaces:**
- Consumes: `desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: {0,0} })`。
- Produces:
  ```js
  createTargetCache({ listSources, ttlMs = 10000, now = () => Date.now() }) → {
    peek(mode) → 目标数组（可能过期，不等待）,
    ensure(mode) → Promise<目标数组>（必要时列一次）,
    refresh() → Promise<void>（强制重新列）,
    listingCount() → number（列过几次了——自动化要断言「切模式不重列」）,
  }
  ```
  `mode` ∈ `'screen' | 'window'`。

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/screen-recorder-targets.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTargetCache } from '../../plugins/screen-recorder/lib/targets.js';

/**
 * 目标缓存。
 *
 * 列一次目标要花掉几百毫秒（`desktopCapturer.getSources()` 在 Windows 上
 * 要把所有窗口挨个看一遍）。切模式就列一次的话，用户每点一下都要等。
 */

/** 假的目标来源：数着被叫了几次。 */
function fakeSources() {
  const calls = { count: 0 };
  const listSources = async () => {
    calls.count += 1;
    return [
      { id: 'screen:0:0', name: '显示器 1', display_id: '1', kind: 'screen' },
      { id: 'window:1:1', name: '记事本', display_id: '2', kind: 'window' },
      { id: 'window:2:2', name: '浏览器', display_id: '3', kind: 'window' },
    ];
  };
  return { calls, listSources };
}

test('第一次拿目标：列一次，屏幕与窗口分开', async () => {
  const { calls, listSources } = fakeSources();
  const cache = createTargetCache({ listSources });
  const screens = await cache.ensure('screen');
  assert.equal(screens.length, 1);
  assert.equal(screens[0].label, '显示器 1');
  assert.equal(screens[0].hint, '显示器');
  assert.equal(calls.count, 1);
});

test('切模式不重新列：缓存里切一组就完事', async () => {
  const { calls, listSources } = fakeSources();
  const cache = createTargetCache({ listSources });
  await cache.ensure('screen');
  const windows = await cache.ensure('window');
  assert.equal(windows.length, 2);
  assert.equal(windows[0].label, '记事本');
  assert.equal(calls.count, 1, '切模式不该再列一次');
  assert.equal(cache.listingCount(), 1);
});

test('peek 是同步的：给什么就是什么，不等', async () => {
  const { listSources } = fakeSources();
  const cache = createTargetCache({ listSources });
  assert.deepEqual(cache.peek('screen'), []);
  await cache.ensure('screen');
  assert.equal(cache.peek('screen').length, 1);
});

test('缓存过期：先给旧的，后台重新列', async () => {
  let now = 1000;
  const { calls, listSources } = fakeSources();
  const cache = createTargetCache({ listSources, ttlMs: 100, now: () => now });
  await cache.ensure('screen');
  assert.equal(calls.count, 1);
  now += 500; // 过期了
  // peek 不等待：直接给旧的那份。
  assert.equal(cache.peek('screen').length, 1);
  // 但后台已经在重新列了。
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.count, 2);
});

test('refresh：强制重新列一次', async () => {
  const { calls, listSources } = fakeSources();
  const cache = createTargetCache({ listSources });
  await cache.ensure('screen');
  await cache.refresh();
  assert.equal(calls.count, 2);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test test/unit/screen-recorder-targets.test.js
```

Expected: FAIL —— `Cannot find module '.../lib/targets.js'`。

- [ ] **Step 3: 实现**

新建 `plugins/screen-recorder/lib/targets.js`：

```js
// plugins/screen-recorder/lib/targets.js

/**
 * 可录目标的缓存。
 *
 * 列一次目标要花掉几百毫秒：`desktopCapturer.getSources()` 在 Windows 上
 * 要把系统里所有窗口挨个看一遍（这个插件自己的注释里记着：
 * 不要缩略图 0.4 秒，要缩略图 5.5 秒）。
 *
 * 切模式就列一次的话，用户每点一下「窗口」都要等一下——而**列表内容
 * 其实没变**（屏幕还是那些屏幕，窗口还是那些窗口）。
 *
 * 所以：**一次列全，拆成两组缓存起来**。切模式只切缓存里的那一组；
 * 缓存旧了就在**后台**重新列，不挡界面。
 */

/** 缓存保质期（毫秒）。超过就后台刷新。 */
const DEFAULT_TTL_MS = 10_000;

export function createTargetCache({ listSources, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() }) {
  /** 'screen' | 'window' → 目标数组。 */
  let byMode = { screen: [], window: [] };
  /** 上次列出来的时间。 */
  let listedAt = 0;
  /** 正在列的 promise：别同时列两次。 */
  let listing = null;
  /** 列过几次了（自动化要断言「切模式不重列」）。 */
  let listings = 0;

  function isFresh() {
    return now() - listedAt < ttlMs;
  }

  /** 列一遍，把屏幕与窗口分开存。 */
  async function listAll() {
    if (listing) return listing;
    listing = (async () => {
      try {
        const sources = await listSources();
        const screens = [];
        const windows = [];
        for (const s of sources) {
          const item = {
            id: s.id,
            label: s.name || s.id,
            // 显示器模式下，选区要按「用户选的那块屏」来框。
            displayId: s.display_id || '',
          };
          if (s.kind === 'window') windows.push({ ...item, hint: '窗口' });
          else screens.push({ ...item, hint: '显示器' });
        }
        byMode = { screen: screens, window: windows };
        listedAt = now();
        listings += 1;
      } finally {
        listing = null;
      }
    })();
    return listing;
  }

  return {
    /**
     * 同步看一眼缓存。
     *
     * 给什么就是什么——**不等**。缓存旧了就顺手在后台重新列。
     */
    peek(mode) {
      if (!isFresh() && !listing) {
        // 后台刷新，不 await：界面这一下不能等。
        void listAll().catch((err) => {
          console.warn('[录屏] 刷新目标失败：', err?.message);
        });
      }
      return byMode[mode] || [];
    },

    /** 拿某一组目标；缓存没有或过期了就列一次。 */
    async ensure(mode) {
      if (isFresh()) return byMode[mode] || [];
      await listAll();
      return byMode[mode] || [];
    },

    /** 强制重新列一遍（用户点了「刷新」）。 */
    async refresh() {
      await listAll();
    },

    /** 列过几次了。 */
    listingCount: () => listings,
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --test test/unit/screen-recorder-targets.test.js
```

Expected: PASS，5 个测试全过。

- [ ] **Step 5: `capture.js` 改用缓存**

`plugins/screen-recorder/lib/capture.js`：

顶部 import 加一行：

```js
import { createTargetCache } from './targets.js';
```

把 `listTargets` 整个换掉：

```js
  /**
   * 可录的目标（显示器/窗口）。
   *
   * **一次列全，缓存起来**：切模式不再等系统。
   */
  const targets = createTargetCache({
    listSources: () =>
      desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      }),
  });
```

**注意**：`desktopCapturer.getSources()` 返回的每一项**没有** `kind` 字段——
它按 `types` 分组返回。这里一次要两种，所以要自己分。

上面那段 `getSources` 调用返回的是**混在一起**的列表。改 `listAll()` 里的分法：
`getSources({types:['screen','window']})` 返回的每一项有 `id`（形如 `screen:0:0`
或 `window:123:456`），**没有** `kind` 字段。所以要**从 id 的前缀**判断：

```js
        for (const s of sources) {
          const item = {
            id: s.id,
            label: s.name || s.id,
            displayId: s.display_id || '',
          };
          // getSources 不给「这是屏幕还是窗口」的字段，
          // 但 id 一定带前缀：`screen:0:0` / `window:123:456`。
          if (String(s.id).startsWith('window:')) windows.push({ ...item, hint: '窗口' });
          else screens.push({ ...item, hint: '显示器' });
        }
```

把上面测试里的 `kind: 'screen'` / `kind: 'window'` 改成 `id: 'screen:0:0'` /
`id: 'window:1:1'` 即可（测试里的假来源要跟真实来源长得一样）。

`capture.js` 里 `createCaptureSession` 的返回值，把 `listTargets` 换成三个新方法：

```js
  return {
    peekTargets: (mode) => targets.peek(mode),
    ensureTargets: (mode) => targets.ensure(mode),
    refreshTargets: () => targets.refresh(),
    listingCount: () => targets.listingCount(),
    pickRegion,
    start,
    stop,
    save,
    fail,
    cancel,
    warn,
    notifyReady,
    isRecording,
    dispose,
  };
```

**删掉**原来的 `listTargets` 函数（第 47-63 行）。

- [ ] **Step 6: `main.js` 用缓存**

`plugins/screen-recorder/main.js`：

`page()` 里那段「第一次打开面板时还没有目标列表」改成：

```js
  /** 面板页面。 */
  async function page(currentCtx) {
    if (currentCtx?.update) update = currentCtx.update;
    const cfg = await ensureConfig();
    // 目标列表**只列一次**（后面切模式都在缓存里切）。
    // 这里仍然 await 一下：第一次打开面板时得等它列完才有东西显示。
    targets = await capture.ensureTargets(cfg.mode);
    return buildPanelPage(ctx.ui, { config: cfg, targets, recording, status });
  }
```

`handleAction()` 里 `mode:` 那一段改成：

```js
    if (actionId.startsWith('mode:')) {
      const mode = actionId.slice('mode:'.length);
      await save({ mode });
      status = '';
      // 换了模式，能录的目标也换了（显示器 / 窗口）——
      // 但**不重新列**：缓存里就有，切一下就行。
      targets = capture.peekTargets(mode);
      // 缓存旧了的话，peek 会在后台重新列；这里不等它。
    }
```

`startRecordingInner()` 里那行 `const list = await capture.listTargets(cfg.mode);` 改成：

```js
    const list = await capture.ensureTargets(cfg.mode);
```

**注意**：这里用 `ensure` 而不是 `peek`——开始录制要的是**当下**的目标
（缓存过期时列一次是对的）。但 `ensure` 在缓存新鲜时是**不列**的 ✓。

- [ ] **Step 7: 跑全部单元测试**

```bash
npm run test:unit
```

Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add plugins/screen-recorder/lib/targets.js plugins/screen-recorder/lib/capture.js plugins/screen-recorder/main.js test/unit/screen-recorder-targets.test.js
git commit -m "perf(录屏): 目标列表一次列全，切模式不再等系统"
```

---

## Task 2: 捕获窗口常驻 + 预热

**Files:**
- Modify: `plugins/screen-recorder/lib/windows.js`
- Modify: `plugins/screen-recorder/lib/capture.js`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `windows.warmCapture()` —— 提前把捕获页建好并等它就绪。
  - `capture.js`：`save()` / `fail()` / `cancel()` **不再**销毁捕获窗口。

- [ ] **Step 1: `windows.js`：捕获窗口只建一次**

`plugins/screen-recorder/lib/windows.js`：

把 `createCapture()` 改成：

```js
  /**
   * 捕获页：隐藏着，真正干活的地方。
   *
   * **建一次就一直用着**：录完不关它。
   * 以前录完就销毁，下次录制要重新建窗口、重新加载页面，
   * 而页面加载完才回报「准备好了」——那一下最多等 15 秒
   * （capture.js 的 waitReady）。用户每录一段都要等一次，不能忍。
   */
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

  /**
   * 预热：提前把捕获页建好，等它报「准备好了」。
   *
   * 插件一加载就调它：用户第一次点「开始录制」时不用等页面加载。
   */
  function warmCapture() {
    const win = createCapture();
    return win;
  }
```

`destroyCapture()` 保留，但**只在退出前用**（`destroyAll` 里已经调了）。

**注意**：`destroyCapture()` 里的 `close()`（不是 `destroy()`）很重要——
`destroy()` 硬拆窗口会把主进程堵住一两分钟（这段注释要留着）。

- [ ] **Step 2: `capture.js`：录完不销毁窗口**

`plugins/screen-recorder/lib/capture.js`：

`save()` 里，把

```js
    windows.hideControl();
    windows.destroyCapture();
    // 捕获窗没了，下次录制要重新等它报「准备好了」。
    pageReady = false;
    releaseSession();
```

改成

```js
    windows.hideControl();
    // **不销毁捕获窗口**：它留着，下次录制立刻就能开始
    // （以前要重新建窗口、重新等页面加载，最多 15 秒）。
    releaseSession();
```

`fail()` 与 `cancel()` 里同样：删掉 `windows.destroyCapture();` 与 `pageReady = false;`
这两行，保留 `releaseSession();`。

`releaseSession()` 的注释要改——它现在只在**录完**时调用（而不是退出前）：

```js
  /**
   * 放掉捕获窗的 session。
   *
   * handler 摘掉之后，下一次录制会重新装上（prepareSession）。
   *
   * **为什么录完就摘**：handler 还挂着的时候，应用退出会卡住——
   * 主进程的事件循环被堵住，几十秒都动不了（实测退出要多等十几秒）。
   */
```

- [ ] **Step 3: `dispose()` 里拆干净**

`capture.js` 的 `dispose()`：

```js
  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    state = 'idle';
    readyResolve = null;
    releaseSession();
    // 退出前把捕获窗口拆了：它一直在那儿（常驻）。
    windows.destroyCapture();
    pageReady = false;
  }
```

- [ ] **Step 4: `start()` 不再重复列源**

**先让缓存把原始 source 也留着**（`targets.js`）。

在 `createTargetCache` 里，`let listings = 0;` 后面加：

```js
  /** 原始的那一份源（displayMedia 的 handler 要用）。 */
  let rawSources = [];
```

在 `listAll()` 里，`byMode = { screen: screens, window: windows };` 后面加：

```js
        // 原始的 source 也留着：开始录制时直接给 handler，
        // 不用再列一次（列一次要几百毫秒）。
        rawSources = sources;
```

在返回值里加：

```js
    /** 原始的 source（给 displayMedia 的 handler）。 */
    rawSources: () => rawSources,
```

补一条测试：

```js
test('原始源也留着：开始录制时不用再列一次', async () => {
  const { calls, listSources } = fakeSources();
  const cache = createTargetCache({ listSources });
  await cache.ensure('screen');
  assert.equal(cache.rawSources().length, 3);
  assert.equal(calls.count, 1);
});
```

**然后** `capture.js` 的 `start()` 里，把

```js
    // 源提前取好：handler 里现取要等 5.9 秒（见 pendingSources 的说明）。
    pendingSources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    });
```

改成

```js
    // 源提前取好：handler 里现取要等 5.9 秒（见 pendingSources 的说明）。
    // 用**缓存里那一份**——切模式时已经列过了，这里再列一次要几百毫秒。
    pendingSources = targets.rawSources();
    if (!pendingSources.length) {
      // 缓存是空的（还没列过）：列一次。
      pendingSources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
    }
```

**注意**：`targets` 是 `capture.js` 里那个缓存对象的名字
（Task 1 Step 5 里建的 `const targets = createTargetCache({...})`）。
`capture.js` 里原来还有一个 `targets` 变量的旧用法——**不要重名**。
把缓存改名成 `targetCache` 更清楚：

```js
  const targetCache = createTargetCache({
    listSources: () =>
      desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      }),
  });
```

于是 `start()` 里用 `targetCache.rawSources()`，
`peekTargets` / `ensureTargets` 那些方法也都走 `targetCache`。

- [ ] **Step 5: 预热——插件加载时就建好捕获页**

`plugins/screen-recorder/main.js` 里，在 `const capture = createCaptureSession({...})` 之后加：

```js
  // 预热捕获页：插件一加载就把隐藏窗口建好、等它就绪。
  // 用户第一次点「开始录制」就不用等页面加载（最多 15 秒）。
  //
  // 捕获页是在 `persist:screen-recorder` 分区里的，
  // 它要等插件的 IPC 通道装好才回报「准备好了」——
  // 所以这一步放在 registerIpc 之后。
```

**顺序很重要**：`registerIpc(...)` 必须在预热**之前**调用，否则捕获页的
「准备好了」消息没人接，`pageReady` 永远是 false。

把 `registerIpc(...)` 那一整块挪到 `const capture = ...` **之前**，
然后在 `registerIpc(...)` 之后加：

```js
  // 预热：把隐藏的捕获页建好（它会回报「准备好了」）。
  capture.warm();
```

`capture.js` 里加一个 `warm()`：

```js
  /**
   * 预热：把捕获页建好，等它就绪。
   *
   * 用户第一次点「开始录制」就不用等页面加载。
   */
  function warm() {
    windows.warmCapture();
  }
```

并把它加进 `capture.js` 的返回值。

- [ ] **Step 6: 跑单元测试**

```bash
npm run test:unit
```

Expected: 全部通过（`targets` 的测试里补了 `rawSources` 那条）。

- [ ] **Step 7: 提交**

```bash
git add plugins/screen-recorder/lib/windows.js plugins/screen-recorder/lib/capture.js plugins/screen-recorder/main.js plugins/screen-recorder/lib/targets.js test/unit/screen-recorder-targets.test.js
git commit -m "perf(录屏): 捕获窗口常驻并预热，第二次录制不用等页面加载"
```

---

## Task 3: 选区截图走二进制

**Files:**
- Modify: `plugins/screen-recorder/lib/capture.js`
- Modify: `plugins/screen-recorder/lib/windows.js`
- Modify: `plugins/screen-recorder/pages/picker.js`

**Interfaces:**
- Consumes: `nativeImage.toPNG()`（`desktopCapturer` 的 source 有 `thumbnail`）。
- Produces: 遮罩页面收到的消息改成
  `{ type: 'picker', payload: { imageBytes: Uint8Array, snapshotSize } }`
  （原来是 `image`：base64 字符串）。

- [ ] **Step 1: `capture.js` 传字节**

`plugins/screen-recorder/lib/capture.js` 的 `pickRegion()` 里，把

```js
    const picked = await windows.openPicker({
      display,
      image: source.thumbnail.toDataURL(),
      snapshotSize: { width: source.thumbnail.getSize().width, height: source.thumbnail.getSize().height },
    });
```

改成

```js
    const size = source.thumbnail.getSize();
    const picked = await windows.openPicker({
      display,
      // **传字节，不传 base64**：2560×1440 的截图编成 base64 是几 MB 的字符串，
      // 结构化克隆过 IPC 时还要再复制一份。字节直接过去，快得多。
      imageBytes: source.thumbnail.toPNG(),
      snapshotSize: { width: size.width, height: size.height },
    });
```

**注意**：`source.thumbnail.getSize()` 原来被调了两次，现在存成 `size` ✓。

- [ ] **Step 2: `windows.js` 传字节**

`plugins/screen-recorder/lib/windows.js` 的 `openPicker()` 里，把

```js
      win.webContents.on('did-finish-load', () => {
        win.webContents.send('rec:screen-recorder:message', {
          type: 'picker',
          payload: { image, snapshotSize },
        });
      });
```

改成

```js
      win.webContents.on('did-finish-load', () => {
        win.webContents.send('rec:screen-recorder:message', {
          type: 'picker',
          payload: { imageBytes, snapshotSize },
        });
      });
```

并把函数签名的解构改成：

```js
  function openPicker({ display, imageBytes, snapshotSize }) {
```

**注意**：`Uint8Array` 能被 `webContents.send` 结构化克隆过去 ✓（不用转成 Buffer）。

- [ ] **Step 3: `picker.js` 收字节**

`plugins/screen-recorder/pages/picker.js` 里，把

```js
  window.rec.onMessage((message) => {
    if (message.type !== 'picker') return;
    const payload = message.payload || {};
    snapshotSize = payload.snapshotSize || { width: 0, height: 0 };
    shot.src = payload.image || '';
  });
```

改成

```js
  window.rec.onMessage((message) => {
    if (message.type !== 'picker') return;
    const payload = message.payload || {};
    snapshotSize = payload.snapshotSize || { width: 0, height: 0 };
    const bytes = payload.imageBytes;
    if (!bytes) {
      shot.removeAttribute('src');
      return;
    }
    // 字节 → Blob → 对象 URL：比 base64 字符串小得多，过 IPC 也快得多。
    // 用完要 revoke，不然对象 URL 一直占着内存。
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    shot.src = shotUrl;
  });
```

并在文件顶部（`const shot = ...` 附近）加：

```js
  /** 当前那张截图的对象 URL（换图时要 revoke 掉旧的）。 */
  let shotUrl = '';
```

**注意**：`new Blob([bytes])` 里 `bytes` 是 `Uint8Array`——
结构化克隆过来的 `Uint8Array` 直接可用 ✓。

- [ ] **Step 4: 跑端到端测试（选区那条）**

```bash
npx playwright test test/e2e/screen-recorder.spec.js -g "选区"
```

Expected: PASS ——「选区录制：框一块，录出来的就是那一块」。

**再加一条：用户中途取消框选**（Review Focus #4）。

在 `test/e2e/screen-recorder.spec.js` 里加：

```js
  test('选区时用户取消：回到空闲，不留下半个文件', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'luping');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('screen-recorder'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("录屏")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, {
        timeout: 10000,
      });

      // 切到选区模式
      await panel.evaluate(() => {
        const frame = document.querySelector('#plugin-frame');
        frame?.contentWindow?.document
          ?.querySelector('#mode button[data-mode="region"]')
          ?.click();
      });
      await new Promise((r) => setTimeout(r, 600));

      // 点「开始录制」→ 遮罩出来 → 取消
      await panel.evaluate(() => {
        const frame = document.querySelector('#plugin-frame');
        frame?.contentWindow?.document?.querySelector('#start')?.click();
      });
      const picker = await findWindow(app, 'picker.html');
      expect(picker, '选区遮罩应该出现').not.toBeNull();
      await picker.waitForLoadState('domcontentloaded');
      await picker.evaluate(() => document.querySelector('#cancel')?.click());

      // 遮罩关了，录制没开始，界面上还是「开始录制」
      await new Promise((r) => setTimeout(r, 1000));
      const stillThere = await findWindow(app, 'picker.html');
      expect(stillThere, '遮罩应该已经关了').toBeNull();
      const label = await panel.evaluate(() => {
        const frame = document.querySelector('#plugin-frame');
        return frame?.contentWindow?.document?.querySelector('#start')?.textContent || '';
      });
      expect(label).toContain('开始录制');
    } finally {
      await app.close();
    }
  });
```

**注意**：这条测试依赖 Task 7 的界面页（`#mode`、`#start`），
所以**要在 Task 7 之后**才加。执行顺序：先做 Task 7，再回来跑这条。

- [ ] **Step 5: 提交**

```bash
git add plugins/screen-recorder/lib/capture.js plugins/screen-recorder/lib/windows.js plugins/screen-recorder/pages/picker.js
git commit -m "perf(录屏): 选区截图传字节，不再过 base64 字符串"
```

---

## Task 4: 视频流式写盘

**Files:**
- Modify: `plugins/screen-recorder/pages/recorder.js`
- Modify: `plugins/screen-recorder/lib/capture.js`

**Interfaces:**
- Consumes: MediaRecorder 的 `dataavailable`（每 200ms 一块）。
- Produces:
  - 捕获页发新消息 `{ type: 'chunk', payload: { bytes } }`（视频路径）。
  - `capture.js` 在 `start()` 时开一个写流，`save()` 时关掉并改名。

- [ ] **Step 1: 捕获页改成一块一块发**

`plugins/screen-recorder/pages/recorder.js` 里，把

```js
      state.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.chunks.push(event.data);
      };
      recorder.onstop = () => {
        // 用户喊停的：什么都没录到，别存一个空文件出来。
        if (state.cancelled) return;
        const blob = new Blob(state.chunks, { type: mime });
        blob.arrayBuffer().then((buffer) => {
          reportSaved(buffer, 'mp4');
        });
        // 音频上下文在录器真的停下来之后再关：提前关会把最后一段声音切掉。
        closeAudio();
      };
```

改成

```js
      state.chunks = [];
      recorder.ondataavailable = (event) => {
        if (!event.data || !event.data.size) return;
        // **一块一块发出去**，不在渲染进程里攒全量：
        // 8Mbps 的视频攒一分钟就是 60MB，全攒着会让内存随录制时长涨。
        event.data.arrayBuffer().then((buffer) => {
          report('chunk', { bytes: new Uint8Array(buffer) });
        });
      };
      recorder.onstop = () => {
        // 用户喊停的：什么都没录到，别存一个空文件出来。
        if (state.cancelled) {
          report('end', { cancelled: true });
          return;
        }
        // 视频的字节已经一块块发出去了，这里只要说一声「完了」。
        report('end', { cancelled: false });
        // 音频上下文在录器真的停下来之后再关：提前关会把最后一段声音切掉。
        closeAudio();
      };
```

**注意**：GIF 路径**不走这里**（GIF 的字节是最后一次性交出来的），
所以 `stop()` 里那段 `state.gifEncoder.bytes()` 的逻辑要改成发 `end` + 字节：

```js
    if (state.gifEncoder) {
      // GIF 是自己一帧一帧攒出来的，停下来就把攒好的字节交回去。
      const bytes = state.gifEncoder.bytes();
      state.gifEncoder = null;
      reportSaved(bytes.buffer, 'gif');
    }
```

这段**保持不变**（GIF 走的是「最后一次性交回去」的路），
但 `reportSaved` 要改：GIF 交的是完整字节，视频交的是「分块 + end」。

把 `reportSaved` 改成：

```js
  /**
   * 交结果之前先等捕获会话松手。
   *
   * 屏幕捕获会话的收尾是**异步**的：轨道停了之后它还要一会儿才真正松手。
   * 给它留点时间，文件落盘时它就已经收得差不多了。
   */
  const SETTLE_MS = 800;

  /** GIF：一次性把攒好的字节交回去。 */
  function reportSaved(bytes, ext) {
    setTimeout(() => report('saved', { bytes, ext }), SETTLE_MS);
  }
```

视频路径**不用** `reportSaved`（它一块块发了，`end` 来了就收尾）。

- [ ] **Step 2: 主进程开写流**

`plugins/screen-recorder/lib/capture.js`：

顶部 import 加上：

```js
import { createWriteStream } from 'node:fs';
```

在 `createCaptureSession` 里加两个变量：

```js
  /** 本次录制的写流（视频路径：分块写进去，不在内存里攒全量）。 */
  let writeStream = null;
  /** 本次录制写到哪（.part 文件，录完再改名）。 */
  let writeTarget = '';
```

在 `start()` 里，`prepareSession()` 之后加：

```js
    // 视频：开一个写流，录到的字节**一块块**写进去。
    // 不在内存里攒全量——8Mbps 录一分钟就是 60MB，攒着会让内存一直涨。
    if (options.format === 'video') {
      const dir = getOutputDir();
      await mkdir(dir, { recursive: true });
      const name = recordingFileName(new Date(), 'mp4');
      writeTarget = await uniquePath(dir, name);
      writeStream = createWriteStream(`${writeTarget}.part`);
      writeStream.on('error', (err) => {
        console.warn('[录屏] 写文件出错：', err?.message);
      });
    }
```

`save()` 现在只处理 GIF 的整块字节；视频的收尾走新的 `finishVideo()`：

```js
  /**
   * 视频录完了：把写流关掉，把 .part 改名成正式文件。
   *
   * 中途出错的、或者用户喊停的，**不**留下半个文件——
   * 留着的话用户会以为录好了，其实打不开。
   */
  async function finishVideo() {
    if (!writeStream) return '';
    const stream = writeStream;
    writeStream = null;
    const target = writeTarget;
    writeTarget = '';
    await new Promise((resolve) => stream.end(resolve));
    try {
      await rename(`${target}.part`, target);
    } catch (err) {
      await unlink(`${target}.part`).catch(() => {});
      throw err;
    }
    return target;
  }
```

**注意**：`finishVideo` 要在 `state = 'idle'` 之类的事之前跑完，
所以 `save()` 改成：

```js
  /** 捕获页交回来的字节 → 写文件。 */
  async function save(bytes, ext) {
    const dir = getOutputDir();
    await mkdir(dir, { recursive: true });
    const name = recordingFileName(new Date(), ext);
    const target = await uniquePath(dir, name);
    const tmp = `${target}.part`;
    try {
      await writeFile(tmp, Buffer.from(bytes));
      await rename(tmp, target);
    } catch (err) {
      // 写坏了一半的文件留在那儿，下次看着像录好了其实是坏的。
      await unlink(tmp).catch(() => {});
      throw err;
    }
    state = 'idle';
    if (timer) clearInterval(timer);
    timer = null;
    windows.hideControl();
    releaseSession();
    onState?.({ recording: false, elapsedMs: 0, file: target });
    return target;
  }
```

**注意**：`save()` 现在只走 **GIF** 路径了（视频走 `finishVideo`）。
但 `save()` 里有 `releaseSession()`——视频路径也要放掉 session，
所以 `finishVideo()` 之后也要 `releaseSession()`。
把 `finishVideo()` 写成：

```js
  async function finishVideo() {
    if (!writeStream) return '';
    const stream = writeStream;
    writeStream = null;
    const target = writeTarget;
    writeTarget = '';
    await new Promise((resolve) => stream.end(resolve));
    releaseSession();
    state = 'idle';
    if (timer) clearInterval(timer);
    timer = null;
    windows.hideControl();
    try {
      await rename(`${target}.part`, target);
    } catch (err) {
      await unlink(`${target}.part`).catch(() => {});
      throw err;
    }
    onState?.({ recording: false, elapsedMs: 0, file: target });
    return target;
  }
```

- [ ] **Step 3: 主进程收块**

`plugins/screen-recorder/lib/capture.js` 加一个函数：

```js
  /**
   * 收到一块视频字节：直接写进写流。
   *
   * 不在内存里攒——攒着会让内存随录制时长一直涨。
   */
  function writeChunk(bytes) {
    if (!writeStream) return;
    try {
      writeStream.write(Buffer.from(bytes));
    } catch (err) {
      console.warn('[录屏] 写块失败：', err?.message);
    }
  }
```

并加进返回值。

`plugins/screen-recorder/main.js` 的 `registerIpc` 回调里，加两个分支：

```js
    } else if (message?.type === 'chunk') {
      capture.writeChunk(message.payload?.bytes);
    } else if (message?.type === 'end') {
      if (message.payload?.cancelled) {
        capture.cancel();
      } else {
        void capture.finishVideo().catch((err) => {
          capture.fail(`存不了文件：${err?.message || err}`);
        });
      }
    }
```

**放在 `saved` 分支的后面**（顺序不重要，但要在同一个 if/else 链里）。

- [ ] **Step 4: 出错时把半截文件删掉**

`capture.js` 的 `fail()` 里，加上：

```js
    // 出错了：写了一半的文件留在那儿，下次看着像录好了其实是坏的。
    if (writeStream) {
      const stream = writeStream;
      writeStream = null;
      stream.destroy();
      if (writeTarget) {
        await unlink(`${writeTarget}.part`).catch(() => {});
        writeTarget = '';
      }
    }
```

`fail()` 变成 `async`（它现在就是 async 吗？——`fail(message)` 是同步的）。
把它改成 `async function fail(message)`，调用方 `capture.fail(...)` 不受影响
（返回 Promise，但没人 await——**要检查调用方**）。

`main.js` 里 `capture.fail(...)` 有三处调用，都不 await。改成 async 之后
它们会返回一个悬空的 Promise——不会报错，但错误处理要小心。
更简单：**不改 `fail()` 的签名**，把清理放进一个同步的 `discardPartial()`：

```js
  /** 把写了一半的文件删掉（出错或取消时）。 */
  function discardPartial() {
    if (writeStream) {
      try {
        writeStream.destroy();
      } catch {
        /* 已经关了 */
      }
      writeStream = null;
    }
    if (writeTarget) {
      void unlink(`${writeTarget}.part`).catch(() => {});
      writeTarget = '';
    }
  }
```

`fail()` 与 `cancel()` 里各加一行 `discardPartial();`。

- [ ] **Step 5: 跑端到端测试（录屏那条）**

```bash
npx playwright test test/e2e/screen-recorder.spec.js -g "全屏录制"
```

Expected: PASS ——「全屏录制产出 mp4；麦克风可用就录，不可用就说清楚」。

**这个测试会验证 mp4 是合法的**（它自己解析 mp4 的 box）——
分块写出来的 mp4 首块含 `ftyp`，顺序写没问题 ✓。

**还要跑「窗口录制」那条**（Review Focus #3：目标窗口途中被关掉，
录制要自动停下来，**已经录的照样存下来**）：

```bash
npx playwright test test/e2e/screen-recorder.spec.js -g "窗口录制"
```

Expected: PASS ——「窗口录制：选一个窗口，它被关掉时录制自动停下来并保存」。

这条能过，说明分块写盘在「中途断掉」的情况下也把已录的部分存下来了：
轨道结束 → `stop()` → `recorder.onstop` → `report('end')` → `finishVideo()` 收尾 ✓。

- [ ] **Step 6: 提交**

```bash
git add plugins/screen-recorder/pages/recorder.js plugins/screen-recorder/lib/capture.js plugins/screen-recorder/main.js
git commit -m "perf(录屏): 视频分块流式写盘，内存不再随录制时长涨"
```

---

## Task 5: GIF 编码器改成全局调色板

**Files:**
- Modify: `plugins/screen-recorder/web/gif.js`
- Modify: `test/unit/screen-recorder-gif.test.js`

**Interfaces:**
- Consumes: 无。
- Produces: `GifEncoder` 的行为变了——**整段 GIF 共用一份调色板**（第一帧量化出来），
  颜色缓存跨帧复用。

- [ ] **Step 1: 改测试（先让它失败）**

`test/unit/screen-recorder-gif.test.js` 里有一条「每帧各有自己的调色板」的断言
（第 156-164 行附近）。把它换成「整段共用一份调色板」：

```js
test('整段 GIF 共用一份调色板：颜色缓存跨帧复用', () => {
  const encoder = new GifEncoder({ width: 2, height: 1 });
  const red = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
  const blue = new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]);
  encoder.addFrame(red, 100);
  encoder.addFrame(blue, 100);
  const bytes = encoder.bytes();
  // 头部里的全局颜色表：第一帧量化出来的。
  const flags = bytes[10];
  const globalSize = 2 << (flags & 0x07);
  const hasGlobal = (flags & 0x80) !== 0;
  assert.ok(hasGlobal, '应该有全局颜色表');
  assert.ok(globalSize >= 2);
  // 第二帧不再带局部颜色表（局部表标志在图像描述块的第 9 位）。
  const frameBlocks = [...bytes];
  const imageDescIndex = frameBlocks.findIndex((b, i) => b === 0x2c && bytes[i + 4] === 0 && bytes[i + 5] === 0);
  assert.ok(imageDescIndex > 0, '应该找得到图像描述块');
  const packed = bytes[imageDescIndex + 9];
  assert.equal(packed & 0x80, 0, '帧不该再有局部颜色表');
});
```

**先跑一次确认它失败**：

```bash
node --test test/unit/screen-recorder-gif.test.js
```

Expected: FAIL —— 现在每帧都有局部颜色表。

- [ ] **Step 2: 改编码器**

`plugins/screen-recorder/web/gif.js`：

把 `mapIndices` 改成**接受一个缓存**：

```js
  /**
   * 把像素映射成调色板索引。
   *
   * **必须带缓存**：每帧 23 万个像素 × 256 色线性查找，单帧要 200ms 以上，
   * 逐帧编码直接卡死。缓存命中后是 O(1)。
   *
   * 缓存**跨帧复用**——前提是**整段 GIF 共用一份调色板**：
   * 换了调色板，上一帧算出来的索引就是错的。
   * 这正是以前每帧 200ms 的原因（缓存建在函数里，每帧都重建）。
   *
   * @param {Uint8Array} rgba 一整帧的像素
   * @param {number[]} palette 调色板（RGB 整数数组）
   * @param {Map} cache 颜色 → 索引的缓存（跨帧复用同一个）
   */
  function mapIndices(rgba, palette, cache) {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const key = (r << 16) | (g << 8) | b;
      let index = cache.get(key);
      if (index === undefined) {
        let best = 0;
        let bestDistance = Infinity;
        for (let p = 0; p < palette.length; p += 1) {
          const c = palette[p];
          const dr = r - ((c >> 16) & 0xff);
          const dg = g - ((c >> 8) & 0xff);
          const db = b - (c & 0xff);
          const distance = dr * dr + dg * dg + db * db;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = p;
          }
        }
        index = best;
        cache.set(key, index);
      }
      out[j] = index;
    }
    return out;
  }
```

把 `GifEncoder` 的构造函数与 `addFrame` 改成：

```js
  class GifEncoder {
    constructor({ width, height, loop = 0, maxColors = 256 } = {}) {
      this.width = Math.max(1, Math.round(width));
      this.height = Math.max(1, Math.round(height));
      this.loop = loop;
      this.maxColors = maxColors;
      this.frames = [];
      /** 整段 GIF 共用的调色板：第一帧量化出来，之后不再变。 */
      this.palette = null;
      this.tableSize = 0;
      /** 颜色 → 索引的缓存：跨帧复用，所以每帧的映射只要几毫秒。 */
      this.cache = new Map();
    }

    /**
     * 加一帧。
     *
     * @param {Uint8Array} rgba 一整帧的像素（width×height×4）
     * @param {number} delayMs 这一帧显示多久
     * @returns {Uint8Array} 这一帧自己的字节
     */
    addFrame(rgba, delayMs) {
      // 第一帧：量化出**整段**共用的调色板。
      // 换了调色板，缓存里的索引就全错了——所以调色板只能有一份。
      if (!this.palette) {
        const q = quantize(rgba, this.maxColors);
        this.palette = q.palette;
        this.tableSize = q.tableSize;
      }
      const { palette, tableSize } = this;
      const indices = mapIndices(rgba, palette, this.cache);
      const bits = Math.max(1, Math.round(Math.log2(tableSize)));
      const minCodeSize = Math.max(2, bits);

      const bytes = [];
      // 图形控制扩展：disposal=1（不处理）、不透明、延时（1/100 秒）
      bytes.push(0x21, 0xf9, 0x04, 0x04);
      pushU16(bytes, Math.max(1, Math.round((delayMs || 100) / 10)));
      bytes.push(0x00, 0x00);
      // 图像描述：**没有**局部颜色表（用全局的那份）
      bytes.push(0x2c);
      pushU16(bytes, 0);
      pushU16(bytes, 0);
      pushU16(bytes, this.width);
      pushU16(bytes, this.height);
      bytes.push(bits - 1);
      // LZW 数据
      bytes.push(minCodeSize);
      const data = lzwEncode(indices, minCodeSize);
      for (let i = 0; i < data.length; i += 255) {
        const chunk = data.slice(i, i + 255);
        bytes.push(chunk.length);
        for (const b of chunk) bytes.push(b);
      }
      bytes.push(0x00);

      const frame = Uint8Array.from(bytes);
      this.frames.push(frame);
      return frame;
    }

    /**
     * 完整的 GIF 文件字节。
     *
     * 头部是**最后**才拼的：全局颜色表要等第一帧量化出来才知道。
     */
    bytes() {
      const palette = this.palette || [];
      const tableSize = this.tableSize || 2;
      const bits = Math.max(1, Math.round(Math.log2(tableSize)));
      const head = [];
      pushString(head, MAGIC);
      pushU16(head, this.width);
      pushU16(head, this.height);
      // 全局颜色表（标志位 0x80）、色深 bits-1、背景色 0、宽高比 0
      head.push(0x80 | (bits - 1), 0x00, 0x00);
      for (let i = 0; i < tableSize; i += 1) {
        const c = palette[i] || 0;
        head.push((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
      }
      // Netscape 循环扩展
      head.push(0x21, 0xff, 0x0b);
      pushString(head, 'NETSCAPE2.0');
      head.push(0x03, 0x01);
      pushU16(head, this.loop);
      head.push(0x00);

      const total = head.length + this.frames.reduce((n, f) => n + f.length, 0) + 1;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const b of head) {
        out[pos] = b;
        pos += 1;
      }
      for (const frame of this.frames) {
        out.set(frame, pos);
        pos += frame.length;
      }
      out[pos] = 0x3b; // 结尾
      return out;
    }
  }
```

**注意**：`constructor` 里原来的 `this.head = head;` 删掉——头部现在在 `bytes()` 里拼。

**注意**：全局颜色表的项数必须是 2 的幂。`quantize()` 返回的 `tableSize`
已经是 2 的幂 ✓（`quantize` 里 `while ((1 << bits) < colors.length) bits += 1;`）。

- [ ] **Step 3: 跑单元测试**

```bash
node --test test/unit/screen-recorder-gif.test.js
```

Expected: 全部通过。

**如果「解码回来颜色不对」那条失败**：说明 LZW 的最小码长变了。
`minCodeSize = Math.max(2, bits)` 与调色板大小有关；
全局表是 `tableSize` 项，色深是 `bits` 位 → 最小码长 `bits` ✓。
若测试里解码器用的是 `minCodeSize`，它是从字节流里读的 ✓，应该对得上。

- [ ] **Step 4: 提交**

```bash
git add plugins/screen-recorder/web/gif.js test/unit/screen-recorder-gif.test.js
git commit -m "perf(录屏): GIF 改成全局调色板，颜色缓存跨帧复用（每帧 200ms → 几毫秒）"
```

---

## Task 6: 选区裁剪改 requestVideoFrameCallback

**Files:**
- Modify: `plugins/screen-recorder/pages/recorder.js`

**Interfaces:**
- Consumes: `HTMLVideoElement.requestVideoFrameCallback`（Chromium 83+ 有）。
- Produces: 无（内部实现）。

- [ ] **Step 1: 改裁剪的绘制循环**

`plugins/screen-recorder/pages/recorder.js` 里，把

```js
        const draw = () => {
          ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        };
        state.canvas = canvas;
        state.drawTimer = setInterval(draw, 1000 / (payload.fps || 30));
        draw();
```

改成

```js
        const draw = () => {
          ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        };
        state.canvas = canvas;
        // **有-new-帧才画**：用 setInterval 的话，屏幕没变化时也在白画，
        // 白白占着 CPU。requestVideoFrameCallback 只在真有新帧时被叫。
        const schedule = () => {
          if (typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback(() => {
              draw();
              schedule();
            });
          } else {
            state.drawTimer = setInterval(draw, 1000 / (payload.fps || 30));
          }
        };
        draw();
        schedule();
```

**注意**：`state.drawTimer` 只在**没有** `requestVideoFrameCallback` 时才用得上——
`stop()` 里 `clearInterval(state.drawTimer)` 对它无害（null 时 clearInterval(null) 不报错）。

**注意**：GIF 路径那边也有一处 `setInterval` 抓帧——**不改**：
GIF 要的是**固定帧率**（12fps），不是「有多少新帧画多少」。

- [ ] **Step 2: 跑端到端测试（选区那条）**

```bash
npx playwright test test/e2e/screen-recorder.spec.js -g "选区"
```

Expected: PASS ——「选区录制：框一块，录出来的就是那一块」
（它会断言录出来的画面比例与框选的比例一致）。

- [ ] **Step 3: 提交**

```bash
git add plugins/screen-recorder/pages/recorder.js
git commit -m "perf(录屏): 选区裁剪只在有新帧时重画"
```

---

## Task 7: 新的响应式界面页

**Files:**
- Create: `plugins/screen-recorder/pages/studio.html`
- Create: `plugins/screen-recorder/pages/studio.css`
- Create: `plugins/screen-recorder/pages/studio.js`
- Modify: `plugins/screen-recorder/plugin.json`
- Modify: `plugins/screen-recorder/main.js`
- Modify: `plugins/screen-recorder/lib/windows.js`
- Delete: `plugins/screen-recorder/pages/workbench.html`
- Delete: `plugins/screen-recorder/pages/workbench.js`

**Interfaces:**
- Consumes: `/src/renderer/ui/theme.css`、`/src/renderer/ui/pluginPage.js`（第一期做好的）。
- Produces:
  - 清单里 `window: { page: 'pages/studio.html', title: '录屏', width: 460, height: 640, refreshMs: 250, alwaysOnTop: false }`
  - 插件实例多两个方法：`meta(ctx)` 与 `act(ctx, actionId, payload)`。
  - 界面页发这些动作：`mode:screen|region|window`、`format:video|gif`、
    `toggle:mic`、`toggle:speaker`、`pick-target`、`start`、`stop`、
    `set:outputDir`、`set:fps`、`set:gifWidth`、`set:gifFps`、`set:hotkey`、
    `pick-dir`、`open-dir`、`refresh-targets`。

- [ ] **Step 1: 写界面页**

新建 `plugins/screen-recorder/pages/studio.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>录屏</title>
    <!-- 宿主的设计系统：所有插件长一个样。 -->
    <link rel="stylesheet" href="/src/renderer/ui/theme.css" />
    <link rel="stylesheet" href="/src/renderer/ui/studio.css" />
  </head>
  <body>
    <!--
      .surface 是宿主给的容器：容器查询看的是**宽度**，
      所以窄（面板工作台）与宽（独立窗口）能各自排。
    -->
    <div class="surface studio">
      <div class="studio-body">
        <section class="studio-block">
          <div class="dp-section-title">录制方式</div>
          <div class="dp-segmented" id="mode">
            <button type="button" data-mode="screen">全屏</button>
            <button type="button" data-mode="region">选区</button>
            <button type="button" data-mode="window">窗口</button>
          </div>
        </section>

        <section class="studio-block">
          <div class="dp-section-title">
            录哪一块
            <button class="dp-link" id="refresh-targets" type="button">刷新</button>
          </div>
          <ul class="dp-list" id="targets"></ul>
          <p class="studio-empty" id="targets-empty" hidden>拿不到可录的目标——点「刷新」再试。</p>
        </section>

        <section class="studio-block">
          <div class="dp-section-title">声音</div>
          <label class="dp-switch"><input type="checkbox" id="mic" /> 录制麦克风</label>
          <label class="dp-switch"><input type="checkbox" id="speaker" /> 录制扬声器</label>
          <p class="studio-hint" id="gif-note" hidden>GIF 存不了声音——切到 GIF 时不会录声音。</p>
        </section>

        <section class="studio-block">
          <div class="dp-section-title">格式</div>
          <div class="dp-segmented" id="format">
            <button type="button" data-format="video">视频</button>
            <button type="button" data-format="gif">GIF</button>
          </div>
        </section>

        <details class="studio-block studio-details" id="settings">
          <summary class="dp-section-title">设置</summary>
          <div class="dp-field">
            <label for="outputDir">存放位置</label>
            <input class="dp-input" id="outputDir" type="text" placeholder="留空＝视频文件夹" />
            <button class="dp-button" id="pick-dir" type="button">浏览…</button>
          </div>
          <div class="dp-field">
            <label for="hotkey">快捷键</label>
            <input class="dp-input" id="hotkey" type="text" readonly placeholder="点右边录制" />
            <button class="dp-button" id="record-hotkey" type="button">录制</button>
          </div>
          <p class="studio-hint">
            快捷键只在录屏的界面开着时生效——关掉界面就把这个组合键让回给别的程序。
          </p>
          <div class="dp-field">
            <label for="fps">视频帧率</label>
            <input class="dp-input" id="fps" type="text" inputmode="numeric" />
          </div>
          <div class="dp-field">
            <label for="gifWidth">GIF 宽度</label>
            <input class="dp-input" id="gifWidth" type="text" inputmode="numeric" />
          </div>
          <div class="dp-field">
            <label for="gifFps">GIF 帧率</label>
            <input class="dp-input" id="gifFps" type="text" inputmode="numeric" />
          </div>
          <button class="dp-button" id="open-dir" type="button">打开输出文件夹</button>
        </details>
      </div>

      <footer class="dp-footer studio-footer">
        <span class="grow" id="output">存储到 …</span>
        <span class="time" id="elapsed" hidden>00:00</span>
        <button class="dp-button primary" id="start" type="button">开始录制</button>
      </footer>
    </div>
    <script type="module" src="/plugins/screen-recorder/pages/studio.js"></script>
  </body>
</html>
```

**注意**：`<script type="module" src="/plugins/screen-recorder/pages/studio.js">` 是**绝对路径**——
用户自己的插件在 `/__plugins__/<id>/`，写死 `/plugins/...` 会 404。
**这个页面是内置插件专用的**，路径写死没问题；但 `studio.js` 里 `import`
宿主模块时要用绝对路径 `/src/renderer/ui/pluginPage.js` ✓。

- [ ] **Step 2: 写样式**

新建 `plugins/screen-recorder/pages/studio.css`：

```css
/*
 * 录屏界面的样式。
 *
 * 颜色、圆角、按钮这些**全都来自宿主的主题**（theme.css）——
 * 这里只管这个界面特有的布局。
 */

html,
body {
  margin: 0;
  height: 100%;
  background: transparent;
  overflow: hidden;
  font: var(--dp-font);
  color: var(--dp-text);
}

.studio {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--dp-bg);
}

.studio-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 14px;
}

.studio-block { margin-bottom: 14px; }
.studio-block:last-child { margin-bottom: 0; }

.studio-empty {
  margin: 4px 0 0;
  color: var(--dp-text-faint);
  font-size: 12px;
}

.studio-hint {
  margin: 4px 0 0;
  color: var(--dp-text-faint);
  font-size: 12px;
}

/* 「刷新」这样的小动作，藏在标题右边。 */
.dp-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dp-link {
  border: none;
  background: transparent;
  color: var(--dp-accent-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}

.studio-details > summary {
  cursor: pointer;
  list-style: none;
}
.studio-details > summary::-webkit-details-marker { display: none; }

.dp-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.dp-field label {
  width: 72px;
  flex: none;
  color: var(--dp-text-soft);
}
.dp-field .dp-input { flex: 1; min-width: 0; }

.studio-footer {
  flex: none;
  border-top: 1px solid var(--dp-border-soft);
}

/*
 * 宽的时候（独立窗口，用户能拉宽）排成两栏：
 * 目标列表与声音/格式并排。窄的时候（面板工作台）自动回到单列。
 */
@container surface (min-width: 520px) {
  .studio-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 20px;
    align-content: start;
  }
  /* 「录哪一块」占满一整行：它是这个界面里最长的一块。 */
  .studio-block:nth-child(2) { grid-column: 1 / -1; }
}
```

- [ ] **Step 3: 写逻辑**

新建 `plugins/screen-recorder/pages/studio.js`：

```js
// plugins/screen-recorder/pages/studio.js
/**
 * 录屏的界面。
 *
 * **同一份页面两处用**：面板工作台（窄）与独立窗口（宽）。
 * 助手 `bindSurface()` 自己认得出身处何处（见 src/renderer/ui/pluginPage.js）。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';

const surface = bindSurface();

const els = {
  mode: document.getElementById('mode'),
  format: document.getElementById('format'),
  targets: document.getElementById('targets'),
  targetsEmpty: document.getElementById('targets-empty'),
  refreshTargets: document.getElementById('refresh-targets'),
  mic: document.getElementById('mic'),
  speaker: document.getElementById('speaker'),
  gifNote: document.getElementById('gif-note'),
  outputDir: document.getElementById('outputDir'),
  pickDir: document.getElementById('pick-dir'),
  hotkey: document.getElementById('hotkey'),
  recordHotkey: document.getElementById('record-hotkey'),
  fps: document.getElementById('fps'),
  gifWidth: document.getElementById('gifWidth'),
  gifFps: document.getElementById('gifFps'),
  openDir: document.getElementById('open-dir'),
  output: document.getElementById('output'),
  elapsed: document.getElementById('elapsed'),
  start: document.getElementById('start'),
};

/** 正在录快捷键吗（录的时候不抢用户的按键）。 */
let capturingHotkey = false;
/** 当前是不是在录（决定「开始」按钮是开始还是停止）。 */
let isRecording = false;

/** 把状态画出来。 */
function render(state) {
  if (!state) return;
  const config = state.config || {};

  for (const btn of els.mode.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === config.mode));
  }
  for (const btn of els.format.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.format === config.format));
  }

  els.mic.checked = Boolean(config.mic);
  els.speaker.checked = Boolean(config.speaker);
  els.gifNote.hidden = config.format !== 'gif';

  // 目标列表
  els.targets.textContent = '';
  const targets = state.targets || [];
  for (const t of targets) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = t.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = t.id === config.sourceId ? '已选' : t.hint || '';
    li.append(label, hint);
    li.addEventListener('click', () => surface.act('pick-target', { id: t.id }));
    els.targets.append(li);
  }
  els.targetsEmpty.hidden = targets.length > 0;

  // 设置区：只在**没在输入**的时候覆盖，别的会把用户打的字冲掉。
  if (document.activeElement !== els.outputDir) els.outputDir.value = config.outputDir || '';
  if (document.activeElement !== els.fps) els.fps.value = String(config.fps ?? 30);
  if (document.activeElement !== els.gifWidth) els.gifWidth.value = String(config.gifWidth ?? 480);
  if (document.activeElement !== els.gifFps) els.gifFps.value = String(config.gifFps ?? 12);
  if (!capturingHotkey) els.hotkey.value = config.hotkey || '';

  // 底部
  els.output.textContent = state.outputDir
    ? `存储到 ${state.outputDir}`
    : '存储到「视频」文件夹';
  const recording = Boolean(state.recording);
  els.start.textContent = recording ? '停止录制' : '开始录制';
  els.start.classList.toggle('danger', recording);
  els.elapsed.hidden = !recording;
  if (recording) {
    const s = Math.floor((state.elapsedMs || 0) / 1000);
    els.elapsed.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  if (state.status) surface.setStatus(state.status);
}

/** 界面的高度：报给面板（面板窗口要按内容撑开）。 */
function reportHeight() {
  const body = document.querySelector('.studio-body');
  if (!body) return;
  surface.setHeight(Math.ceil(body.scrollHeight) + 60);
}

// —— 动作 ——

els.mode.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  surface.act('mode', { mode: btn.dataset.mode });
});

els.format.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-format]');
  if (!btn) return;
  surface.act('format', { format: btn.dataset.format });
});

els.mic.addEventListener('change', () => surface.act('toggle', { key: 'mic', value: els.mic.checked }));
els.speaker.addEventListener('change', () =>
  surface.act('toggle', { key: 'speaker', value: els.speaker.checked })
);

els.refreshTargets.addEventListener('click', () => surface.act('refresh-targets'));

els.start.addEventListener('click', () => {
  surface.act(isRecording ? 'stop' : 'start');
});

els.pickDir.addEventListener('click', () => surface.act('pick-dir'));
els.openDir.addEventListener('click', () => surface.act('open-dir'));

els.outputDir.addEventListener('change', () =>
  surface.act('set', { key: 'outputDir', value: els.outputDir.value })
);
els.fps.addEventListener('change', () => surface.act('set', { key: 'fps', value: els.fps.value }));
els.gifWidth.addEventListener('change', () =>
  surface.act('set', { key: 'gifWidth', value: els.gifWidth.value })
);
els.gifFps.addEventListener('change', () => surface.act('set', { key: 'gifFps', value: els.gifFps.value }));

els.recordHotkey.addEventListener('click', () => {
  capturingHotkey = true;
  els.hotkey.value = '按下组合键…';
});

document.addEventListener('keydown', (e) => {
  if (!capturingHotkey) return;
  e.preventDefault();
  e.stopPropagation();
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  const key = e.key.toUpperCase();
  if (!['CONTROL', 'ALT', 'SHIFT', 'META'].includes(key)) parts.push(key);
  if (parts.length <= 1) return; // 单个键不算快捷键
  capturingHotkey = false;
  surface.act('set', { key: 'hotkey', value: parts.join('+') });
});

// —— 数据 ——

surface.onData((data) => {
  isRecording = Boolean(data?.recording);
  render(data);
  reportHeight();
});

surface.onTick((data) => {
  isRecording = Boolean(data?.recording);
  render(data);
});

// 高度变化了就报一次：面板窗口要跟着变。
if (typeof ResizeObserver === 'function') {
  const body = document.querySelector('.studio-body');
  if (body) new ResizeObserver(() => reportHeight()).observe(body);
}

// 先要一份数据（宿主会在 ready 之后推过来，但主动要一次更稳）。
surface.data().then((data) => {
  isRecording = Boolean(data?.recording);
  render(data);
  reportHeight();
});

reportHeight();
```

**注意**：`state_isRecording` 在文件里被 `els.start` 的监听器用到了，
但它定义在后面——`const`/`let` 的**暂时性死区**会让那行在定义前报错吗？
不会：监听器是**回调**，执行时 `state_isRecording` 已经初始化了 ✓。
但为了清楚，把它挪到文件上面（`let state_isRecording = false;` 放在 `const els` 之后）。

**注意**：`surface.act()` 返回一个 Promise，失败时不会炸页面
（助手里的 `act` 已经兜住了）。

- [ ] **Step 4: 清单加 window 段**

`plugins/screen-recorder/plugin.json` 改成：

```json
{
  "id": "screen-recorder",
  "name": "录屏",
  "icon": "🎥",
  "description": "全屏、选区、窗口录制，输出视频或 GIF",
  "keywords": ["录屏", "屏幕", "录像", "录制", "luping", "screen", "record", "gif"],
  "entry": "main.js",
  "window": {
    "page": "pages/studio.html",
    "title": "录屏",
    "width": 460,
    "height": 640,
    "refreshMs": 250,
    "alwaysOnTop": false
  }
}
```

- [ ] **Step 5: 插件实现 `meta` 与 `act`**

`plugins/screen-recorder/main.js`：

顶部那行 import 改成：

```js
import { buildPanelPage, MODE_LABELS } from './lib/page.js';
```

把 `return { page, action };` 前面加上 `meta` 与 `act`：

```js
  /**
   * 界面的标题那几个字段。
   *
   * 宿主在插件自带页面时**只问 meta**——`page()` 要列系统窗口，
   * 那是几百毫秒的事，不该在「打开面板」这一步里等。
   */
  async function meta() {
    const cfg = await ensureConfig();
    return {
      title: '录屏',
      subtitle: recording ? '正在录制' : MODE_LABELS[cfg.mode],
      status,
    };
  }

  /**
   * 自带页面里的一个动作。
   *
   * 走的是**同一套**动作处理（handleAction）——
   * 声明式积木页与自带页面共用一份逻辑，不会走歪。
   */
  async function act(currentCtx, actionId, payload) {
    if (currentCtx?.update) update = currentCtx.update;
    return enqueue(() => handleAction(actionId, payload?.value ?? payload));
  }
```

**注意**：`act` 的第二个参数是 `payload`（一个对象），
而 `action` 的第二个参数是 `value`。所以要 `payload?.value ?? payload`——
但这会把整个 payload 当 value 传过去。要小心：

`handleAction(actionId, value)` 里用的是 `value`（字符串）。
而 `act` 传的 payload 是对象（`{ mode: 'screen' }`）。

**所以 `handleAction` 要能处理对象形式的 value**：

```js
  async function act(currentCtx, actionId, payload) {
    if (currentCtx?.update) update = currentCtx.update;
    const value = payload && typeof payload === 'object' ? payload.value : payload;
    return enqueue(() => handleAction(String(actionId || ''), value, payload));
  }
```

**并且** `handleAction` 要认新的动作名。把它扩成：

```js
  /** 动作的真身（已经在队列里了）。 */
  async function handleAction(actionId, value, payload) {
    const cfg = await ensureConfig();
    const p = payload && typeof payload === 'object' ? payload : {};

    if (actionId === 'mode') {
      await save({ mode: p.mode });
      status = '';
      targets = capture.peekTargets(p.mode);
    } else if (actionId === 'format') {
      await save({ format: p.format });
    } else if (actionId === 'toggle') {
      await save({ [p.key]: Boolean(p.value) });
    } else if (actionId === 'pick-target') {
      await save({ sourceId: p.id });
      status = '选了要录的目标';
    } else if (actionId === 'refresh-targets') {
      await capture.refreshTargets();
      targets = capture.peekTargets(cfg.mode);
    } else if (actionId === 'set') {
      await save({ [p.key]: p.value });
    } else if (actionId === 'pick-dir') {
      const picked = await pickDirectory();
      if (picked) {
        await save({ outputDir: picked });
        status = `输出目录：${picked}`;
      }
    } else if (actionId === 'open-dir') {
      await shell.openPath((config?.outputDir || '').trim() || app.getPath('videos'));
    } else if (actionId === 'start') {
      await startRecordingInner();
    } else if (actionId === 'stop') {
      capture.stop();
    } else if (actionId.startsWith('mode:')) {
      // 旧的声明式动作（积木页用的）——留着，兜底路径还能用。
      await save({ mode: actionId.slice('mode:'.length) });
      targets = capture.peekTargets(cfg.mode);
    } else if (actionId.startsWith('format:')) {
      await save({ format: actionId.slice('format:'.length) });
    } else if (actionId === 'mic') {
      await save({ mic: value === 'true' });
    } else if (actionId === 'speaker') {
      await save({ speaker: value === 'true' });
    } else if (actionId === 'outputDir') {
      await save({ outputDir: String(value || '').trim() });
    } else if (actionId === 'pick-dir') {
      // 同上（旧的积木页动作名）
      const picked = await pickDirectory();
      if (picked) await save({ outputDir: picked });
    } else if (actionId === 'start' || actionId === 'stop') {
      // 同上
    } else {
      status = '';
    }
    return page();
  }
```

**注意**：上面这个版本有**重复的分支**（`pick-dir` 出现两次、`start`/`stop` 出现两次）。
这是错的。正确写法是**只保留一套**分支，用新动作名，
旧的积木动作名在**兜底**里单独处理。整理成：

```js
  /** 动作的真身（已经在队列里了）。 */
  async function handleAction(actionId, value, payload) {
    const cfg = await ensureConfig();
    const p = payload && typeof payload === 'object' ? payload : {};

    // —— 自带页面的动作（新）——
    if (actionId === 'mode') {
      await save({ mode: p.mode });
      status = '';
      targets = capture.peekTargets(p.mode);
    } else if (actionId === 'format') {
      await save({ format: p.format });
    } else if (actionId === 'toggle') {
      await save({ [p.key]: Boolean(p.value) });
    } else if (actionId === 'pick-target') {
      await save({ sourceId: p.id });
      status = '选了要录的目标';
    } else if (actionId === 'refresh-targets') {
      await capture.refreshTargets();
      targets = capture.peekTargets(cfg.mode);
    } else if (actionId === 'set') {
      await save({ [p.key]: p.value });
    } else if (actionId === 'pick-dir') {
      const picked = await pickDirectory();
      if (picked) {
        await save({ outputDir: picked });
        status = `输出目录：${picked}`;
      }
    } else if (actionId === 'open-dir') {
      await shell.openPath((config?.outputDir || '').trim() || app.getPath('videos'));
    } else if (actionId === 'start') {
      await startRecordingInner();
    } else if (actionId === 'stop') {
      capture.stop();
    }
    // —— 旧的积木动作（兜底路径用）——
    else if (actionId.startsWith('mode:')) {
      await save({ mode: actionId.slice('mode:'.length) });
      status = '';
      targets = capture.peekTargets(actionId.slice('mode:'.length));
    } else if (actionId.startsWith('format:')) {
      await save({ format: actionId.slice('format:'.length) });
    } else if (actionId === 'mic') {
      await save({ mic: value === 'true' });
    } else if (actionId === 'speaker') {
      await save({ speaker: value === 'true' });
    } else if (actionId === 'outputDir') {
      const dir = String(value || '').trim();
      await save({ outputDir: dir });
      status = dir ? `输出目录：${dir}` : '输出目录：视频文件夹';
    } else if (actionId.startsWith('screen:') || actionId.startsWith('window:')) {
      await save({ sourceId: actionId });
      status = '选了要录的目标';
    } else {
      status = '';
    }
    return page();
  }
```

**注意**：`handleAction` 最后 `return page();` —— 对 `act` 路径来说这个返回值没人用
（宿主把 `act` 的返回值当结果返回给页面），但 `page()` 会**列一次目标**（`ensureTargets`）。
这在每次动作后都会触发一次列表操作——缓存新鲜时是免费的 ✓，但第一次会列一次。

`page()` 里改成用 `peekTargets` 更省：

```js
  /** 面板页面（兜底：积木界面）。 */
  async function page(currentCtx) {
    if (currentCtx?.update) update = currentCtx.update;
    const cfg = await ensureConfig();
    targets = capture.peekTargets(cfg.mode);
    return buildPanelPage(ctx.ui, { config: cfg, targets, recording, status });
  }
```

**注意**：`peekTargets` 在缓存空时返回空数组——界面第一次打开会是空的。
但 `studio.js` 通过 `surface.data()` 拿数据，`data(ctx)` 会 `ensureTargets` 一次 ✓。
所以 `data(ctx)` 要实现：

```js
  /** 自带页面的第一份数据。 */
  async function data() {
    const cfg = await ensureConfig();
    targets = await capture.ensureTargets(cfg.mode);
    return statePayload(cfg);
  }

  /** 自带页面的周期数据。 */
  async function tick() {
    const cfg = await ensureConfig();
    return statePayload(cfg);
  }

  /** 界面要的那份状态。 */
  function statePayload(cfg) {
    return {
      config: cfg,
      targets,
      recording,
      status,
      elapsedMs: recording ? Date.now() - startedAt : 0,
      outputDir: (cfg.outputDir || '').trim() || app.getPath('videos'),
    };
  }
```

`startedAt` 要在插件里记着（`capture` 那边也有一个，但那边不导出来）。
在插件里加：

```js
  /** 本次录制开始的时刻（界面上的计时用）。 */
  let startedAt = 0;
```

并在 `onState` 里维护：

```js
      if (state.recording && !recording) startedAt = Date.now() - (state.elapsedMs || 0);
```

`onState` 回调里 `recording = state.recording;` 那行后面加这一行。

**返回**：

```js
  return { page, action, meta, act, data, tick };
```

- [ ] **Step 6: 删掉工作台窗口**

`plugins/screen-recorder/lib/windows.js`：

- 删掉 `openWorkbench`、`closeWorkbench`、`isWorkbenchOpen` 三个函数；
- 删掉 `windows` 对象里的 `workbench: null`；
- 删掉 `onWorkbenchChanged` 参数与 `createWindows` 的参数解构；
- `destroyAll()` 里的循环不用改（它遍历 `Object.keys(windows)`）。

`plugins/screen-recorder/main.js`：

- `createWindows({...})` 的调用去掉 `onWorkbenchChanged`；
- 删掉 `pushWorkbenchState()` 这个函数与它的所有调用；
- `registerIpc` 里 `role === 'workbench'` 的那几个分支删掉
  （`hotkey`、`workbench-set`、`workbench-pick-dir`、`workbench-open-dir`）；
- `syncHotkey()` 里的 `if (!windows.isWorkbenchOpen())` 换成新的判断（见 Task 9）。

**还要改积木兜底页** `plugins/screen-recorder/lib/page.js`：
那个「设置…」按钮（`open-workbench`）指向的工作台窗口**已经没有了**，
留着就是一个点了没反应的死按钮。把它删掉，只留「浏览…」：

```js
  blocks.push(
    ui.buttonsBlock([
      { id: 'pick-dir', label: '浏览…' },
    ])
  );
```

（原来这里是两个：`pick-dir` 与 `open-workbench`。）

- [ ] **Step 7: 删掉旧的工作台页面**

```bash
git rm plugins/screen-recorder/pages/workbench.html plugins/screen-recorder/pages/workbench.js
```

- [ ] **Step 8: 跑单元测试**

```bash
npm run test:unit
```

Expected: 全部通过。

- [ ] **Step 9: 跑端到端测试**

```bash
npx playwright test test/e2e/screen-recorder.spec.js
```

Expected: **大部分通过**，但「工作台开着时快捷键才生效」那条会**失败**——
它找的是 `workbench.html` 窗口，而工作台窗口没有了。
Task 9 会改这条测试。

**其余的（录屏、GIF、控制条、选区、窗口录制）都要过。**

- [ ] **Step 10: 提交**

```bash
git add -A plugins/screen-recorder
git commit -m "feat(录屏): 新的响应式界面页，面板工作台与独立窗口共用同一份"
```

---

## Task 8: 控制条按新设计系统重画

**Files:**
- Modify: `plugins/screen-recorder/pages/control.html`

**Interfaces:**
- Consumes: 无（纯样式）。
- Produces: 无。

- [ ] **Step 1: 重画**

`plugins/screen-recorder/pages/control.html` 整个换成：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>录制中</title>
    <style>
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
      }
      /*
       * 控制条是**深色**的：它压在别人的窗口上，深色更清楚，
       * 也更醒目——录着屏的时候，用户得一眼看见它。
       * 形状与配色仍然跟桌宠是一家的（圆角、字号、强调红）。
       */
      #bar {
        display: flex;
        align-items: center;
        gap: 12px;
        height: 100%;
        padding: 0 16px;
        border-radius: 12px;
        background: rgba(32, 29, 25, 0.92);
        color: #f6f2e7;
        font: 13px/1.2 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
        box-shadow: 0 4px 14px rgba(20, 16, 10, 0.35);
        /* 整条都能拖：录屏的时候用户常常想把它挪开。 */
        -webkit-app-region: drag;
      }
      #dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #e0644f;
        flex: none;
      }
      #time {
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.04em;
      }
      button {
        -webkit-app-region: no-drag;
        font: inherit;
        padding: 5px 13px;
        border: none;
        border-radius: 8px;
        background: #e0644f;
        color: #fff;
        cursor: pointer;
      }
      button:hover { background: #cf5541; }
    </style>
  </head>
  <body>
    <div id="bar">
      <span id="dot"></span>
      <span id="time">00:00</span>
      <button id="stop" type="button">停止</button>
    </div>
    <script src="control.js"></script>
  </body>
</html>
```

- [ ] **Step 2: 控制条自己走秒，不再每半秒走一次 IPC**

`plugins/screen-recorder/pages/control.js` 整个换成：

```js
// plugins/screen-recorder/pages/control.js
/**
 * 悬浮控制条：计时 + 停止。
 *
 * 录屏的时候用户往往找不到桌宠在哪——控制条是置顶的，
 * 一直看得见，才知道「还在录」以及「怎么停」。
 */
(function () {
  const time = document.getElementById('time');

  function format(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  /**
   * 开始计时的时刻。
   *
   * **自己走秒**，不等主进程每半秒推一次时长：
   * 推的是同一个数，而控制条浮在最上面——它一卡，用户都看得见。
   */
  let startedAt = 0;
  let timer = null;

  function tick() {
    time.textContent = format(Date.now() - startedAt);
  }

  function startTicking() {
    if (timer) return;
    startedAt = Date.now();
    tick();
    timer = setInterval(tick, 1000);
  }

  function stopTicking() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  document.getElementById('stop').addEventListener('click', () => {
    window.rec.send({ type: 'stop' });
  });

  window.rec.onMessage((message) => {
    if (message.type !== 'state') return;
    const payload = message.payload || {};
    if (payload.recording) startTicking();
    else stopTicking();
  });
})();
```

**主进程那头也改**：`plugins/screen-recorder/lib/capture.js` 的 `tick()` 改成
**只在状态变了的时候推**。在 `createCaptureSession` 里加一个变量：

```js
  /** 上次推出去的状态（用来判断「变了没」）。 */
  let lastPushed = null;
```

把 `tick()` 换成：

```js
  /**
   * 录制状态的推送。
   *
   * **只在状态变了的时候推**：控制条自己走秒，
   * 每半秒推一次同一个数字是白费力气。
   */
  function tick() {
    const state = { recording: isRecording(), elapsedMs: Date.now() - startedAt };
    const key = String(state.recording);
    if (key === lastPushed) return;
    lastPushed = key;
    onState?.(state);
  }
```

`plugins/screen-recorder/main.js` 的 `onState` 里，把

```js
      const wasRecording = recording;
      recording = state.recording;
```

改成

```js
      const wasRecording = recording;
      recording = state.recording;
      // 录制开始的那一刻记下时刻：界面上的计时用它。
      if (recording && !wasRecording) startedAt = Date.now() - (state.elapsedMs || 0);
```

**注意**：`startedAt` 要在插件工厂函数的顶层声明（Task 7 里已经加了）。

- [ ] **Step 3: 跑端到端测试（控制条那条）**

```bash
npx playwright test test/e2e/screen-recorder.spec.js -g "控制条"
```

Expected: PASS ——「录制时桌面上有控制条：显示时长，点它能停」。

- [ ] **Step 4: 提交**

```bash
git add plugins/screen-recorder/pages/control.html plugins/screen-recorder/pages/control.js plugins/screen-recorder/lib/capture.js plugins/screen-recorder/main.js
git commit -m "style(录屏): 控制条按新的设计系统重画，计时自己走秒"
```

---

## Task 9: 快捷键的新语义 + 端到端测试更新

**Files:**
- Modify: `plugins/screen-recorder/main.js`
- Modify: `test/e2e/screen-recorder.spec.js`

**Interfaces:**
- Consumes: `ctx.host.onSurfaceChange(cb)`（第一期 Task 3 做好的）。
- Produces: 无。

- [ ] **Step 1: 快捷键跟着「界面开着」走**

`plugins/screen-recorder/main.js`：

把 `syncHotkey()` 改成：

```js
  /**
   * 录屏的界面开着的时候，快捷键才生效。
   *
   * 关掉界面就把这个组合键让回给别的程序——一个常驻抢键的
   * 录屏插件是很讨人厌的。
   *
   * 「界面开着」= 独立窗口开着，或面板正显示录屏。
   * 宿主知道这件事（第一期的 surface 路由会通知），所以不用轮询。
   */
  async function syncHotkey() {
    if (!surfaceOpen) {
      unregisterHotkey();
      return;
    }
    const cfg = await ensureConfig();
    const ok = registerHotkey(cfg.hotkey, () => {
      console.log('[录屏] 快捷键按下了');
      if (capture.isRecording()) capture.stop();
      else void startRecording();
    });
    hotkeyError = ok
      ? ''
      : cfg.hotkey
        ? `快捷键 ${cfg.hotkey} 注册不了——可能已经被别的程序占着了`
        : '没有设置快捷键';
  }
```

加一个状态变量与订阅：

```js
  /** 录屏的界面现在开着吗（宿主会通知）。 */
  let surfaceOpen = false;

  // 界面开合：宿主知道「我的界面挂着没有」。
  ctx.host.onSurfaceChange?.((pluginId, open) => {
    if (pluginId !== 'screen-recorder') return;
    surfaceOpen = open;
    void syncHotkey();
  });
```

**注意**：这一段要放在插件工厂函数的**顶层**（不在某个回调里），
这样插件一加载就订阅上了。

**注意**：`hotkeyError` 现在没有地方显示（工作台没了）——
它要显示在**界面页**上。所以 `statePayload()` 里要带上它：

```js
  function statePayload(cfg) {
    return {
      config: cfg,
      targets,
      recording,
      status,
      hotkeyError,
      elapsedMs: recording ? Date.now() - startedAt : 0,
      outputDir: (cfg.outputDir || '').trim() || app.getPath('videos'),
    };
  }
```

界面页（`studio.js`）里把它显示出来——在 `render()` 里加：

```js
  const hotkeyError = document.getElementById('hotkey-error');
  // …
  hotkeyError.textContent = state.hotkeyError || '';
  hotkeyError.hidden = !state.hotkeyError;
```

并在 `studio.html` 的快捷键那一行后面加：

```html
          <p class="studio-hint" id="hotkey-error" hidden></p>
```

- [ ] **Step 2: 更新端到端测试**

`test/e2e/screen-recorder.spec.js` 里那条「工作台开着时快捷键才生效，关掉就注销」
（第 318 行附近）改成：

```js
  test('录屏的界面开着时快捷键才生效，收起来就注销', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);

      // 面板里打开录屏：界面开着，快捷键应该注册上了。
      await panel.fill('#query', 'luping');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('screen-recorder'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("录屏")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, {
        timeout: 10000,
      });
      await panel.waitForFunction(
        () => window.__panel?.surfaceOpen === true,
        null,
        { timeout: 10000 }
      );

      const registered = await app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Control+Shift+R')
      );
      expect(registered, '界面开着时快捷键应该注册上了').toBe(true);

      // 回到搜索视图（等于把录屏的界面收起来）：快捷键要注销。
      await panel.evaluate(() => window.panel?.back?.());
      await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 10000 });
      await panel.waitForFunction(
        () => window.__panel?.surfaceOpen === false,
        null,
        { timeout: 10000 }
      );

      const after = await app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Control+Shift+R')
      );
      expect(after, '界面收起来后快捷键应该注销了').toBe(false);
    } finally {
      await app.close();
    }
  });
```

**注意**：这个测试要断言 `window.__panel.surfaceOpen`——
面板的诊断面（`src/renderer/panel/main.js` 的 `window.__panel`）里要加上这个字段。

**改 `src/renderer/panel/main.js`**（第一期改过的那个文件）的诊断面：

```js
window.__panel = {
  // …
  surfaceOpen: false,
};
```

并在 `renderPlugin()` 里（iframe 分支）设 `window.__panel.surfaceOpen = true`，
在 `renderSearch()` 里设 `window.__panel.surfaceOpen = false`。

**注意**：`renderPlugin` 的积木分支**也是**「界面开着」——
所以两个分支都要设 `true`，只有 `renderSearch()` 设 `false`。

- [ ] **Step 3: 加一条「切模式不重新列」的端到端测试**

在 `test/e2e/screen-recorder.spec.js` 里加：

```js
  test('切模式不重新列目标：列一次就够', async () => {
    const { app, pet } = await launch();
    try {
      // 在主进程里数着 getSources 被叫了几次。
      await app.evaluate(({ desktopCapturer }) => {
        const original = desktopCapturer.getSources.bind(desktopCapturer);
        globalThis.__getSourcesCount = 0;
        desktopCapturer.getSources = async (opts) => {
          globalThis.__getSourcesCount += 1;
          return original(opts);
        };
      });

      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'luping');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('screen-recorder'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("录屏")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, {
        timeout: 10000,
      });

      // 等第一次列完。
      await panel.waitForFunction(
        () => document.querySelectorAll('#plugin-frame, #plugin-body li').length > 0,
        null,
        { timeout: 10000 }
      );
      const afterOpen = await app.evaluate(() => globalThis.__getSourcesCount);

      // 切三次模式：不该再列。
      for (const mode of ['window', 'region', 'screen']) {
        await panel.evaluate((m) => {
          const frame = document.querySelector('#plugin-frame');
          if (frame?.contentWindow) {
            frame.contentWindow.document
              .querySelector(`#mode button[data-mode="${m}"]`)
              ?.click();
          }
        }, mode);
        await new Promise((r) => setTimeout(r, 600));
      }

      const afterSwitch = await app.evaluate(() => globalThis.__getSourcesCount);
      expect(afterSwitch, '切模式不该再列一次目标').toBe(afterOpen);
    } finally {
      await app.close();
    }
  });
```

**注意**：这个测试依赖界面页的 DOM 结构（`#mode button[data-mode=…]`），
所以它必须在 Task 7 之后跑。

**注意**：`app.evaluate` 里的 `desktopCapturer.getSources = ...` 能不能赋值，
取决于那个属性是不是可写的。Electron 的模块对象上的方法是普通属性 → 可写 ✓。
如果赋值失败（严格模式下抛错），改用：

```js
Object.defineProperty(desktopCapturer, 'getSources', {
  value: async (opts) => {
    globalThis.__getSourcesCount += 1;
    return original(opts);
  },
  configurable: true,
  writable: true,
});
```

- [ ] **Step 4: 跑全部端到端测试**

```bash
npm run test:e2e
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add plugins/screen-recorder/main.js plugins/screen-recorder/pages/studio.js plugins/screen-recorder/pages/studio.html src/renderer/panel/main.js test/e2e/screen-recorder.spec.js
git commit -m "feat(录屏): 快捷键跟着界面开合走，端到端测试更新"
```

---

## 收尾

- [ ] **Step 1: 跑全部测试**

```bash
npm run test:unit && npm run test:e2e
```

Expected: 全部通过。

- [ ] **Step 2: 更新 README 的录屏一节**

README 的「### 录屏」一节里，把

```
- **快捷键**：默认 `Control+Shift+R`，可以改。
  **只有录屏的工作台窗口开着的时候才生效**——关掉窗口就把这个组合键让回给别的程序；
```

改成

```
- **快捷键**：默认 `Control+Shift+R`，可以改。
  **只有录屏的界面开着的时候才生效**（独立窗口开着，或面板正显示录屏）——
  关掉就把这个组合键让回给别的程序；
```

并把「点「设置…」打开工作台改快捷键」那句改成
「在录屏界面的「设置」里改快捷键」。

- [ ] **Step 3: 确认工作区干净**

```bash
git status --short
```

Expected: 无输出（除了被 gitignore 的临时目录）。

- [ ] **Step 4: 提交收尾**

```bash
git add -A && git commit -m "docs(录屏): README 跟界面改法对齐"
```
