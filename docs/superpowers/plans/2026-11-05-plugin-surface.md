# 插件界面（surface）实施计划 —— 第一期：宿主

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「在新窗口打开」变成**所有插件**都有��宿主能力；插件自带的页面在面板工作台与独立窗口两处共用同一份；抽出界面路由与共享主题，让插件页面的开发变简单。

**Architecture:** 宿主的 `src/main/plugins/surface.js` 管「界面路由」——哪个插件的界面挂在哪、周期数据推给谁、tick 定时器什么时候起停。独立窗口与面板工作台各是一个 surface 实现。插件自带的页面（清单里的 `window.page`）由宿主用 `<iframe>` 装进两处（窄容器 / 宽容器），同一份 HTML 配容器查询做响应式。

**Tech Stack:** Electron 45（主进程 + 5 个 preload）、原生 ES module、`app://` 自定义协议（`secure: true`）、`node --test`（单元）、`@playwright/test` `_electron`（端到端）。

**Spec:** `docs/superpowers/specs/2026-11-05-plugin-surface-design.md`（§4 界面契约、§5 宿主改动）

**本计划只做第一期**（宿主）。录屏插件的界面重做与性能优化在
`docs/superpowers/plans/2026-11-05-screen-recorder-redesign.md`（第二期）。

## Global Constraints

以下几条来自 spec，**每个任务都隐含包含**：

- `app://` 是 secure context（`src/main/protocol.js:48-53` 注册了 `secure: true`）；插件页面一律走 `app://`，不再用 `file://`。
- 插件页面与父页面**同源**（origin 都是 `app://bundle`），所以 iframe 里可以直接读 `parent.plugin` / `parent.panel.surface`。
- 界面契约只有一份：`data(ctx)` / `tick(ctx)` / `act(ctx, actionId, payload)` / `action(ctx, actionId, value)`，另加**可选**的 `meta(ctx)`。
- `meta(ctx)` 返回 `{ title, subtitle, status }`；不写就退回用 `page(ctx)` 的同名字段。**带自定义页面的插件，`page(ctx)` 里不许做重活**（不列目标、不读磁盘）。
- 界面路由的 tick 定时器：**第一个 surface 挂上来时起，最后一个摘掉时停**。
- 合成出来的默认窗口规格：`title` = 插件名，`width` = 360，`height` = 420，`refreshMs` = 0，`alwaysOnTop` = **false**。
- 清单里**写了** `window` 段的插件，沿用老规矩：`normalizeWindowSpec` 没写 `alwaysOnTop` 就当 `true`。
- `widget`（桌面小部件）这一轮**不动**：插件的页面仍**原样加载**（带 preload），不套 iframe、不换壳。
- 面板插件视图的内容高度上限 **640px**，超出就滚动。
- 面板高度由内容撑开：`reportHeight()` → `panel:size` → `setBounds`（`src/main/panel.js:376-381`）。
- 用户插件走虚拟根 `/__plugins__/<id>`，内置插件走 `/plugins/<id>`（`host.baseUrl()`）。
- 插件主进程代码**没有沙箱**（README「插件能拿到什么」）；插件页面（渲染层）**有**沙箱，`contextIsolation: true`，`sandbox: true`。
- 全项目文案是中文；注释也写中文，解释「为什么」不解释「是什么」。
- 提交信息沿用仓库风格：`feat(范围): 描述` / `fix(范围): 描述` / `docs(范围): 描述`。

## Review Focus

spec 说了「软件必须做什么」，没说的输入**不等于可以坏掉**。下面五条是最可能咬到人的，
每条都在下面某个任务里配了对应的测试。

| # | 输入 / 情况 | 合理的人会期望 | 落在 |
| --- | --- | --- | --- |
| 1 | 插件自带页面**加载失败**（路径写错、HTML 有语法错） | 独立窗口与面板都**退回积木界面**，不能白屏 | Task 6 |
| 2 | **用户插件**（userData 里的）带自定义页面 | iframe 的 src 要用 `/__plugins__/<id>` 前缀，不是 `/plugins/<id>` | Task 6 |
| 3 | 同一个插件**同时**在面板与独立窗口开着 | 两处看到的数据一致（一次 tick 两边都收到） | Task 3 |
| 4 | 面板收起来 / 插件窗口关掉 | 插件的 tick 定时器**停掉**，不白烧 CPU | Task 3 |
| 5 | 设置里**关掉**一个插件 | 它的独立窗口关掉；面板回到搜索视图 | Task 7 |

---

## 文件结构

**新建：**

| 文件 | 职责 |
| --- | --- |
| `src/main/plugins/surface.js` | 界面路由：哪个插件的界面挂在哪、周期数据推给谁、tick 定时器起停 |
| `src/renderer/ui/theme.css` | 共享设计系统：颜色/圆角/间距变量 + 组件（按钮、分段控件、开关、列表、底部条） |
| `src/renderer/ui/pluginPage.js` | 插件页面助手：插件页面 `import` 它就得到一套统一的界面 API |
| `test/unit/plugin-window-spec.test.js` | 默认窗口规格与 `resolveWindowSpec` 的单元测试 |
| `test/unit/plugin-surface.test.js` | 界面路由（attach/detach/tick/broadcast）的单元测试 |
| `test/e2e/plugin-surface.spec.js` | 端到端：↗ 按钮、iframe 两处一致、用户插件、自定义页面加载失败 |

**修改：**

| 文件 | 改什么 |
| --- | --- |
| `src/shared/plugin.js` | 加 `defaultWindowSpec` / `resolveWindowSpec`；`canDetach` 恒真 |
| `src/main/plugins/host.js` | `spec()` 走 `resolveWindowSpec`；`toMeta()` 加 `hasPage` / `pageUrl` |
| `src/main/plugins/window.js` | 读规格改走 `host.spec()`；窗口形态改成「壳 + iframe」；接上 surface |
| `src/main/panel.js` | 面板的 surface：接 surface 控制器、`panel:surface:*` 的 IPC |
| `src/preload/panel.cjs` | 暴露 `window.panel.surface` 与 `setCurrentPlugin` |
| `src/preload/plugin.cjs` | 暴露 `window.plugin.pageUrl`（壳里装 iframe 用） |
| `src/renderer/panel/index.html` | 链 `theme.css`；加一个 `<iframe id="plugin-frame">` |
| `src/renderer/panel/main.js` | 插件视图：自带页面的插件走 iframe，其余照旧画积木 |
| `src/renderer/plugin-window/index.html` | 链 `theme.css`；加一个 `<iframe id="plugin-frame">` |
| `src/renderer/plugin-window/main.js` | 有 `src` 时装 iframe，没有就画积木 |
| `src/renderer/ui/blocks.css` | 改用 `theme.css` 的变量（颜色不再写死） |
| `README.md` | 「插件系统」一节：↗ 是所有插件都有的；插件自带页面两处共用 |

---

## Task 1: 默认窗口规格——每个插件都能在新窗口打开

**Files:**
- Modify: `src/shared/plugin.js`
- Modify: `src/main/plugins/host.js`（`spec()` 与 `toMeta()`）
- Test: `test/unit/plugin-window-spec.test.js`

**Interfaces:**
- Consumes: 现有的 `PLUGIN_WINDOW_MODE`、`PLUGIN_WINDOW_LIMITS`、`normalizeWindowSpec()`。
- Produces:
  - `defaultWindowSpec(manifest) → { mode, page, title, width, height, refreshMs, alwaysOnTop }`
  - `resolveWindowSpec(manifest, mode) → 规格对象 | null`（widget 没写就是 `null`）
  - `host.spec(id, mode)` 改为返回**已解析**的规格（原来返回清单里的原始段）。

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/plugin-window-spec.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultWindowSpec,
  resolveWindowSpec,
  canDetach,
  hasWidget,
  PLUGIN_WINDOW_MODE,
  PLUGIN_WINDOW_LIMITS,
} from '../../src/shared/plugin.js';

/**
 * 「在新窗口打开」是**桌宠**给所有插件的能力，不是插件的特权。
 * 所以清单里没写 `window` 段，宿主也要能合成出一份来。
 */

test('没写 window 段：合成一份默认规格', () => {
  const spec = defaultWindowSpec({ name: '待办' });
  assert.equal(spec.mode, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.title, '待办');
  assert.equal(spec.width, PLUGIN_WINDOW_LIMITS.width);
  assert.equal(spec.height, PLUGIN_WINDOW_LIMITS.height);
  assert.equal(spec.refreshMs, 0);
  // 没声明过的插件不该一上来就压在别人窗口上。
  assert.equal(spec.alwaysOnTop, false);
  assert.equal(spec.page, '');
});

test('resolveWindowSpec：没写 window 段就用合成的那份', () => {
  const manifest = { id: 'todos', name: '待办' };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.title, '待办');
  assert.equal(spec.width, PLUGIN_WINDOW_LIMITS.width);
});

test('resolveWindowSpec：写了 window 段就以清单为准', () => {
  const manifest = {
    id: 'todos',
    name: '待办',
    window: { title: '我的待办', width: 500, height: 600 },
  };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.title, '我的待办');
  assert.equal(spec.width, 500);
  assert.equal(spec.height, 600);
});

test('resolveWindowSpec：widget 没写就是没有（小部件仍然要插件自愿）', () => {
  const manifest = { id: 'todos', name: '待办' };
  assert.equal(resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WIDGET), null);
});

test('resolveWindowSpec：widget 写了就用清单里那份', () => {
  const manifest = {
    id: 'system',
    name: '系统状态',
    widget: { title: '系统监控', width: 216, height: 108 },
  };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WIDGET);
  assert.equal(spec.title, '系统监控');
  assert.equal(spec.width, 216);
});

test('每个插件都能分离成独立窗口', () => {
  assert.equal(canDetach({ id: 'todos', name: '待办' }), true);
  assert.equal(canDetach({ id: 'screen-recorder', name: '录屏' }), true);
});

test('小部件仍然要插件自己声明', () => {
  assert.equal(hasWidget({ id: 'todos', name: '待办' }), false);
  assert.equal(hasWidget({ id: 'system', name: '系统状态', widget: {} }), true);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test test/unit/plugin-window-spec.test.js
```

Expected: FAIL —— `defaultWindowSpec` / `resolveWindowSpec` 还没导出（`SyntaxError: The requested module ... does not provide an export named 'defaultWindowSpec'`）。

- [ ] **Step 3: 实现**

在 `src/shared/plugin.js` 里，`normalizeWindowSpec` 之后加：

```js
/**
 * 合成一份**默认**的窗口规格。
 *
 * 插件清单里没写 `window` 段，**不代表它不能开独立窗口**——
 * 「在新窗口打开」是桌宠给所有插件的能力，不是插件的特权
 * （见 README「独立窗口与桌面小部件」）。
 *
 * 合成的这份刻意「朴素」：不置顶、不自动刷新，
 * 用户想置顶可以点标题栏的 📌。
 */
export function defaultWindowSpec(manifest) {
  return {
    mode: PLUGIN_WINDOW_MODE.WINDOW,
    page: '',
    title: str(manifest?.name).trim(),
    width: PLUGIN_WINDOW_LIMITS.width,
    height: PLUGIN_WINDOW_LIMITS.height,
    refreshMs: 0,
    alwaysOnTop: false,
  };
}

/**
 * 某个形态**实际生效**的窗口规格。
 *
 * - `window`：清单里写了就用清单的，没写就合成一份默认的
 *   ——**每个插件都能开独立窗口**。
 * - `widget`：**没有就是没有**。小部件要占着用户的桌面，
 *   是插件自己该决定的事，不该由宿主替它决定。
 */
export function resolveWindowSpec(manifest, mode) {
  // 声明出来的那一段**再归一化一次**：这个导出函数的返回形状
  // 不该取决于调用方有没有先跑过 `validateManifest`。
  //
  // 「合成」的那一份**不归一化**——`normalizeWindowSpec` 的 alwaysOnTop
  // 默认是 true，归一化会把合成规格从 false 翻成 true，
  // 弄丢「没声明过 window 段的插件不压在别人窗口上」这条规则。
  if (mode === PLUGIN_WINDOW_MODE.WIDGET) {
    if (!manifest?.widget) return null;
    return normalizeWindowSpec(manifest.widget, PLUGIN_WINDOW_MODE.WIDGET);
  }
  if (!manifest?.window) return defaultWindowSpec(manifest);
  return normalizeWindowSpec(manifest.window, PLUGIN_WINDOW_MODE.WINDOW);
}
```

把 `canDetach` 改成：

```js
/**
 * 这个插件能不能「分离成独立窗口」。
 *
 * **恒为 true**：能开独立窗口是桌宠给所有插件的能力，
 * 清单里没写 `window` 段，宿主会合成一份默认规格出来。
 *
 * 内置功能（设置、聊天记录）不是插件，它们不走这条路——
 * 它们的元数据里 `canDetach` 是显式的 false（见 src/main/builtins.js）。
 */
export function canDetach(manifest) {
  return true;
}
```

- [ ] **Step 4: 让 `host.spec()` 返回解析后的规格，并加 `host.pageUrl()`**

`src/main/plugins/host.js` 顶部的 import 加上 `resolveWindowSpec` 与文件工具：

```js
import { canDetach, hasWidget, resolveWindowSpec, PLUGIN_WINDOW_MODE } from '../../src/shared/plugin.js';
import { statSync } from 'node:fs';
```

在 `baseUrl(id)` 后面加：

```js
  /**
   * 插件自带的那个页面，它**在不在**。
   *
   * 清单里写的路径可能指向一个不存在的文件（作者写错了、或者文件被删了）。
   * 这种情况**不能白屏**：宿主要退回积木界面，插件照样能用。
   *
   * 查的是磁盘上的真实路径（`record.dir` + 相对路径）——
   * 内置插件与用户插件都适用（用户插件的目录在 userData 里，也是真实路径）。
   */
  function pageExists(record, page) {
    if (!record || !page) return false;
    try {
      return statSync(join(record.dir, page)).isFile();
    } catch {
      return false;
    }
  }
```

把文件末尾的 `spec` 改成：

```js
    /**
     * 某个形态实际生效的窗口规格（尺寸、刷新间隔……）。
     *
     * 已经**解析**过了：清单里没写 `window` 段也会合成出一份默认的
     * ——「在新窗口打开」是所有插件都有的能力。
     */
    spec: (id, mode) => {
      const record = records.get(id);
      if (!record) return null;
      return resolveWindowSpec(record.manifest, mode);
    },
    /**
     * 插件自带的页面的完整 URL。
     *
     * 页面**不存在**时返回空串——调用方（窗口控制器、面板元数据）
     * 据此退回积木界面，而不是开一个白窗口。
     */
    pageUrl: (id) => {
      const record = records.get(id);
      if (!record) return '';
      const page = record.manifest.window?.page;
      if (!page || !pageExists(record, page)) return '';
      return appUrl(`${baseUrl(id)}/${page}?plugin=${encodeURIComponent(id)}`);
    },
```

**注意**：`pageUrl` 需要 `appUrl`——在文件顶部 import：

```js
import { appUrl } from '../protocol.js';
```

`join` 已经在文件里 import 过了 ✓（`import { join } from 'node:path';`）。

- [ ] **Step 5: 跑测试，确认通过**

```bash
node --test test/unit/plugin-window-spec.test.js
```

Expected: PASS，7 个测试全过。

- [ ] **Step 6: 跑全部单元测试，确认没弄坏别的**

```bash
npm run test:unit
```

Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
git add src/shared/plugin.js src/main/plugins/host.js test/unit/plugin-window-spec.test.js
git commit -m "feat(插件): 新窗口成为所有插件都有的能力

清单里没写 window 段时宿主合成一份默认规格，canDetach 恒真；
小部件仍然要插件自己声明。"
```

---

## Task 2: 窗口控制器改用解析后的规格

**Files:**
- Modify: `src/main/plugins/window.js`
- Create: `test/e2e/plugin-detach.spec.js`

**Interfaces:**
- Consumes: `host.spec(pluginId, mode)`（Task 1 改成返回解析后的规格）。
- Produces: 无新接口。窗口控制器内部不再直接读 `record.manifest.window`。

- [ ] **Step 1: 找出所有直接读清单的地方**

```bash
grep -n "manifest.window\|manifest.widget" src/main/plugins/window.js
```

Expected: 5 处 —— 第 66、79、157、242、270 行附近（`pageUrl`、`createWindow`、`open`、`onReady`、`refresh`）。

- [ ] **Step 2: 逐处换成 `host.spec()`**

`src/main/plugins/window.js` 里，把

```js
const spec = mode === PLUGIN_WINDOW_MODE.WIDGET ? record.manifest.widget : record.manifest.window;
```

换成

```js
const spec = host.spec(pluginId, mode);
```

（`pageUrl` 与 `createWindow` 里已经有 `pluginId` 参数；`onReady` 与 `refresh` 里用
`entry.pluginId`。）

`open()` 里那一段：

```js
    // 清单里没写这一段 = 这个插件没有这种形态。
    const spec = wantMode === PLUGIN_WINDOW_MODE.WIDGET ? record.manifest.widget : record.manifest.window;
    if (!spec) {
      return {
        ok: false,
        message: wantMode === PLUGIN_WINDOW_MODE.WIDGET ? '这个插件没有小部件形态' : '这个插件不能分离成独立窗口',
      };
    }
```

换成：

```js
    // 独立窗口：每个插件都有（没写 `window` 段就合成一份默认的）。
    // 小部件：仍然要插件自己声明——它要占着用户的桌面。
    const spec = host.spec(pluginId, wantMode);
    if (!spec) {
      return {
        ok: false,
        message: wantMode === PLUGIN_WINDOW_MODE.WIDGET ? '这个插件没有小部件形态' : '这个插件不能分离成独立窗口',
      };
    }
```

**注意**：`host.spec()` 在 `host.get(pluginId)` 找不到插件时返回 `null`，
所以 `createWindow` 里那句 `if (!record) return null;` 保持不变。

- [ ] **Step 3: 确认没有遗漏**

```bash
grep -n "manifest.window\|manifest.widget" src/main/plugins/window.js
```

Expected: 无输出。

- [ ] **Step 4: 写端到端测试（先失败）**

新建 `test/e2e/plugin-detach.spec.js`：

```js
// 插件能不能分离成独立窗口——**每个**插件都能。
//
// 录屏的清单里没写 `window` 段：以前它的面板上没有「在新窗口打开」按钮，
// 现在必须有，而且点了要真能开出一个窗口。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-detach');

async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes(part)) return win;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel?.());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes('/renderer/panel/index.html')) {
          await win.waitForLoadState('domcontentloaded');
          return win;
        }
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('面板没有出现');
}

test.describe('插件分离成独立窗口', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('清单里没写 window 段的插件（录屏）也能分离成独立窗口', async () => {
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

      // 按钮在（以前它被藏掉了）。
      await expect(panel.locator('#detach')).toBeVisible();

      // 点了要真能开出一个窗口——以前这里会报「这个插件不能分离成独立窗口」。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '录屏的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');
      await pluginWin.waitForFunction(() => document.getElementById('title')?.textContent === '录屏', null, {
        timeout: 15000,
      });
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 5: 跑测试，确认通过**

```bash
npx playwright test test/e2e/plugin-detach.spec.js
```

Expected: PASS。

**如果失败且报「这个插件不能分离成独立窗口」**：说明 Step 2 有一处没换干净——
回去看 Step 3 的 grep 有没有漏。

- [ ] **Step 6: 提交**

```bash
git add src/main/plugins/window.js test/e2e/plugin-detach.spec.js
git commit -m "refactor(插件): 窗口控制器统一走 host.spec() 拿规格"
```

---

## Task 3: 界面路由（surface）—— 谁挂着界面，数据推给谁

**Files:**
- Create: `src/main/plugins/surface.js`
- Modify: `src/main/plugins/host.js`（暴露「界面开合」的回调）
- Test: `test/unit/plugin-surface.test.js`

**Interfaces:**
- Consumes: `host`（要 `host.spec(id, mode)` 与 `host.tick(id)`）。
- Produces:
  ```js
  createSurfaceController({ host, onChange }) → {
    attach(pluginId, surface),   // surface = { kind, deliver(kind, payload) }
    detach(pluginId, surface),
    broadcast(pluginId, kind, payload),
    isAttached(pluginId) → boolean,
    stopAll(),
  }
  ```
  `kind` ∈ `'data' | 'tick' | 'page'`。
  `onChange(pluginId, open)`：**第一个**界面挂上来 / **最后一个**摘掉时各调一次。

  宿主侧：`host.onSurfaceChange(cb)` —— 插件想知道「我的界面开着吗」
  （录屏的快捷键要靠它决定生不生效）。

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/plugin-surface.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSurfaceController } from '../../src/main/plugins/surface.js';

/**
 * 界面路由：插件的界面挂在哪、周期数据推给谁、tick 定时器什么时候起停。
 *
 * 这一层**不碰 Electron**：它只管「哪个 surface 该收到哪条数据」。
 */

/** 假宿主：只提供 surface 控制器要用到的两样东西。 */
function fakeHost({ refreshMs = 0, tickValue = 'T' } = {}) {
  const calls = { tick: 0 };
  return {
    calls,
    host: {
      spec: () => ({ refreshMs }),
      tick: async () => {
        calls.tick += 1;
        return tickValue;
      },
    },
  };
}

/** 假 surface：记录收到的东西。 */
function fakeSurface(kind = 'panel') {
  const received = [];
  return {
    received,
    surface: {
      kind,
      deliver: (k, payload) => received.push({ kind: k, payload }),
    },
  };
}

test('没有 surface 挂着：不推数据，也不起定时器', () => {
  const { host, calls } = fakeHost({ refreshMs: 100 });
  const ctl = createSurfaceController({ host });
  ctl.broadcast('todos', 'tick', 'x');
  assert.equal(calls.tick, 0);
  assert.equal(ctl.isAttached('todos'), false);
});

test('挂着两个 surface：一次 tick 两边都收到', () => {
  const { host } = fakeHost();
  const ctl = createSurfaceController({ host });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  ctl.broadcast('todos', 'tick', { n: 1 });
  assert.deepEqual(a.received, [{ kind: 'tick', payload: { pluginId: 'todos', data: { n: 1 } } }]);
  assert.deepEqual(b.received, [{ kind: 'tick', payload: { pluginId: 'todos', data: { n: 1 } } }]);
});

test('摘掉一个 surface：另一个还收得到', () => {
  const { host } = fakeHost();
  const ctl = createSurfaceController({ host });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  ctl.detach('todos', a.surface);
  ctl.broadcast('todos', 'tick', 'x');
  assert.equal(a.received.length, 0);
  assert.equal(b.received.length, 1);
});

test('refreshMs 为 0 的插件不起定时器', () => {
  const { host, calls } = fakeHost({ refreshMs: 0 });
  const ctl = createSurfaceController({ host });
  const a = fakeSurface();
  ctl.attach('todos', a.surface);
  assert.equal(calls.tick, 0);
  ctl.detach('todos', a.surface);
});

test('摘掉最后一个 surface：定时器停掉', async () => {
  const { host, calls } = fakeHost({ refreshMs: 20 });
  const ctl = createSurfaceController({ host });
  const a = fakeSurface();
  ctl.attach('todos', a.surface);
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(calls.tick >= 2, `应该至少推了两次，实际 ${calls.tick}`);
  const before = calls.tick;
  ctl.detach('todos', a.surface);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(calls.tick, before, '摘掉之后不该再推');
});

test('stopAll：所有定时器都停掉', async () => {
  const { host, calls } = fakeHost({ refreshMs: 20 });
  const ctl = createSurfaceController({ host });
  ctl.attach('todos', fakeSurface().surface);
  ctl.attach('system', fakeSurface().surface);
  await new Promise((r) => setTimeout(r, 70));
  ctl.stopAll();
  const before = calls.tick;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(calls.tick, before);
});

test('界面开合：第一个挂上来报「开」，最后一个摘掉报「关」', () => {
  const { host } = fakeHost();
  const events = [];
  const ctl = createSurfaceController({
    host,
    onChange: (pluginId, open) => events.push({ pluginId, open }),
  });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  ctl.detach('todos', a.surface);
  // 还挂着另一个界面：不该报「关」。
  assert.deepEqual(events, [{ pluginId: 'todos', open: true }]);
  ctl.detach('todos', b.surface);
  assert.deepEqual(events, [
    { pluginId: 'todos', open: true },
    { pluginId: 'todos', open: false },
  ]);
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
node --test test/unit/plugin-surface.test.js
```

Expected: FAIL —— `Cannot find module '../../src/main/plugins/surface.js'`。

- [ ] **Step 3: 实现**

新建 `src/main/plugins/surface.js`：

```js
// src/main/plugins/surface.js

/**
 * 界面路由。
 *
 * 一个插件的界面可以同时挂在好几处：面板的工作台里一份，
 * 独立窗口里一份。这一层管的是：
 *
 * 1. **谁挂着**：哪个插件的界面挂在哪些地方；
 * 2. **推给谁**：周期数据要送到所有挂着的地方（两处看到的数据必须一致）；
 * 3. **什么时候推**：tick 定时器**第一个 surface 挂上来时起，
 *    最后一个摘掉时停**——界面都没了还按秒推，那是白烧 CPU。
 *
 * 这里**不碰 Electron**：surface 自己知道怎么把数据送出去
 * （`deliver(kind, payload)`），这一层只管「该送给谁」。
 */

/** 一个 surface 至少要有这两样。 */
function isSurface(value) {
  return Boolean(value) && typeof value.deliver === 'function';
}

export function createSurfaceController({ host, onChange }) {
  /** pluginId → Set<surface> */
  const attached = new Map();
  /** pluginId → 定时器 */
  const timers = new Map();

  /**
   * 界面开合了：第一个挂上来 / 最后一个摘掉。
   *
   * 插件靠它知道「我的界面现在开着吗」——
   * 录屏的快捷键只在界面开着时才生效（见第二期计划）。
   */
  function notify(pluginId, open) {
    try {
      onChange?.(pluginId, open);
    } catch (err) {
      console.warn('[desk-pet] 界面开合的回调出错：', err?.message);
    }
  }

  /** 这个插件现在挂着哪些 surface。 */
  function surfacesOf(pluginId) {
    let set = attached.get(pluginId);
    if (!set) {
      set = new Set();
      attached.set(pluginId, set);
    }
    return set;
  }

  /** 插件的刷新间隔（毫秒）。0 = 不刷。 */
  function refreshMsOf(pluginId) {
    const spec = host?.spec?.(pluginId, 'window');
    const ms = Number(spec?.refreshMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  /** 推一次周期数据。 */
  async function pushTick(pluginId) {
    if (!surfacesOf(pluginId).size) return;
    let data;
    try {
      data = await host?.tick?.(pluginId);
    } catch (err) {
      console.warn(`[desk-pet] 插件「${pluginId}」刷新失败：`, err?.message);
      return;
    }
    if (data === undefined) return;
    broadcast(pluginId, 'tick', data);
  }

  /**
   * 把一份数据推给某个插件的所有 surface。
   *
   * **统一包成 `{ pluginId, data }`**：面板可能在两个插件之间来回切，
   * 收到的数据得带得清是给谁的。各 surface **不拆包**——
   * 拆包的是宿主壳（plugin-window/main.js）与插件页面助手（pluginPage.js）。
   */
  function broadcast(pluginId, kind, payload) {
    const set = attached.get(pluginId);
    if (!set || !set.size) return;
    for (const surface of set) {
      try {
        surface.deliver(kind, { pluginId, data: payload });
      } catch (err) {
        console.warn(`[desk-pet] 插件「${pluginId}」的界面收数据失败：`, err?.message);
      }
    }
  }

  /** 挂上一个界面。 */
  function attach(pluginId, surface) {
    if (!pluginId || !isSurface(surface)) return;
    const set = surfacesOf(pluginId);
    const wasEmpty = set.size === 0;
    set.add(surface);
    if (wasEmpty) notify(pluginId, true);
    const refreshMs = refreshMsOf(pluginId);
    if (refreshMs > 0 && !timers.has(pluginId)) {
      timers.set(pluginId, setInterval(() => void pushTick(pluginId), refreshMs));
    }
  }

  /** 摘下一个界面。 */
  function detach(pluginId, surface) {
    const set = attached.get(pluginId);
    if (!set) return;
    set.delete(surface);
    if (set.size === 0) {
      attached.delete(pluginId);
      stopTimer(pluginId);
      notify(pluginId, false);
    }
  }

  function stopTimer(pluginId) {
    const timer = timers.get(pluginId);
    if (timer) {
      clearInterval(timer);
      timers.delete(pluginId);
    }
  }

  return {
    attach,
    detach,
    broadcast,
    isAttached: (pluginId) => Boolean(attached.get(pluginId)?.size),
    /** 退出前把定时器全停掉。 */
    stopAll() {
      for (const pluginId of [...timers.keys()]) stopTimer(pluginId);
      attached.clear();
    },
  };
}
```

- [ ] **Step 4: 宿主暴露「界面开合」的回调**

`src/main/plugins/host.js`：

在 `let windowOpener = null;` 后面加：

```js
  /** 插件界面开合的回调（插件想知道「我的界面开着吗」）。 */
  const surfaceListeners = new Set();
```

在 `return { ... }` 里加两个方法：

```js
    /**
     * 某个插件的界面开合了。
     *
     * 「开」= 第一个界面挂上来，「关」= 最后一个界面摘掉。
     * 录屏的快捷键靠它决定生不生效（见第二期计划）。
     */
    surfaceChanged: (pluginId, open) => {
      for (const cb of surfaceListeners) {
        try {
          cb(pluginId, open);
        } catch (err) {
          console.warn('[desk-pet] 界面开合的回调出错：', err?.message);
        }
      }
    },
    /** 订阅界面开合。返回取消订阅的函数。 */
    onSurfaceChange: (cb) => {
      surfaceListeners.add(cb);
      return () => surfaceListeners.delete(cb);
    },
```

`src/main/index.js` 里，`createSurfaceController` 的调用（Task 7 才建起来）写成：

```js
    pluginSurfaces = createSurfaceController({
      host: plugins,
      onChange: (pluginId, open) => plugins.surfaceChanged(pluginId, open),
    });
```

**注意**：Task 7 才会真正创建 `pluginSurfaces`。这一轮先把宿主侧的接口备好，
Task 7 里再把控制器建起来并传进去。

- [ ] **Step 5: 跑测试，确认通过**

```bash
node --test test/unit/plugin-surface.test.js
```

Expected: PASS，6 个测试全过。

- [ ] **Step 6: 提交**

```bash
git add src/main/plugins/surface.js src/main/plugins/host.js test/unit/plugin-surface.test.js
git commit -m "feat(插件): 抽出界面路由——tick 定时器跟着界面走"
```

---

## Task 4: 共享设计系统（theme.css）

**Files:**
- Create: `src/renderer/ui/theme.css`
- Modify: `src/renderer/ui/blocks.css`
- Modify: `src/renderer/panel/index.html`
- Modify: `src/renderer/plugin-window/index.html`

**Interfaces:**
- Consumes: 无。
- Produces: `src/renderer/ui/theme.css`，在 `app://` 下的路径是 `/src/renderer/ui/theme.css`。
  插件页面可以 `<link rel="stylesheet" href="/src/renderer/ui/theme.css">` 链它。

- [ ] **Step 1: 建 theme.css**

新建 `src/renderer/ui/theme.css`：

```css
/*
 * 共享设计系统。
 *
 * 面板、插件的独立窗口、插件自带的页面——**全都链这一份**。
 * 所有插件因此长一个样：底色、圆角、强调色、控件的样子都是一份。
 *
 * 插件页面在 app:// 下，用绝对路径链它：
 *   <link rel="stylesheet" href="/src/renderer/ui/theme.css">
 */

:root {
  color-scheme: light;

  /* 底与面 */
  --dp-bg: #fffdf8;
  --dp-surface: #f6f2e7;
  --dp-surface-hover: #efe9d8;
  --dp-border: #c9c1b0;
  --dp-border-soft: #ece6d8;

  /* 字 */
  --dp-text: #2b2a26;
  --dp-text-soft: #8a8272;
  --dp-text-faint: #a9a294;

  /* 强调 */
  --dp-accent: #d9c9a3;
  --dp-accent-strong: #bda87c;
  --dp-accent-ink: #4a3f2a;
  --dp-danger: #c9503f;

  /* 形 */
  --dp-radius-sm: 7px;
  --dp-radius: 9px;
  --dp-radius-lg: 14px;
  --dp-gap: 8px;

  --dp-font: 14px/1.6 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
}

/* 宿主自己的页面（面板、插件壳）用这一份字体与底色。 */
.dp-page {
  font: var(--dp-font);
  color: var(--dp-text);
  background: var(--dp-bg);
}

/* 按钮 */
.dp-button {
  font: inherit;
  padding: 6px 13px;
  border: 1px solid var(--dp-border);
  border-radius: var(--dp-radius);
  background: var(--dp-surface);
  color: var(--dp-text);
  cursor: pointer;
}
.dp-button:hover { background: var(--dp-surface-hover); }
.dp-button.primary {
  background: var(--dp-accent);
  border-color: var(--dp-accent-strong);
  color: var(--dp-accent-ink);
}
.dp-button.danger {
  background: var(--dp-danger);
  border-color: var(--dp-danger);
  color: #fff;
}

/* 分段控件：一排互斥的选项，当前那个是「按下去」的。 */
.dp-segmented {
  display: inline-flex;
  padding: 3px;
  gap: 3px;
  border: 1px solid var(--dp-border);
  border-radius: var(--dp-radius);
  background: var(--dp-surface);
}
.dp-segmented button {
  font: inherit;
  padding: 5px 14px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dp-text-soft);
  cursor: pointer;
}
.dp-segmented button[aria-pressed='true'] {
  background: var(--dp-bg);
  color: var(--dp-text);
  box-shadow: 0 1px 2px rgba(40, 34, 24, 0.12);
}

/* 开关 */
.dp-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dp-switch input { accent-color: var(--dp-accent-strong); }

/* 列表 */
.dp-list { list-style: none; margin: 0; padding: 0; }
.dp-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: var(--dp-radius);
  cursor: pointer;
}
.dp-list li:hover { background: var(--dp-surface); }
.dp-list .label { flex: 1; word-break: break-word; }
.dp-list .hint { color: var(--dp-text-faint); font-size: 12px; white-space: nowrap; }

/* 分节标题 */
.dp-section-title {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--dp-text-soft);
}
.dp-section-title:first-child { margin-top: 0; }

/* 输入框 */
.dp-input {
  font: inherit;
  padding: 7px 10px;
  border: 1px solid var(--dp-border);
  border-radius: var(--dp-radius);
  background: #fff;
  color: inherit;
}
.dp-input:focus { outline: 2px solid var(--dp-accent); outline-offset: 1px; }

/* 底部条：状态在左，动作在右。 */
.dp-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--dp-border-soft);
  color: var(--dp-text-soft);
  font-size: 12px;
}
.dp-footer .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-footer .time { font-variant-numeric: tabular-nums; }

/*
 * 容器查询的容器。
 *
 * 宿主给内容区套这一层，插件页面用
 *   @container surface (min-width: 520px) { … }
 * 决定窄的时候怎么排、宽的时候怎么排。
 *
 * 容器只看**宽度**：面板高度变化不会反过来影响布局，没有死循环。
 */
.surface {
  container-type: inline-size;
  container-name: surface;
}
```

- [ ] **Step 2: 让 blocks.css 改用变量**

`src/renderer/ui/blocks.css` 顶部加一行 import（CSS 的 `@import` 必须在最前）：

```css
@import url('/src/renderer/ui/theme.css');
```

然后把文件里写死的颜色换成变量：

| 原来 | 换成 |
| --- | --- |
| `#f6f1e4` | `var(--dp-surface)` |
| `#9a9384` | `var(--dp-text-faint)` |
| `#a29a89` | `var(--dp-text-faint)` |
| `#b3ab99` | `var(--dp-text-faint)` |
| `#efe6d2` / `#8a6a4a` | `var(--dp-surface-hover)` / `var(--dp-accent-ink)` |
| `#c9c1b0` | `var(--dp-border)` |
| `#f6f2e7` | `var(--dp-surface)` |
| `#efe9d8` | `var(--dp-surface-hover)` |
| `#d9c9a3` | `var(--dp-accent)` |
| `#bda87c` | `var(--dp-accent-strong)` |
| `#3a352c` | `var(--dp-text)` |
| `#c8b78f` | `var(--dp-accent)` |

**注意**：`@import url('/src/renderer/ui/theme.css')` 用的是绝对路径，
`blocks.css` 自己是通过 `/src/renderer/ui/blocks.css` 加载的，
所以相对路径会变成 `/src/renderer/ui/src/renderer/ui/theme.css` —— **必须用绝对路径**。

- [ ] **Step 3: 两个宿主页面链上 theme.css**

`src/renderer/panel/index.html` 的 `<head>` 里，把

```html
  <link rel="stylesheet" href="/src/renderer/ui/blocks.css">
```

改成

```html
  <link rel="stylesheet" href="/src/renderer/ui/theme.css">
  <link rel="stylesheet" href="/src/renderer/ui/blocks.css">
```

`src/renderer/plugin-window/index.html` 同样改。

- [ ] **Step 4: 确认页面没崩**

```bash
npm run test:e2e -- test/e2e/panel.spec.js
```

Expected: 全部通过（`panel.spec.js` 里有「卡片四周留白放得下投影」那条，
它会量实际渲染尺寸，颜色改动不该影响它）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/ui/theme.css src/renderer/ui/blocks.css src/renderer/panel/index.html src/renderer/plugin-window/index.html
git commit -m "feat(插件): 共享设计系统 theme.css，所有界面一份样式"
```

---

## Task 5: 插件页面助手（pluginPage.js）

**Files:**
- Create: `src/renderer/ui/pluginPage.js`
- Test: 无独立单测（它依赖 `window`，用 e2e 覆盖，见 Task 6/7）

**Interfaces:**
- Consumes: 父页面上的 `window.plugin`（插件壳）或 `window.panel.surface`（面板）。
- Produces:
  ```js
  bindSurface() → {
    id, mode,
    data() → Promise<any>,
    onData(cb), onTick(cb),
    act(actionId, payload) → Promise<any>,
    action(actionId, value) → Promise<any>,
    setStatus(text),
    setHeight(px),
  }
  ```

- [ ] **Step 1: 实现**

新建 `src/renderer/ui/pluginPage.js`：

```js
/**
 * 插件页面的助手。
 *
 * 插件自带的页面**同一份**要能在两个地方跑：
 *
 * - 独立窗口里（壳的 iframe）：能力在壳上 → `parent.plugin`；
 * - 面板工作台里（面板的 iframe）：能力在面板上 → `parent.panel.surface`；
 * - 小部件里（页面被原样加载）：preload 就在自己身上 → `window.plugin`。
 *
 * 插件页面分不出自己身处哪种情况，也**不该**分——所以这里统一认一次，
 * 插件只管 `import { bindSurface } from '/src/renderer/ui/pluginPage.js'`。
 *
 * 同源假设：iframe 与父页面都是 `app://bundle`，所以能直接读父页面的全局对象。
 */

/** 从查询参数里读插件自己的 id。 */
function readPluginId() {
  try {
    return new URLSearchParams(location.search).get('plugin') || '';
  } catch {
    return '';
  }
}

/**
 * 找到「能用的那条通道」。
 *
 * 顺序有讲究：先看自己身上（顶层被直接加载的情况），
 * 再看父页面上的插件壳，最后看面板。
 */
function findApi() {
  if (typeof window.plugin?.data === 'function') return window.plugin;
  const parent = window.parent;
  if (parent && parent !== window && typeof parent.plugin?.data === 'function') {
    return parent.plugin;
  }
  if (parent && parent !== window && typeof parent.panel?.surface?.data === 'function') {
    return parent.panel.surface;
  }
  return null;
}

/** 把消息发给父页面（状态、内容高度）。 */
function postToParent(type, payload) {
  const parent = window.parent;
  if (!parent || parent === window) return;
  parent.postMessage({ type, pluginId: readPluginId(), ...payload }, '*');
}

/**
 * 绑上界面。
 *
 * @returns {object} 一套统一的界面 API；通道找不到时各项都是空操作。
 */
export function bindSurface() {
  const api = findApi();
  const id = readPluginId();

  return {
    id,
    mode: api?.mode || 'window',

    /** 打开时的第一份数据。 */
    data: () => (api ? api.data() : Promise.resolve(null)),

    /** 首份数据到了（宿主推过来的）。 */
    onData(cb) {
      api?.onData?.((payload) => {
        const item = unwrap(payload);
        if (!item.mine) return;
        cb(item.data);
      });
    },

    /** 周期数据到了。 */
    onTick(cb) {
      api?.onTick?.((payload) => {
        const item = unwrap(payload);
        if (!item.mine) return;
        cb(item.data);
      });
    },

    /** 自带页面里的一个动作。 */
    act: (actionId, payload) => (api ? api.act(actionId, payload) : Promise.resolve(null)),

    /** 声明式页面里的一个动作（老插件的积木页走这条）。 */
    action: (actionId, value) => (api ? api.action(actionId, value) : Promise.resolve(null)),

    /** 底部那行字。 */
    setStatus(text) {
      postToParent('desk-pet:surface:status', { text: String(text ?? '') });
    },

    /**
     * 报告内容高度。
     *
     * **只对面板有意义**：面板窗口的高度是内容撑开的。
     * 独立窗口的高度是用户拖出来的，插件说了也没用。
     */
    setHeight(px) {
      postToParent('desk-pet:surface:height', { height: Number(px) || 0 });
    },
  };

  /** 推来的数据是不是发给自己的（面板可能在两个插件之间来回切）。 */
  function isMine(payload) {
    if (!payload || typeof payload !== 'object') return true;
    if (!payload.pluginId || !id) return true;
    return payload.pluginId === id;
  }

  /**
   * 拆包：宿主推来的东西统一是 `{ pluginId, data }`。
   *
   * 拆出 `data` 给回调，顺带按 pluginId 过滤——
   * 面板可能在两个插件之间来回切，推迟了的数据不能串到别的插件那里。
   */
  function unwrap(payload) {
    const mine = isMine(payload);
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return { mine, data: payload.data };
    }
    return { mine, data: payload };
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/renderer/ui/pluginPage.js
git commit -m "feat(插件): 插件页面助手——一份页面两处都能用"
```

---

## Task 6: 独立窗口改成「壳 + iframe」

**Files:**
- Modify: `src/main/plugins/window.js`（`pageUrl()`）
- Modify: `src/renderer/plugin-window/index.html`
- Modify: `src/renderer/plugin-window/main.js`
- Test: `test/e2e/plugin-surface.spec.js`

**Interfaces:**
- Consumes: `host.baseUrl(pluginId)`、`host.spec(pluginId, mode)`。
- Produces: 壳的 URL 多了 `src` 参数（插件页面的完整 URL）；壳的 `<body>` 里多了一个 `#plugin-frame`。

- [ ] **Step 1: 写端到端测试（先失败）**

新建 `test/e2e/plugin-surface.spec.js`：

```js
// 插件界面（surface）的端到端验证。
//
// 覆盖三件事：
//   1. **每个插件**都能在新窗口打开（清单里没写 window 段也算）；
//   2. 插件自带的页面在面板工作台与独立窗口里是**同一份**；
//   3. 用户自己装的插件（userData 里的）也走同一条路。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-surface');

/** 启动应用（E2E 模式：不抢单实例锁，用临时 userData）。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes(part)) return win;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel?.());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes('/renderer/panel/index.html')) {
          await win.waitForLoadState('domcontentloaded');
          return win;
        }
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('面板没有出现');
}

/**
 * 摆一个「带自定义页面」的用户插件。
 *
 * 摆在 userData/plugins/ 下——用户自己的插件就放那儿（README「插件系统」）。
 * 它同时验证了两件事：用户插件的前缀（/__plugins__/）对不对，
 * 以及自定义页面在两处是不是同一份。
 */
async function makeUserPluginWithPage() {
  const dir = join(USER_DATA, 'plugins', 'e2e-page');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'e2e-page',
        name: '测试页面',
        icon: '🧪',
        description: '端到端测试用的插件',
        keywords: ['测试', 'ce shi', 'test', 'e2e-page'],
        entry: 'main.js',
        window: { page: 'page.html', title: '测试页面', width: 420, height: 360 },
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(
    join(dir, 'main.js'),
    `export default function createPlugin() {
  return {
    page() {
      return { pluginId: 'e2e-page', title: '测试页面', blocks: [] };
    },
    async act(ctx, actionId, payload) {
      if (actionId === 'ping') return { pong: payload?.from || '' };
      return null;
    },
  };
}
`,
    'utf8'
  );
  await writeFile(
    join(dir, 'page.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>测试页面</title></head>
  <body>
    <div id="marker">自定义页面</div>
    <button id="send" type="button">发个动作</button>
    <div id="received"></div>
    <script type="module">
      import { bindSurface } from '/src/renderer/ui/pluginPage.js';
      const surface = bindSurface();
      document.getElementById('send').addEventListener('click', async () => {
        const result = await surface.act('ping', { from: 'e2e' });
        document.getElementById('received').textContent = String(result?.pong || '');
      });
    </script>
  </body>
</html>
`,
    'utf8'
  );
}

test.describe('插件界面（surface）', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test('每个插件都有「在新窗口打开」：清单里没写 window 段也行', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      // 录屏的清单里没写 window 段——它以前连 ↗ 按钮都没有。
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
      await expect(panel.locator('#detach')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('插件自带的页面：面板工作台与独立窗口是同一份', async () => {
    await makeUserPluginWithPage();
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'e2e-page');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('e2e-page'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("测试页面")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'e2e-page', null, {
        timeout: 10000,
      });

      // 面板工作台里装的是插件自己的页面。
      const frame = panel.frameLocator('#plugin-frame');
      await expect(frame.locator('#marker')).toHaveText('自定义页面');

      // 独立窗口里装的是**同一份**页面。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');
      const winFrame = pluginWin.frameLocator('#plugin-frame');
      await expect(winFrame.locator('#marker')).toHaveText('自定义页面');

      // 用户插件的页面走的是 /__plugins__/ 前缀，不是 /plugins/。
      const src = await pluginWin.evaluate(() => {
        const el = document.querySelector('#plugin-frame');
        return el?.getAttribute('src') || '';
      });
      expect(src).toContain('/__plugins__/e2e-page/page.html');

      // 插件页面用助手把动作送到插件：iframe → 父页面 → IPC → 插件 → 回来。
      await frame.locator('#send').click();
      await expect(frame.locator('#received')).toHaveText('e2e');
    } finally {
      await app.close();
    }
  });

  test('插件自带的页面加载失败：独立窗口退回积木界面，不能白屏', async () => {
    const dir = join(USER_DATA, 'plugins', 'e2e-broken');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'e2e-broken',
        name: '坏页面',
        icon: '💥',
        description: '页面路径写错了',
        keywords: ['坏页面', 'huai', 'broken'],
        entry: 'main.js',
        window: { page: 'not-there.html', title: '坏页面', width: 380, height: 300 },
      }),
      'utf8'
    );
    await writeFile(
      join(dir, 'main.js'),
      `export default function createPlugin() {
  return {
    page() {
      return {
        pluginId: 'e2e-broken',
        title: '坏页面',
        blocks: [{ kind: 'text', text: '积木界面还在' }],
      };
    },
  };
}
`,
      'utf8'
    );

    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'huai');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('e2e-broken'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("坏页面")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'e2e-broken', null, {
        timeout: 10000,
      });

      // 页面路径写错了 → 独立窗口里不该白屏，要退回积木界面。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');
      await expect(pluginWin.locator('#body')).toContainText('积木界面还在');
      // 壳里不该有 iframe（页面不存在，装了也是白屏）。
      await expect(pluginWin.locator('#plugin-frame')).toBeHidden();
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npx playwright test test/e2e/plugin-surface.spec.js
```

Expected: 至少两条 FAIL —— 录屏的面板里 `#detach` 不可见（`canDetach` 还是老的逻辑），
`#plugin-frame` 不存在（壳还没改成 iframe）。

- [ ] **Step 3: `pageUrl()` 改成「壳 + src 参数」**

`src/main/plugins/window.js` 的 `pageUrl()` 换成：

```js
  /**
   * 插件界面的 URL。
   *
   * **独立窗口永远是壳**：壳里再装插件自己的页面（如果有）。
   * 这样面板工作台与独立窗口结构完全相同，只有容器宽度不同——
   * 同一份页面两处用，界面天然是一套。
   *
   * **小部件这一轮不动**：插件的页面原样加载（带 preload），
   * 壳不参与（见 spec §5.2）。
   */
  function pageUrl(pluginId, mode) {
    const record = host.get(pluginId);
    if (!record) return null;
    const spec = host.spec(pluginId, mode);
    const query = new URLSearchParams({ plugin: pluginId, mode });
    // 页面**不存在**时 host.pageUrl() 给空串 → 壳里画积木，不开白窗口。
    const pluginPage = host.pageUrl?.(pluginId) || '';
    if (mode === PLUGIN_WINDOW_MODE.WIDGET && pluginPage) {
      // 小部件：插件的页面原样加载（带 preload）。
      return appUrl(`${host.baseUrl(pluginId)}/${spec.page}?${query}`);
    }
    if (pluginPage) query.set('src', pluginPage);
    return appUrl(`/src/renderer/plugin-window/index.html?${query}`);
  }
```

**注意**：`URLSearchParams` 拼出来的查询串是 `plugin=x&mode=window`，
`appUrl()` 拼在后面没问题。

- [ ] **Step 4: 壳的 HTML 加 iframe**

`src/renderer/plugin-window/index.html` 的 `<body>` 里，把

```html
    <div id="body"></div>
```

改成

```html
    <div id="body"></div>
    <!-- 插件自带的页面装在这里（src 由主进程通过查询参数给）。 -->
    <iframe id="plugin-frame" hidden></iframe>
```

并在 `<style>` 里加：

```css
    /* 装了插件自己的页面时，iframe 铺满内容区。 */
    #win[data-content="page"] #body { display: none; }
    #plugin-frame {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      border: none;
      background: transparent;
    }
    #plugin-frame[hidden] { display: none; }
```

- [ ] **Step 5: 壳的 main.js 装 iframe**

`src/renderer/plugin-window/main.js` 顶部加：

```js
const frameEl = document.getElementById('plugin-frame');
```

把 `render()` 改成：

```js
  /**
   * 画插件的页面。
   *
   * 插件自带的页面已经装在 iframe 里了（主进程给的 `src`），
   * 这时候壳只管标题栏，**不要**再画一遍积木——画两遍内容就重了。
   */
  function render(payload) {
    const page = payload?.data;
    if (!page) return;
    titleEl.textContent = page.title || '';
    subtitleEl.textContent = page.subtitle || '';
    statusEl.textContent = page.status || '';
    if (frameEl.src) return; // 插件自带页面：内容在 iframe 里
    renderPage(page, {
      body: bodyEl,
      onAction: (actionId, value) => {
        window.plugin?.action?.(actionId, value);
      },
    });
  }
```

**注意**：宿主推来的东西统一包成 `{ pluginId, data }`，壳这里拆包。

在文件末尾（`window.plugin?.reportReady?.()` 之前）加：

```js
// 插件自带的页面：主进程把它的完整 URL 放在 `src` 查询参数里。
//
// 装进 iframe 而不是直接加载：这样**壳**（标题栏、置顶、关闭）是宿主的，
// 面板工作台那边也是「壳 + iframe」——两处结构一样，界面才是一套。
const src = new URLSearchParams(location.search).get('src') || '';
if (src) {
  frameEl.src = src;
  frameEl.hidden = false;
  winEl.dataset.content = 'page';
}
```

- [ ] **Step 6: 页面的 src 参数要在 iframe 里带上插件 id**

Step 3 里 `pluginPage` 已经带了 `?plugin=<id>` ✓（`pluginPage.js` 的 `readPluginId()` 靠它）。

- [ ] **Step 7: 跑测试**

```bash
npx playwright test test/e2e/plugin-surface.spec.js
```

Expected: 前两条 PASS；第三条（页面加载失败退回积木）**仍然 FAIL**——
面板工作台还没实现 iframe（那是 Task 7）。

- [ ] **Step 8: 提交**

```bash
git add src/main/plugins/window.js src/renderer/plugin-window/index.html src/renderer/plugin-window/main.js test/e2e/plugin-surface.spec.js
git commit -m "feat(插件): 独立窗口改成「壳 + iframe」，插件页面两处共用"
```

---

## Task 7: 面板工作台也能装插件自带的页面

**Files:**
- Modify: `src/main/plugins/host.js`（`toMeta()` 加 `hasPage` / `pageUrl`）
- Modify: `src/preload/panel.cjs`
- Modify: `src/main/panel.js`
- Modify: `src/renderer/panel/index.html`
- Modify: `src/renderer/panel/main.js`
- Test: `test/e2e/plugin-surface.spec.js`（Task 6 建好的那个文件）

**Interfaces:**
- Consumes: `src/renderer/ui/pluginPage.js`（Task 5）、`surface.js`（Task 3）。
- Produces:
  - 插件元数据多两个字段：`hasPage: boolean`、`pageUrl: string`（自带页面时是完整 URL，否则空串）。
  - 面板 preload 多一个 `window.panel.surface` 与 `window.panel.setCurrentPlugin(id)`。
  - 主进程多四个 IPC：`panel:surface:data`、`panel:surface:tick`、`panel:surface:act`、`panel:surface:action`。

- [ ] **Step 1: `toMeta()` 带上页面信息**

`src/main/plugins/host.js` 顶部的 import 加上协议：

```js
import { appUrl } from '../protocol.js';
```

`toMeta()` 里，在 `hasWidget: hasWidget(m),` 后面加：

```js
      // 插件自带页面时：面板工作台与独立窗口装的是**同一份**。
      // 页面**不存在**时 pageUrl 是空串 → 面板退回积木界面，不开白窗口。
      hasPage: Boolean(m.window?.page),
      pageUrl: pageUrl(m.id),
```

**并且**把 `host.js` 的 `open()` 改成：插件自带页面时**只问标题那几个字段**。

```js
  async function open(id, update) {
    const record = records.get(id);
    if (!record || !isEnabled(id)) return null;
    const ctx = makeContext(record, update);
    try {
      const instance = record.instance;
      // 插件自带页面时，宿主只要标题那几个字段——
      // 让插件写一份**便宜**的 meta()，别在这儿把整个界面重算一遍
      // （有的插件的 page() 要列系统窗口，那一下要几百毫秒）。
      if (record.manifest.window?.page && typeof instance.meta === 'function') {
        const meta = (await instance.meta(ctx)) || {};
        return {
          pluginId: record.manifest.id,
          title: String(meta.title || ''),
          subtitle: String(meta.subtitle || ''),
          status: String(meta.status || ''),
          blocks: [],
        };
      }
      const page = await instance.page?.(ctx);
      return page || null;
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」打开失败：`, err?.message);
      return null;
    }
  }
```

**约定**：插件写了 `meta(ctx)`，宿主就只调它；不写就照旧调 `page(ctx)`。

- [ ] **Step 2: 面板 preload 暴露 surface**

`src/preload/panel.cjs` 里，先在 `contextBridge.exposeInMainWorld('panel', {` **之前**加一个变量：

```js
/** 面板当前打开的是哪个插件（surface 的 IPC 要带着它）。 */
let currentPluginId = '';
```

然后在 `exposeInMainWorld` 的对象里，`action:` 那一行后面加：

```js
  // 面板当前打开的是哪个插件：surface 的请求要带着它，
  // 宿主才知道该把数据送给谁。
  setCurrentPlugin: (pluginId) => {
    currentPluginId = String(pluginId || '');
  },
  // 插件自带页面用的通道（面板工作台里的 iframe 走这条）。
  //
  // 与插件壳上的 window.plugin **同名同形**：
  // 插件页面不该知道自己身处面板还是独立窗口（见 src/renderer/ui/pluginPage.js）。
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
    action: (actionId, value) =>
      ipcRenderer.send('panel:surface:action', { pluginId: currentPluginId, actionId, value }),
  },
```

**注意**：`onData` / `onTick` 推的是 `{ pluginId, data }`，
插件页面助手 `pluginPage.js` 会按 `pluginId` 过滤（面板可能在两个插件之间切）。

- [ ] **Step 3: 主进程接上 surface**

`src/main/panel.js`：

顶部 import 加上：

```js
import { PLUGIN_WINDOW_MODE } from '../shared/plugin.js';
```

在 `createPanelController({...})` 的参数里加 `surfaces`（界面路由控制器），
并在函数体里加一个 `panelSurface`：

```js
  /**
   * 面板工作台这个 surface。
   *
   * 它把数据送给面板的渲染层；面板渲染层再送进 iframe 里的插件页面。
   */
  const panelSurface = {
    kind: 'panel',
    deliver(kind, payload) {
      send(`panel:surface:${kind}`, payload);
    },
  };
```

在 `openPlugin()` 里，把 `currentPluginId = pluginId;` 换成：

```js
    attachPanelSurface(pluginId);
```

在 `handleAction()` 里，把 `currentPluginId = pluginId;` 同样换成：

```js
    attachPanelSurface(pluginId);
```

并加上这个函数（放在 `panelSurface` 定义之后）：

```js
  /**
   * 面板工作台这个界面落点换插件：先摘掉旧的，再挂上新的。
   *
   * 不摘旧的，**上一个插件的 tick 会一直推**——面板里明明在看 A，
   * A 的定时器却还在跑，白烧 CPU。
   */
  function attachPanelSurface(pluginId) {
    if (currentPluginId && currentPluginId !== pluginId) {
      surfaces?.detach(currentPluginId, panelSurface);
    }
    currentPluginId = pluginId;
    if (pluginId) surfaces?.attach(pluginId, panelSurface);
  }
```

在 `hide()` 里，把

```js
  function hide() {
    if (!win || win.isDestroyed()) return;
    currentPluginId = null;
    win.hide();
  }
```

换成

```js
  function hide() {
    if (!win || win.isDestroyed()) return;
    // 面板收起来了：它这个界面落点就不该再收数据。
    // 不摘的话，插件的 tick 定时器会一直跑到窗口销毁为止。
    if (currentPluginId) surfaces?.detach(currentPluginId, panelSurface);
    currentPluginId = null;
    win.hide();
  }
```

**注意**：`hide()` 里的 `if (!win || win.isDestroyed()) return;` 会**提前返回**，
那种情况下 surface 摘不掉。把摘的动作挪到窗口销毁的处理里（下一步）。

在窗口 `closed` 的处理里（`win = null; ready = false; pendingView = null; currentPluginId = null;`
那一段）补上：

```js
      // 窗口没了：这个界面落点也不能留着——tick 会一直推。
      if (currentPluginId) surfaces?.detach(currentPluginId, panelSurface);
```

并把那句 `currentPluginId = null;` 保留在 detach **之后**。

文件末尾的 IPC 注册处，加四个通道：

```js
  // 插件自带页面的数据：面板工作台里的 iframe 要的那一份。
  ipcMain.handle('panel:surface:data', async (event, payload) => {
    if (!win || event.sender !== win.webContents) return null;
    const pluginId = String(payload?.pluginId || '');
    if (!pluginId) return null;
    const data = await plugins.data(pluginId);
    return { pluginId, data };
  });

  ipcMain.handle('panel:surface:act', async (event, payload) => {
    if (!win || event.sender !== win.webContents) return null;
    const pluginId = String(payload?.pluginId || '');
    if (!pluginId) return null;
    const result = await plugins.act(pluginId, String(payload?.actionId || ''), payload?.payload);
    return { pluginId, result };
  });

  ipcMain.on('panel:surface:action', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    const pluginId = String(payload?.pluginId || '');
    if (!pluginId) return;
    plugins.action(pluginId, String(payload?.actionId || ''), payload?.value).catch((err) => {
      console.warn('[desk-pet] 插件动作失败：', err?.message || err);
    });
  });
```

**关于 tick**：周期数据由 `surface.js` 的定时器推，控制器调
`surface.deliver('tick', payload)` → 这里发的是 `panel:surface:tick`。
`surface.js` 的 `broadcast()` 已经把数据统一包成 `{ pluginId, data }`（Task 3 就这么做），
所以面板这边**不拆包**，原样发过去：

```js
  const panelSurface = {
    kind: 'panel',
    deliver(kind, payload) {
      send(`panel:surface:${kind}`, payload);
    },
  };
```

**首份数据**（`window.js` 的 `onReady()`）也要走 `broadcast`，
这样面板与独立窗口拿到的是同一份：

```js
      const data = await host.data(pluginId);
      surfaces?.broadcast(pluginId, 'data', data);
```

（`broadcast` 自己会包成 `{ pluginId, data }` ✓）

- [ ] **Step 4: 面板 HTML 加 iframe**

`src/renderer/panel/index.html` 的插件视图那块（`#plugin-body` 附近）加：

```html
      <!-- 插件自带的页面装在这里（src 由插件清单里的 page 决定）。 -->
      <iframe id="plugin-frame" hidden></iframe>
```

并在 `<style>` 里加：

```css
    /* 插件自带页面时，积木区让位给 iframe。 */
    #plugin-frame {
      width: 100%;
      border: none;
      background: transparent;
      display: block;
    }
    #plugin-frame[hidden] { display: none; }
```

- [ ] **Step 5: 面板渲染层按需装 iframe**

`src/renderer/panel/main.js`：

顶部加：

```js
const pluginFrameEl = document.getElementById('plugin-frame');
```

把 `renderPlugin(page)` 改成：

```js
/** 画插件界面。 */
function renderPlugin(page) {
  currentPluginId = page?.pluginId || '';
  pluginTitleEl.textContent = page?.title || '';
  pluginSubtitleEl.textContent = page?.subtitle || '';
  pluginStatusEl.textContent = page?.status || '';

  const meta = plugins.find((p) => p.id === currentPluginId);

  if (meta?.hasPage && meta.pageUrl) {
    // 插件自带页面：装进 iframe，宿主不再画积木。
    // 独立窗口那边也是「壳 + iframe」——两处结构一样，界面才是一套。
    pluginBodyEl.hidden = true;
    pluginFrameEl.hidden = false;
    if (pluginFrameEl.getAttribute('src') !== meta.pageUrl) {
      pluginFrameEl.setAttribute('src', meta.pageUrl);
    }
    // 面板的 surface 请求要带着插件 id（宿主才知道该把数据送给谁）。
    window.panel?.setCurrentPlugin?.(currentPluginId);
  } else {
    pluginFrameEl.hidden = true;
    pluginFrameEl.removeAttribute('src');
    pluginBodyEl.hidden = false;
    window.panel?.setCurrentPlugin?.('');

    // 块怎么画是共用的一份（src/renderer/ui/blocks.js）：
    // 面板与插件的独立窗口必须长得一模一样。
    renderPage(page, {
      body: pluginBodyEl,
      onAction: (actionId, value) => {
        window.panel?.action?.(currentPluginId, actionId, value);
      },
    });
  }

  // 「分离出去」的两个按钮。
  detachEl.hidden = !meta?.canDetach;
  widgetEl.hidden = !meta?.hasWidget;

  searchEl.hidden = true;
  pluginEl.hidden = false;
  panelEl.dataset.view = PANEL_VIEW.PLUGIN;
  window.__panel.view = PANEL_VIEW.PLUGIN;
  window.__panel.pluginId = currentPluginId;
  reportHeight();
}
```

在 `renderSearch()` 里加（回到搜索视图要把 iframe 收掉）：

```js
  pluginFrameEl.hidden = true;
  pluginFrameEl.removeAttribute('src');
  pluginBodyEl.hidden = false;
  window.panel?.setCurrentPlugin?.('');
```

**接收插件页面发来的消息**（状态与高度）。在文件末尾加：

```js
// 插件自带页面（在 iframe 里）发来的消息：底部那行字与内容高度。
//
// 用 `event.source` 认人：别的窗口也能往这里 postMessage，
// 只有自己那个 iframe 说的才算数。
window.addEventListener('message', (event) => {
  if (!pluginFrameEl.contentWindow || event.source !== pluginFrameEl.contentWindow) return;
  const data = event.data || {};
  if (data.type === 'desk-pet:surface:status') {
    pluginStatusEl.textContent = String(data.text || '');
    return;
  }
  if (data.type === 'desk-pet:surface:height') {
    const h = Math.min(640, Math.max(0, Number(data.height) || 0));
    if (h > 0) pluginFrameEl.style.height = `${h}px`;
    reportHeight();
  }
});
```

- [ ] **Step 6: 把 surface 控制器接到面板控制器上**

`src/main/index.js` 里，`pluginWindows = createPluginWindowController({...})` 之后加：

```js
    // 界面路由：面板工作台与独立窗口都是「界面落点」。
    pluginSurfaces = createSurfaceController({ host: plugins });
```

并在文件顶部 import：

```js
import { createSurfaceController } from './plugins/surface.js';
```

（`pluginSurfaces` 变量的声明要放在其它 `let` 一起的地方。）

然后把 `createPanelController({...})` 的参数里加上 `surfaces: pluginSurfaces`。

**顺序**：surface 控制器要先建好（它要 `host.spec`），再传给面板控制器与窗口控制器。

- [ ] **Step 7: 加一条端到端测试：面板里页面加载失败也退回积木**

在 `test/e2e/plugin-surface.spec.js` 里追加一条（与 Task 6 那条对称——
那条测的是独立窗口，这条测的是面板工作台）：

```js
  test('插件自带的页面加载失败：面板工作台也退回积木界面', async () => {
    const dir = join(USER_DATA, 'plugins', 'e2e-broken2');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'e2e-broken2',
        name: '坏页面二',
        icon: '💥',
        description: '页面路径写错了',
        keywords: ['坏页面二', 'huai', 'broken2'],
        entry: 'main.js',
        window: { page: 'nope.html', title: '坏页面二', width: 380, height: 300 },
      }),
      'utf8'
    );
    await writeFile(
      join(dir, 'main.js'),
      `export default function createPlugin() {
  return {
    page() {
      return {
        pluginId: 'e2e-broken2',
        title: '坏页面二',
        blocks: [{ kind: 'text', text: '积木界面还在' }],
      };
    },
  };
}
`,
      'utf8'
    );

    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'broken2');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('e2e-broken2'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("坏页面二")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'e2e-broken2', null, {
        timeout: 10000,
      });
      // 页面不存在 → 面板退回积木，积木里的文字要看得见。
      await expect(panel.locator('#plugin-body')).toContainText('积木界面还在');
      // 而且不该装 iframe（装了也是白屏）。
      await expect(panel.locator('#plugin-frame')).toBeHidden();
    } finally {
      await app.close();
    }
  });
```

- [ ] **Step 8: 跑端到端测试**

```bash
npx playwright test test/e2e/plugin-surface.spec.js
```

Expected: 三条全 PASS。

- [ ] **Step 9: 跑全部端到端测试，确认没弄坏别的**

```bash
npm run test:e2e
```

Expected: 全部通过。特别看 `panel.spec.js` 里「插件能分离成独立窗口」那条——
它断言独立窗口的 `#body .block-input input` 可见（待办插件没有自定义页面，
走积木路径，应该照旧）。

- [ ] **Step 10: 提交**

```bash
git add src/main/plugins/host.js src/preload/panel.cjs src/main/panel.js src/main/index.js src/renderer/panel/index.html src/renderer/panel/main.js src/main/plugins/surface.js src/main/plugins/window.js test/unit/plugin-surface.test.js test/e2e/plugin-surface.spec.js
git commit -m "feat(插件): 面板工作台也能装插件自带的页面"
```

---

## Task 8: 文档——README 的插件系统一节

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 无。
- Produces: 无。

- [ ] **Step 1: 改「清单（plugin.json）」一节**

README 里这段：

```
- 写了 `window` 段，面板上才有「在新窗口打开」按钮；写了 `widget` 段才有「变成小部件」；
```

改成：

```
- **「在新窗口打开」每个插件都有**：清单里没写 `window` 段，宿主会合成一份默认的
  （标题=插件名，360×420）。写了 `window` 段就以清单为准（尺寸、页面、刷新间隔）。
- 写了 `widget` 段才有「变成桌面小部件」——小部件要占着桌面，由插件自己决定要不要。
```

- [ ] **Step 2: 改「独立窗口与桌面小部件」一节**

README 里这两句：

```
插件界面默认待在面板里。清单里写了 `window` 段之后，面板上会出现 **↗**
（在新窗口打开）；写了 `widget` 段还会多一个 **▣**（变成桌面小部件）。
```

改成：

```
插件界面默认待在面板里。面板上永远有 **↗**（在新窗口打开）；
清单里写了 `widget` 段还会多一个 **▣**（变成桌面小部件）。
```

并在这一节末尾补一段：

```
### 插件自带的页面

清单里的 `window.page` 是插件**自己的**页面（一个 HTML 文件）：

- 面板工作台里，宿主把它装进一个 `<iframe>`；
- 独立窗口里，宿主也把它装进一个 `<iframe>`（窗口的标题栏是宿主的）。

**同一份页面两处用**，所以界面天然是一套。窄的时候（面板工作台）与
宽的时候（独立窗口，用户能拉宽）怎么排，由页面自己决定——
宿主给内容区套了一层容器，页面用 CSS 容器查询来适配：

```css
.surface { container-type: inline-size; container-name: surface; }

@container surface (min-width: 520px) {
  .targets { display: grid; grid-template-columns: 1fr 1fr; }
}
```

页面里的脚本用一份助手（两处通用，它自己认得出身处面板还是独立窗口）：

```js
import { bindSurface } from '/src/renderer/ui/pluginPage.js';

const surface = bindSurface();
surface.onTick((data) => render(data));
surface.act('start');
```

页面加载不出来时（路径写错了），宿主会**退回积木界面**——插件照样能用。
```

- [ ] **Step 3: 改「插件能拿到什么」一节的表格**

README 里 `ctx` 表格加一行：

```
| `meta` | 界面的标题/副标题/状态（插件自带页面时，宿主只取这三个） |
```

**注意**：这一行说的是**插件实例的方法**，不是 `ctx` 里的东西——
放到「插件能拿到什么」下面那段 `export default function` 的示例里，
在 `page,` 那行后面加：

```js
    meta(ctx) { return { title: '录屏', subtitle: '', status: '' }; }, // 可选
```

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs(插件): 新窗口是所有插件都有的能力，插件页面两处共用"
```

---

## 收尾

- [ ] **Step 1: 跑全部测试**

```bash
npm run test:unit && npm run test:e2e
```

Expected: 全部通过。

- [ ] **Step 2: 确认工作区干净**

```bash
git status --short
```

Expected: 无输出（除了 `.tmp-e2e-*` 这类被 gitignore 的临时目录）。

- [ ] **Step 3: 提交收尾（如果有改动）**

```bash
git add -A && git commit -m "chore: 第一期收尾"
```

**下一期**：`docs/superpowers/plans/2026-11-05-screen-recorder-redesign.md`
——录屏插件的界面重做与性能优化。
