# Live2D 桌面宠物 第六部分「系统与工程化」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上 `idea.md` 第六部分的五项——开机自启、全局快捷键、鼠标穿透、边缘吸附/贴边停靠、设置面板的总音量。

**Architecture:** 新增一个 `src/main/system.js` 控制器统管四个系统级开关（生命周期：落盘 → 启动恢复 → 变更生效），新增一个 `src/main/edgeDock.js` 纯几何模块承载吸附与停靠的坐标计算（可脱离 Electron 单测）。主进程仍是唯一的状态来源：六个新字段进 `settings.json`，音量进 `assistant.json`。渲染层只负责呈现与播放。

**Tech Stack:** Electron 45（`app.setLoginItemSettings` / `globalShortcut` / `setIgnoreMouseEvents` / `before-input-event`）、Node 20+ ESM、`node:test` 单元测试、Playwright + Electron 端到端。

**Spec:** `docs/superpowers/specs/2026-11-03-live2d-desk-pet-system-design.md`

## Global Constraints

这些约束来自规格文档，**每个任务都隐含地包含它们**：

- **失败必须留痕 + 在界面上说得出来，不许静默。** 终端 `console.warn` / `console.error` 留痕，设置窗口给出对应说明。（规格 §9）
- **主进程是唯一的状态来源。** 渲染层不保存第二份状态。
- **`persist()` 必须过 `sanitizeSettings`。** 越界值不许留在内存里——`persist` 在拖拽的每一帧都会被调用，无变化时不做重复动作。（规格 §8.3）
- **E2E 不得写注册表、不得按全局键。** `DESK_PET_E2E` 为真时自启走替身；全局快捷键只能人工验证。（规格 §3.5、§10.3）
- **`src/main/` 下被单元测试覆盖的文件不得 `import` Electron。** `system.js` 的 Electron 能力全部走依赖注入。（规格 §2.2）
- **只做 Windows。** 项目只做 Windows，不留跨平台分支。
- **配色用暖色家族**：`#fffdf8` / `#d8d2c4` / `#bda87c`，不引入新色。（`decisions.md` #77）
- **规格 §6.2 的吸附条件必须带上「本帧位移朝那条边」。** 少了它窗口会粘在边缘拽不动。
- **规格 §6.8.1：停靠判定用期望位置的净位移，不用窗口实际位移。** 窗口贴边后实际位移恒为 0，表达不了意图。
- **规格 §6.5：从 `docked` 出发的这一趟拖拽不判定停靠。**

## Review Focus

以下五类输入规格暗示了、但没有哪条任务会天然覆盖——它们最可能咬到真实用户。每一条都在下面指定的任务里有对应的测试。

1. **用户按 `Ctrl+Shift+1` 录制快捷键**：Shift 把 `1` 变成了 `!`，若直接用 `input.key` 会得到注册不了的 `Control+Shift+!`。→ Task 5 的「Shift 过的符号要还原成基础键」测试。
2. **用户把桌宠推到边缘后又往回拖**：窗口必须能脱离边缘，粘住不动是最劝退的一种手感。→ Task 2 的「反向位移不吸附」测试 + Task 7 的端到端。
3. **用户关掉「贴边隐藏」而桌宠正停靠着**：桌宠必须立刻回到可见位置，否则开关看起来没生效。→ Task 7 的端到端。
4. **用户拖了音量滑块，桌宠说话却没变小**：语音现在直连 `ac.destination`，绕过了主增益。→ Task 3 的端到端。
5. **用户录制的组合被别的程序占用**：原来的组合必须仍然有效，用户不至于连旧的快捷键也丢掉。→ Task 5 的「注册失败时旧组合保留」测试。

---

## 文件结构

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/main/edgeDock.js` | 纯几何：间隙、吸附、停靠位置、放宽后的夹紧、停靠判定。**不 import Electron。** |
| `src/main/system.js` | 系统级开关的控制器：开机自启、全局快捷键、穿透模式、停靠状态机。**不 import Electron。** |
| `test/unit/edgeDock.test.js` | `edgeDock.js` 的单元测试 |
| `test/unit/system.test.js` | `system.js` 的单元测试（全部外部能力注入替身） |
| `test/e2e/system.spec.js` | 穿透、停靠、重启后仍停靠的端到端 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/main/settings.js` | `DEFAULT_SETTINGS` 加六个字段；`sanitizeSettings` 认这六个字段 |
| `src/main/menuTemplate.js` | 加「鼠标穿透」勾选项与「取回桌宠」 |
| `src/main/index.js` | 接线：创建控制器、`persist()` 后调 `applySettings`、拖拽改走控制器、菜单重建、快捷键录制捕获 |
| `src/main/ipc.js` | 新通道：`pet:getSystemState` / `pet:recordHotkey` / `pet:cancelHotkeyRecording` / `pet:toggleClickThrough` |
| `src/main/assistant/state.js` | `sound` 加 `volume` |
| `src/preload/index.cjs` | 暴露新接口 |
| `src/renderer/pet/audio.js` | `masterGain` 承载总音量；语音改接 `masterGain` |
| `src/renderer/main.js` | 监听 `pet:volume`；诊断面加 `volume` |
| `src/settings/index.html` | 新增「系统」分区；「语音」分区加音量滑块 |
| `src/settings/main.js` | 新控件的读写 |
| `test/unit/settings.test.js` | 六个新字段的 sanitize |
| `test/unit/menuTemplate.test.js` | 新菜单项 |
| `test/e2e/settings.spec.js` | 分区列表加 `system`；音量滑块 |
| `test/e2e/helpers.js` | 加 `petBounds(ctx)` |

---

### Task 1: 设置 schema——六个新字段

**Files:**
- Modify: `src/main/settings.js`
- Test: `test/unit/settings.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `DEFAULT_SETTINGS` 新增 `autoLaunch` / `hotkey` / `clickThrough` / `edgeSnap` / `dockEnabled` / `dock`；`sanitizeSettings(raw)` 认这六个字段。

- [ ] **Step 1: 写失败的测试**

在 `test/unit/settings.test.js` 末尾追加：

```js
test('六个新字段有默认值', () => {
  assert.equal(DEFAULT_SETTINGS.autoLaunch, false);
  assert.equal(DEFAULT_SETTINGS.hotkey, 'Control+Shift+D');
  assert.equal(DEFAULT_SETTINGS.clickThrough, false);
  assert.equal(DEFAULT_SETTINGS.edgeSnap, true);
  assert.equal(DEFAULT_SETTINGS.dockEnabled, false);
  assert.equal(DEFAULT_SETTINGS.dock, null);
});

test('新字段的合法值被保留', () => {
  const s = sanitizeSettings({
    autoLaunch: true,
    hotkey: 'Control+Alt+P',
    clickThrough: true,
    edgeSnap: false,
    dockEnabled: true,
    dock: 'right',
  });
  assert.equal(s.autoLaunch, true);
  assert.equal(s.hotkey, 'Control+Alt+P');
  assert.equal(s.clickThrough, true);
  assert.equal(s.edgeSnap, false);
  assert.equal(s.dockEnabled, true);
  assert.equal(s.dock, 'right');
});

test('新字段的类型不对时回退默认值', () => {
  const s = sanitizeSettings({
    autoLaunch: 'yes',
    clickThrough: 1,
    edgeSnap: 'no',
    dockEnabled: null,
    hotkey: 42,
  });
  assert.equal(s.autoLaunch, false);
  assert.equal(s.clickThrough, false);
  assert.equal(s.edgeSnap, true);
  assert.equal(s.dockEnabled, false);
  assert.equal(s.hotkey, 'Control+Shift+D');
});

test('dock 只认四个合法边名', () => {
  assert.equal(sanitizeSettings({ dock: 'up' }).dock, null);
  assert.equal(sanitizeSettings({ dock: '' }).dock, null);
  assert.equal(sanitizeSettings({ dock: 'top' }).dock, 'top');
  assert.equal(sanitizeSettings({ dock: 'bottom' }).dock, 'bottom');
  assert.equal(sanitizeSettings({ dock: 'left' }).dock, 'left');
});

test('过长的 hotkey 回退默认值而不是截断', () => {
  // 截断出来的加速键串是个语法错误的东西，注册必然失败；
  // 回退默认值至少是「能用的那一组」。
  const s = sanitizeSettings({ hotkey: 'Control+Shift+'.padEnd(200, 'A') });
  assert.equal(s.hotkey, 'Control+Shift+D');
});

test('空的 hotkey 回退默认值', () => {
  assert.equal(sanitizeSettings({ hotkey: '' }).hotkey, 'Control+Shift+D');
  assert.equal(sanitizeSettings({ hotkey: '   ' }).hotkey, 'Control+Shift+D');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/settings.test.js`
Expected: FAIL —— `DEFAULT_SETTINGS.autoLaunch` 是 `undefined`，断言不成立。

- [ ] **Step 3: 实现**

改 `src/main/settings.js` 的 `DEFAULT_SETTINGS`：

```js
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  position: null,
  modelId: 'haru',
  scale: 1.0,
  opacity: 1.0,
  visible: true,
  // —— 系统与工程化（第六部分）——
  // 开机自启默认关：开机就跑一个桌宠是用户没要求的行为。
  autoLaunch: false,
  // 全局快捷键：呼出/隐藏桌宠。
  hotkey: 'Control+Shift+D',
  // 鼠标穿透：窗口不吃点击，桌面照常操作。
  clickThrough: false,
  // 边缘吸附：拖到屏幕边缘附近时自动贴齐。
  edgeSnap: true,
  // 贴边隐藏：贴齐后滑出屏幕只留一条边。
  dockEnabled: false,
  // 当前停靠在哪条边（状态，不是开关）。
  dock: null,
});
```

在 `sanitizeSettings` 里，`if (typeof raw.visible === 'boolean') out.visible = raw.visible;` 之后加：

```js
  // —— 系统与工程化（第六部分）——
  if (typeof raw.autoLaunch === 'boolean') out.autoLaunch = raw.autoLaunch;
  if (typeof raw.clickThrough === 'boolean') out.clickThrough = raw.clickThrough;
  if (typeof raw.edgeSnap === 'boolean') out.edgeSnap = raw.edgeSnap;
  if (typeof raw.dockEnabled === 'boolean') out.dockEnabled = raw.dockEnabled;
  // hotkey：非空字符串且长度 ≤ 64。太长**回退默认值**而不是截断——
  // 截断出来的加速键串是个语法错误的东西，注册必然失败。
  if (typeof raw.hotkey === 'string') {
    const trimmed = raw.hotkey.trim();
    if (trimmed !== '' && trimmed.length <= 64) out.hotkey = trimmed;
  }
  // dock：只认四个合法边名，其余一律 null。
  if (['left', 'right', 'top', 'bottom'].includes(raw.dock)) out.dock = raw.dock;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/settings.test.js`
Expected: PASS（原有 9 条 + 新增 6 条全过）。

- [ ] **Step 5: 提交**

```bash
git add src/main/settings.js test/unit/settings.test.js
git commit -m "feat(settings): 增加第六部分的六个系统级字段"
```

---

### Task 2: edgeDock 纯几何模块

**Files:**
- Create: `src/main/edgeDock.js`
- Test: `test/unit/edgeDock.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `DOCK_SLIP = 24` —— 停靠时露在屏幕上的宽度
  - `SNAP_THRESHOLD = 24` —— 吸附阈值
  - `MIN_DOCK_PUSH = 8` —— 停靠判定要求的最小净位移
  - `edgeGaps(x, y, width, height, workArea) → {left,right,top,bottom}`
  - `snapToEdge(x, y, width, height, workArea, delta, threshold?) → {x, y, side}`
  - `dockPosition(side, x, y, width, height, workArea, slip?) → {x, y}`
  - `flushPosition(side, x, y, width, height, workArea) → {x, y}`
  - `dockedRange(side, width, height, workArea, slip?) → {min, max}`
  - `clampDocked(x, y, width, height, workArea, side, slip?) → {x, y}`
  - `isFullyTucked(x, y, width, height, workArea, side, slip?) → boolean`
  - `chooseDockSide(gaps, delta, {minPush}?) → side | null`

- [ ] **Step 1: 写失败的测试**

Create `test/unit/edgeDock.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCK_SLIP,
  SNAP_THRESHOLD,
  MIN_DOCK_PUSH,
  edgeGaps,
  snapToEdge,
  dockPosition,
  flushPosition,
  dockedRange,
  clampDocked,
  isFullyTucked,
  chooseDockSide,
} from '../../src/main/edgeDock.js';

// 一块 1000×800 的工作区，原点在 (0,0)。
const WA = { x: 0, y: 0, width: 1000, height: 800 };
// 一扇 300×560 的窗口。
const W = 300;
const H = 560;

test('间隙：正数是还差多少，负数是越出屏幕多少', () => {
  const g = edgeGaps(100, 50, W, H, WA);
  assert.equal(g.left, 100);
  assert.equal(g.top, 50);
  assert.equal(g.right, 1000 - (100 + W));
  assert.equal(g.bottom, 800 - (50 + H));
});

test('吸附：间隙在阈值内且位移朝那条边 → 贴齐', () => {
  // 距右边 10px，往右推 → 贴到右边缘。
  const x = WA.x + WA.width - W - 10;
  const out = snapToEdge(x, 200, W, H, WA, { dx: 5, dy: 0 });
  assert.equal(out.side, 'right');
  assert.equal(out.x, WA.x + WA.width - W);
  assert.equal(out.y, 200);
});

test('吸附：位移朝反方向时不吸附（窗口能离开边缘）', () => {
  // 这条是「窗口粘在边缘拽不动」的防线：
  // 往左拖时不该再被吸回去。
  const x = WA.x + WA.width - W - 10;
  const out = snapToEdge(x, 200, W, H, WA, { dx: -5, dy: 0 });
  assert.equal(out.side, null);
  assert.equal(out.x, x);
});

test('吸附：间隙超过阈值不吸附', () => {
  const x = WA.x + WA.width - W - (SNAP_THRESHOLD + 1);
  const out = snapToEdge(x, 200, W, H, WA, { dx: 5, dy: 0 });
  assert.equal(out.side, null);
  assert.equal(out.x, x);
});

test('吸附：四条边各自贴齐到正确的位置', () => {
  const nearLeft = WA.x + 5;
  const l = snapToEdge(nearLeft, 200, W, H, WA, { dx: -1, dy: 0 });
  assert.equal(l.side, 'left');
  assert.equal(l.x, WA.x);

  const nearTop = WA.y + 5;
  const t = snapToEdge(200, nearTop, W, H, WA, { dx: 0, dy: -1 });
  assert.equal(t.side, 'top');
  assert.equal(t.y, WA.y);

  const nearBottom = WA.y + WA.height - H - 5;
  const b = snapToEdge(200, nearBottom, W, H, WA, { dx: 0, dy: 1 });
  assert.equal(b.side, 'bottom');
  assert.equal(b.y, WA.y + WA.height - H);
});

test('停靠位置：只露出 DOCK_SLIP 宽', () => {
  const d = dockPosition('right', 100, 200, W, H, WA);
  assert.equal(d.x, WA.x + WA.width - DOCK_SLIP);
  assert.equal(d.y, 200);

  const l = dockPosition('left', 100, 200, W, H, WA);
  assert.equal(l.x, WA.x + DOCK_SLIP - W);

  const t = dockPosition('top', 100, 200, W, H, WA);
  assert.equal(t.y, WA.y + DOCK_SLIP - H);

  const b = dockPosition('bottom', 100, 200, W, H, WA);
  assert.equal(b.y, WA.y + WA.height - DOCK_SLIP);
});

test('完全可见贴齐位与停靠位差 W - DOCK_SLIP', () => {
  const flush = flushPosition('right', 100, 200, W, H, WA);
  const dock = dockPosition('right', 100, 200, W, H, WA);
  assert.equal(flush.x, WA.x + WA.width - W);
  assert.equal(dock.x - flush.x, W - DOCK_SLIP);
});

test('停靠区间：从完全贴齐到完全藏起', () => {
  const r = dockedRange('right', W, H, WA);
  assert.equal(r.min, WA.x + WA.width - W);
  assert.equal(r.max, WA.x + WA.width - DOCK_SLIP);
  assert.ok(r.min < r.max);
});

test('停靠夹紧：沿停靠轴放宽，垂直轴照常', () => {
  // 想往右再推 200px：夹紧后停在「完全藏起」那一端。
  const c = clampDocked(WA.x + WA.width + 200, 100, W, H, WA, 'right');
  assert.equal(c.x, WA.x + WA.width - DOCK_SLIP);
  assert.equal(c.y, 100);

  // 垂直方向仍然被工作区夹住。
  const c2 = clampDocked(100, WA.y + WA.height + 50, W, H, WA, 'right');
  assert.equal(c2.y, WA.y + WA.height - H);
});

test('停靠夹紧：把窗口从藏起处拉回来', () => {
  const c = clampDocked(WA.x + WA.width - DOCK_SLIP - 200, 100, W, H, WA, 'right');
  assert.equal(c.x, WA.x + WA.width - DOCK_SLIP - 200);
});

test('完全藏起判定', () => {
  const dock = dockPosition('right', 100, 200, W, H, WA);
  assert.equal(isFullyTucked(dock.x, dock.y, W, H, WA, 'right'), true);
  const half = dockPosition('right', 100, 200, W, H, WA);
  half.x -= 100;
  assert.equal(isFullyTucked(half.x, half.y, W, H, WA, 'right'), false);
});

test('停靠判定：贴齐 + 朝该边推 → 命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W, 100, W, H, WA);
  assert.equal(gaps.right, 0);
  assert.equal(chooseDockSide(gaps, { dx: 200, dy: 0 }), 'right');
});

test('停靠判定：反方向推不命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W, 100, W, H, WA);
  assert.equal(chooseDockSide(gaps, { dx: -200, dy: 0 }), null);
});

test('停靠判定：位移太小不命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W, 100, W, H, WA);
  assert.equal(chooseDockSide(gaps, { dx: MIN_DOCK_PUSH - 1, dy: 0 }), null);
});

test('停靠判定：没贴齐就不命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W - 30, 100, W, H, WA);
  assert.equal(chooseDockSide(gaps, { dx: 200, dy: 0 }), null);
});

test('停靠判定：两个方向都贴齐时取位移大的那个', () => {
  // 窗口同时贴着右边和下边（默认位置就在右下角）。
  const gaps = edgeGaps(WA.x + WA.width - W, WA.y + WA.height - H, W, H, WA);
  assert.equal(gaps.right, 0);
  assert.equal(gaps.bottom, 0);
  assert.equal(chooseDockSide(gaps, { dx: 10, dy: 300 }), 'bottom');
  assert.equal(chooseDockSide(gaps, { dx: 300, dy: 10 }), 'right');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/edgeDock.test.js`
Expected: FAIL —— `Cannot find module '../../src/main/edgeDock.js'`。

- [ ] **Step 3: 实现**

Create `src/main/edgeDock.js`：

```js
/**
 * 边缘吸附与贴边停靠的几何计算。
 *
 * 全部是纯函数：不碰 Electron，也不碰窗口——只算坐标。
 *
 * 之所以单独拆一个文件：这段几何是最容易算错的部分
 * （四条边 × 吸附/停靠/夹紧三种状态），而纯函数能脱离窗口单测。
 *
 * 这个文件**不得 import Electron**：本仓库的单元测试用 `node --test` 跑，
 * 没有 Electron 环境。
 */

/** 停靠时露在屏幕上的宽度（px）。 */
export const DOCK_SLIP = 24;

/** 吸附阈值：离边缘这么近就磁过去。 */
export const SNAP_THRESHOLD = 24;

/** 停靠判定要求的最小净位移（px）。 */
export const MIN_DOCK_PUSH = 8;

/** 「贴齐」的判定容差：坐标取整后可能有 1px 的浮点误差。 */
const FLUSH_EPSILON = 0.5;

/**
 * 窗口与工作区四条边之间的间隙。
 *
 * 正数 = 还差多少才贴齐；负数 = 已经越出屏幕。
 */
export function edgeGaps(x, y, width, height, workArea) {
  const wa = workArea || { x: 0, y: 0, width: 0, height: 0 };
  return {
    left: x - wa.x,
    right: wa.x + wa.width - (x + width),
    top: y - wa.y,
    bottom: wa.y + wa.height - (y + height),
  };
}

/**
 * 吸附：间隙在阈值以内、**且位移是朝那条边去的** → 间隙归零，窗口贴齐。
 *
 * 「朝那条边去」这条是必须的：没有它，窗口贴上边之后往回拖会被立刻吸回去，
 * 用户会发现「拽不动」。加上它，窗口一离开边缘就自由了。
 *
 * @param {object} delta 本帧的位移 `{dx, dy}`
 * @returns {{x: number, y: number, side: string|null}} side 是被吸附的那条边
 */
export function snapToEdge(
  x,
  y,
  width,
  height,
  workArea,
  delta = { dx: 0, dy: 0 },
  threshold = SNAP_THRESHOLD,
) {
  const gaps = edgeGaps(x, y, width, height, workArea);
  const candidates = [];
  if (gaps.left > 0 && gaps.left <= threshold && delta.dx < 0) {
    candidates.push({ side: 'left', gap: gaps.left });
  }
  if (gaps.right > 0 && gaps.right <= threshold && delta.dx > 0) {
    candidates.push({ side: 'right', gap: gaps.right });
  }
  if (gaps.top > 0 && gaps.top <= threshold && delta.dy < 0) {
    candidates.push({ side: 'top', gap: gaps.top });
  }
  if (gaps.bottom > 0 && gaps.bottom <= threshold && delta.dy > 0) {
    candidates.push({ side: 'bottom', gap: gaps.bottom });
  }
  if (candidates.length === 0) return { x, y, side: null };
  // 间隙最小的优先：它离贴齐最近。
  candidates.sort((a, b) => a.gap - b.gap);
  const side = candidates[0].side;
  const next = { x, y };
  if (side === 'left') next.x = workArea.x;
  else if (side === 'right') next.x = workArea.x + workArea.width - width;
  else if (side === 'top') next.y = workArea.y;
  else next.y = workArea.y + workArea.height - height;
  return { x: next.x, y: next.y, side };
}

/**
 * 停靠位置：沿 side 滑出屏幕，只留 slip 宽可见。
 *
 * 垂直于停靠轴的那个坐标**原样保留**：桌宠停靠在右边时，
 * 它在屏幕上的上下位置不该因为停靠而改变。
 */
export function dockPosition(side, x, y, width, height, workArea, slip = DOCK_SLIP) {
  if (side === 'left') return { x: workArea.x + slip - width, y };
  if (side === 'right') return { x: workArea.x + workArea.width - slip, y };
  if (side === 'top') return { x, y: workArea.y + slip - height };
  if (side === 'bottom') return { x, y: workArea.y + workArea.height - slip };
  return { x, y };
}

/** 完全可见、贴齐那条边的位置（停靠的「反面」）。 */
export function flushPosition(side, x, y, width, height, workArea) {
  if (side === 'left') return { x: workArea.x, y };
  if (side === 'right') return { x: workArea.x + workArea.width - width, y };
  if (side === 'top') return { x, y: workArea.y };
  if (side === 'bottom') return { x, y: workArea.y + workArea.height - height };
  return { x, y };
}

/** 停靠时沿该轴允许的位置区间（含两端）。 */
export function dockedRange(side, width, height, workArea, slip = DOCK_SLIP) {
  if (side === 'left') return { min: workArea.x + slip - width, max: workArea.x };
  if (side === 'right') {
    return { min: workArea.x + workArea.width - width, max: workArea.x + workArea.width - slip };
  }
  if (side === 'top') return { min: workArea.y + slip - height, max: workArea.y };
  return { min: workArea.y + workArea.height - height, max: workArea.y + workArea.height - slip };
}

/**
 * 停靠状态的夹紧：停靠轴放宽到 dockedRange，垂直轴照常。
 *
 * 放宽是必须的：普通的 clampToDisplays 把窗口整个按回工作区内，
 * 停靠根本出不来。
 *
 * **停靠轴要用停靠区间直接夹，不能先按普通区间夹一遍再放宽**——
 * 普通区间是 [wa.left, wa.right - w]，落在它右边的值（比如想往屏幕外推）
 * 会先被夹回 wa.right - w，放宽就再也救不回来了。
 */
export function clampDocked(x, y, width, height, workArea, side, slip = DOCK_SLIP) {
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  const range = dockedRange(side, width, height, workArea, slip);
  let cx;
  let cy;
  if (side === 'left' || side === 'right') {
    cx = Math.min(Math.max(x, range.min), range.max);
    cy = Math.min(Math.max(y, workArea.y), maxY);
  } else {
    cx = Math.min(Math.max(x, workArea.x), maxX);
    cy = Math.min(Math.max(y, range.min), range.max);
  }
  return { x: Math.round(cx), y: Math.round(cy) };
}

/** 窗口是不是还完全藏在那条边后面。 */
export function isFullyTucked(x, y, width, height, workArea, side, slip = DOCK_SLIP) {
  const target = dockPosition(side, x, y, width, height, workArea, slip);
  return (
    Math.abs(target.x - x) < FLUSH_EPSILON && Math.abs(target.y - y) < FLUSH_EPSILON
  );
}

/**
 * 拖拽结束时判定要不要停靠、停靠在哪条边。
 *
 * @param {object} gaps 四个间隙
 * @param {object} delta 本次拖拽的**净位移**（期望位置的净变化）
 * @returns {string|null} 停靠边；不停靠返回 null
 */
export function chooseDockSide(gaps, delta, { minPush = MIN_DOCK_PUSH } = {}) {
  const d = delta || { dx: 0, dy: 0 };
  const candidates = [];
  const flush = (v) => Math.abs(v) < FLUSH_EPSILON;
  if (flush(gaps.right) && d.dx >= minPush) candidates.push({ side: 'right', push: d.dx });
  if (flush(gaps.left) && -d.dx >= minPush) candidates.push({ side: 'left', push: -d.dx });
  if (flush(gaps.bottom) && d.dy >= minPush) candidates.push({ side: 'bottom', push: d.dy });
  if (flush(gaps.top) && -d.dy >= minPush) candidates.push({ side: 'top', push: -d.dy });
  if (candidates.length === 0) return null;
  // 两个方向都贴齐时（默认位置就在右下角），取位移大的那个。
  candidates.sort((a, b) => b.push - a.push);
  return candidates[0].side;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/edgeDock.test.js`
Expected: PASS（15 条全过）。

- [ ] **Step 5: 提交**

```bash
git add src/main/edgeDock.js test/unit/edgeDock.test.js
git commit -m "feat(edge-dock): 边缘吸附与贴边停靠的纯几何计算"
```

---

### Task 3: 总音量——状态、渲染层主增益、广播

**Files:**
- Modify: `src/main/assistant/state.js`
- Modify: `src/renderer/pet/audio.js`
- Modify: `src/renderer/main.js`
- Modify: `src/preload/index.cjs`
- Modify: `src/main/index.js`
- Test: `test/unit/assistant.test.js`（扩充）、`test/e2e/system.spec.js`（新建，本任务先放音量那条）

**Interfaces:**
- Consumes: Task 1 的 `settings.json` 无关（本任务只动 `assistant.json`）
- Produces:
  - `sanitizeAssistant` 认 `sound.volume`（0–1，默认 0.8）
  - `setMasterVolume(value) → number`（渲染层 `src/renderer/pet/audio.js`）
  - `getMasterVolume() → number`
  - preload：`window.pet.onVolume(cb)`
  - 主进程 → 渲染层通道：`pet:volume`，载荷 `{ volume }`
  - 渲染层诊断面：`window.__pet.volume`

- [ ] **Step 1: 写失败的单元测试**

在 `test/unit/assistant.test.js` 末尾追加（先看该文件已有的 import 行，把 `sanitizeAssistant` 加进去）：

```js
test('sound.volume 被夹进 [0,1]，非法值回退 0.8', () => {
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: 0.5 } }).sound.volume, 0.5);
  // 越界**夹紧**（与 scale / opacity / tts.vol 一致），非数值才回退默认。
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: 5 } }).sound.volume, 1);
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: -1 } }).sound.volume, 0);
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: 'x' } }).sound.volume, 0.8);
  assert.equal(sanitizeAssistant({}).sound.volume, 0.8);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/assistant.test.js`
Expected: FAIL —— `sanitizeAssistant({}).sound.volume` 是 `undefined`。

- [ ] **Step 3: 实现状态层**

改 `src/main/assistant/state.js`：

`DEFAULT_ASSISTANT` 里把 `sound: { enabled: true },` 改成：

```js
  // sound.volume 是**总音量**：提示音与桌宠说话共用一个值。
  sound: { enabled: true, volume: 0.8 },
```

`sanitizeAssistant` 里把 `if (isPlainObject(raw.sound)) out.sound = { enabled: Boolean(raw.sound.enabled) };` 改成：

```js
  if (isPlainObject(raw.sound)) {
    out.sound = {
      enabled: Boolean(raw.sound.enabled),
      // 总音量：提示音与语音共用。夹进 [0,1]，非法值回退默认。
      volume: clampNumber(raw.sound.volume, 0, 1, DEFAULT_ASSISTANT.sound.volume),
    };
  }
```

- [ ] **Step 4: 跑单元测试确认通过**

Run: `node --test test/unit/assistant.test.js`
Expected: PASS。

- [ ] **Step 5: 实现渲染层主增益**

改 `src/renderer/pet/audio.js`。把顶部的变量区改成：

```js
let ctx = null;
let enabled = true;
let masterGain = null;
// 总音量：提示音与桌宠说话共用一个值（设置窗口的「音量」滑块）。
let volume = 0.8;
```

把 `audioContext()` 里 `masterGain.gain.value = 0.8;` 改成 `masterGain.gain.value = volume;`。

在 `isAudioEnabled()` 之后加：

```js
/**
 * 设总音量。
 *
 * 提示音与语音都接在 masterGain 上，所以这一个值管住两种声音。
 * 语音原来直连 ac.destination —— 那条路绕过了主增益，
 * 于是「提示音有音量控制、桌宠说话没有」。总音量要成立就得把它接回来。
 */
export function setMasterVolume(value) {
  const n = typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.8;
  volume = n;
  if (masterGain) masterGain.gain.value = n;
  return volume;
}

/** 当前总音量。 */
export function getMasterVolume() {
  return volume;
}
```

把 `playSpeech` 里的 `source.connect(ac.destination);` 改成：

```js
  // 接主增益，不接 destination：不然语音不受总音量控制。
  source.connect(masterGain || ac.destination);
```

- [ ] **Step 6: 实现 preload 与渲染层监听**

`src/preload/index.cjs`，在 `onSoundEnabled` 那段之后加：

```js
  // 总音量：提示音与桌宠说话共用一个值。
  onVolume: (cb) => {
    ipcRenderer.on('pet:volume', (_e, payload) => cb(payload?.volume));
  },
```

`src/renderer/pet/audio.js`：
- 在模块变量区加一行，并导出一个诊断函数：

```js
// 语音实际连到了哪个节点（null = 还没播过）。
let speechTarget = null;
```

```js
/**
 * 语音输出接到了哪个节点：'masterGain' / 'destination' / null（还没播过）。
 *
 * 有了它，「桌宠说话也受音量控制」才有可断言的出口——
 * 否则那只是一行 `source.connect(...)`，改了也没人看得出来。
 */
export function getSpeechOutput() {
  if (!speechTarget) return null;
  return speechTarget === masterGain ? 'masterGain' : 'destination';
}
```

- `playSpeech` 里，`source.connect(masterGain || ac.destination);` 改成：

```js
  // 连什么、记什么必须是同一件事——所以把赋值写在 connect 的参数里。
  //
  // 写成两个平行表达式（connect 一行、诊断一行）的话，将来有人只改了
  // connect 那行，诊断位还报 'masterGain'，那条 e2e 就挡不住它本该挡的回归。
  // 写成这样之后：connect 的参数一旦不是 masterGain，speechTarget 就不会被赋值，
  // 诊断位停在 null，e2e 立刻红。
  source.connect((speechTarget = masterGain || ac.destination));
```

`src/renderer/main.js`：
- import 那行改成：

```js
import {
  playTap,
  playSpeech,
  playSuccess,
  playAlarm,
  playError,
  setAudioEnabled,
  setMasterVolume,
  getMasterVolume,
  getSpeechOutput,
} from './pet/audio.js';
```

- `window.__pet` 里加一行（放在 `speechCount: 0,` 附近）：

```js
  // 当前总音量（0..1）。诊断面：测试要能断言「音量真的传到了渲染层」。
  volume: 0.8,
  // 语音输出接到了哪个节点（'masterGain' / 'destination' / null）。
  // 「桌宠说话也受音量控制」只有这一个可断言的出口。
  speechOutput: null,
```

- `registerChannels()` 里，在 `window.pet.onSoundEnabled?.(...)` 之后加：

```js
  // 总音量：主进程把它推过来。
  window.pet.onVolume?.((v) => {
    if (typeof v !== 'number') return;
    window.__pet.volume = setMasterVolume(v);
  });
```

- `onSpeak` 的处理里，`void playSpeech(bytes, ...)` 改成记下输出节点：

```js
    void playSpeech(bytes, (amplitude) => {
      lipSync?.setAmplitude(amplitude);
      window.__pet.mouthAmplitude = amplitude;
    })
      .then(() => {
        // 播完之后才拿得到：连接是在 decodeAudioData 之后才做的。
        window.__pet.speechOutput = getSpeechOutput();
      })
      .catch((err) => {
        console.warn('[desk-pet] 语音播放失败：', err?.message || err);
      });
```

> 原来的 `void playSpeech(...).catch(...)` 改成 `.then(...).catch(...)`——
> `catch` 仍在最后，链不会断。

- `boot()` 里，`window.__pet.opacity = ...` 那行之后加：

```js
  // 音量：启动时先按默认值摆好，主进程随后会推真值过来。
  window.__pet.volume = getMasterVolume();
```

- [ ] **Step 7: 主进程广播音量**

`src/main/index.js`：

在 `registerIpc({...})` 之前加一个函数：

```js
/**
 * 把总音量推给宠物窗口。
 *
 * 音量作用在渲染层的主增益上，所以主进程只管「把值送过去」。
 */
function pushVolume() {
  if (!win || win.isDestroyed()) return;
  const volume = assistant?.getState()?.sound?.volume;
  if (typeof volume !== 'number') return;
  win.webContents.send('pet:volume', { volume });
}
```

在 `saveAssistantPrefs` 的 IPC 处理里，把音效那段扩成：

```js
    saveAssistantPrefs: (patch) => {
      const next = assistant?.update(patch || {});
      // 音效开关要立刻生效：它作用在渲染层的提示音上。
      if (typeof patch?.sound?.enabled === 'boolean' && win && !win.isDestroyed()) {
        win.webContents.send('pet:soundEnabled', { enabled: patch.sound.enabled });
      }
      // 总音量同理：拖滑块时音量要立刻变，落盘是 300ms 之后的事。
      if (typeof patch?.sound?.volume === 'number') pushVolume();
      return next;
    },
```

在 `onRendererReady()` 里，`pet:soundEnabled` 那段之后加：

```js
  // 音量也一样要在这一刻补发一次：渲染层的监听器在那之前还没注册，
  // 发过去的推送会被丢弃（decisions.md #23 记过这个坑）。
  pushVolume();
```

再在 `app.whenReady()` 里，`await assistant.start();` 之后加：

```js
  // 助理起来之后再补发一次音量。
  //
  // 渲染层可能**比助理更早 ready**（页面一加载就发 rendererReady，
  // 而助理还在 start() 里读磁盘）——那一刻 assistant 还是 undefined，
  // pushVolume 推不出东西，音量就停在渲染层的默认值 0.8 上，
  // 用户设的 0.3 永远传不过去。
  pushVolume();
```

- [ ] **Step 8: 写端到端测试**

Create `test/e2e/system.spec.js`（本任务先只放音量这一条，后面任务往里加）：

```js
import { test, expect } from '@playwright/test';
import { launchApp, collectErrors } from './helpers.js';

test('总音量传到了渲染层', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    await ctx.win.evaluate(async () => {
      await window.pet.saveAssistantPrefs({ sound: { volume: 0.3 } });
    });
    await ctx.win.waitForFunction(() => window.__pet.volume === 0.3, null, { timeout: 10000 });
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
```

再在 `test/e2e/tts.spec.js` 里加一条——**「桌宠说话也受音量控制」只有这一个可断言的出口**
（那个文件已经有桩服务与「语音送到渲染层」的完整写法，**照抄它的 setup**）：

```js
test('桌宠说话接在主增益上，所以它也受总音量控制', async () => {
  const stub = await startStubTts();
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-tts-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });
  // 预置：语音开着，域名指向桩服务，音量调到 0.3。
  await writeFile(
    join(userDataDir, 'assistant.json'),
    JSON.stringify({
      version: 1,
      tts: { enabled: true, voiceId: 'female-shaonv', model: 'speech-02-hd', host: stub.url },
      sound: { enabled: true, volume: 0.3 },
    }),
    'utf8'
  );

  const ctx = await launchWithMenuProbe({
    userDataDir,
    env: {
      MINIMAX_API_KEY: 'sk-test-local-stub',
      DESK_PET_TTS_HOSTS: stub.url,
    },
  });
  try {
    // 音量到了渲染层。
    await ctx.win.waitForFunction(() => window.__pet.volume === 0.3, null, { timeout: 10000 });

    // 语音**接在主增益上**，而不是直接接扬声器——
    // 接错了的话「桌宠说话」这一路就不受音量控制。
    await ctx.win.waitForFunction(
      () => window.__pet.speechOutput === 'masterGain',
      null,
      { timeout: 20000 },
    );
  } finally {
    await ctx.close();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

> `speechOutput` 是在 `decodeAudioData` 之后才写的，所以**不能**用
> `window.__pet.speechCount > 0` 当条件——那个计数在解码之前就加了。
> 用 `speechOutput === 'masterGain'` 才对。

- [ ] **Step 9: 跑端到端测试确认通过**

Run: `npx playwright test test/e2e/system.spec.js test/e2e/tts.spec.js`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/main/assistant/state.js src/renderer/pet/audio.js src/renderer/main.js \
        src/preload/index.cjs src/main/index.js test/unit/assistant.test.js \
        test/e2e/system.spec.js test/e2e/tts.spec.js
git commit -m "feat(audio): 总音量同时管住提示音与桌宠说话"
```

---

### Task 4: system.js 控制器——开机自启

**Files:**
- Create: `src/main/system.js`
- Test: `test/unit/system.test.js`

**Interfaces:**
- Consumes: Task 1 的 `settings.autoLaunch`
- Produces:
  - `createSystemController(options) → controller`
  - `controller.init(settings)` —— 启动时恢复
  - `controller.applySettings(settings)` —— 变更生效
  - `controller.getState() → object`
  - `controller.dispose()` —— 退出时清理
  - 注入项：`getWindow` / `getDisplays` / `getSettings` / `applySettings` / `onHotkeyAction` / `onStateChanged` / `loginItem` / `shortcuts` / `isE2E`

- [ ] **Step 1: 写失败的测试**

Create `test/unit/system.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemController } from '../../src/main/system.js';

/**
 * 造一个替身窗口：只记录被调用的方法。
 *
 * **位置必须跟着 setPosition 变**：停靠的判定读的是窗口的真实位置，
 * 替身不动的话拖拽永远停在起点，停靠根本触发不了。
 */
function fakeWindow() {
  const calls = [];
  let pos = [100, 100];
  return {
    calls,
    isDestroyed: () => false,
    getPosition: () => pos,
    getSize: () => [300, 560],
    setPosition: (x, y) => {
      calls.push(['setPosition', x, y]);
      pos = [x, y];
    },
    setIgnoreMouseEvents: (ignore, options) =>
      calls.push(['setIgnoreMouseEvents', ignore, options]),
  };
}

/** 造一个控制器：外部能力全部是替身。 */
function makeController(overrides = {}) {
  const win = fakeWindow();
  const loginItemCalls = [];
  const settings = {
    autoLaunch: false,
    hotkey: 'Control+Shift+D',
    clickThrough: false,
    edgeSnap: true,
    dockEnabled: false,
    dock: null,
    ...(overrides.settings || {}),
  };
  const patched = [];
  let controller = null;
  const options = {
    getWindow: () => win,
    getDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1000, height: 800 },
        workArea: { x: 0, y: 0, width: 1000, height: 800 },
      },
    ],
    getSettings: () => settings,
    // 模拟 index.js 的 persist：改完设置后会回头调 system.applySettings。
    // 这一步是必须的——不回调的话，「改设置 → 生效」这条链在单测里是断的。
    applySettings: (patch) => {
      patched.push(patch);
      Object.assign(settings, patch);
      controller?.applySettings(settings);
      return settings;
    },
    onHotkeyAction: () => {},
    onStateChanged: () => {},
    onHotkeyStatus: () => {},
    loginItem: {
      set: (s) => loginItemCalls.push(s),
      get: () => ({ openAtLogin: false }),
    },
    shortcuts: {
      register: () => true,
      unregister: () => {},
      unregisterAll: () => {},
      isRegistered: () => true,
    },
    getAppPath: () => 'E:/project/desk-pet',
    isPackaged: false,
    isE2E: true,
    ...(overrides.options || {}),
  };
  controller = createSystemController(options);
  return { controller, win, settings, patched, loginItemCalls };
}

test('开机自启：打开时写入登录项', () => {
  const { controller, loginItemCalls, settings } = makeController();
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.equal(loginItemCalls.length, 1);
  assert.equal(loginItemCalls[0].openAtLogin, true);
});

test('开机自启：关闭时也要写（否则系统里还留着）', () => {
  const { controller, loginItemCalls, settings } = makeController({
    settings: { autoLaunch: true },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: false });
  assert.equal(loginItemCalls.length, 1);
  assert.equal(loginItemCalls[0].openAtLogin, false);
});

test('开机自启：没变化就不重复写注册表', () => {
  const { controller, loginItemCalls, settings } = makeController({
    settings: { autoLaunch: true },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.deepEqual(loginItemCalls, []);
});

test('开机自启：开发态要带上应用路径，否则开机只弹空白 Electron', () => {
  const { controller, loginItemCalls, settings } = makeController({
    options: { isPackaged: false, getAppPath: () => 'E:/project/desk-pet' },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.deepEqual(loginItemCalls[0].args, ['E:/project/desk-pet']);
  // path 指向当前可执行文件（Electron 的默认值，写出来是为了明确）。
  assert.equal(loginItemCalls[0].path, process.execPath);
});

test('开机自启：打包后不带参数（process.execPath 就是应用自己）', () => {
  const { controller, loginItemCalls, settings } = makeController({
    options: { isPackaged: true },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.deepEqual(loginItemCalls[0].args, []);
});

test('开机自启：注册失败时把开关改回关闭', () => {
  const { controller, patched, settings } = makeController({
    options: {
      loginItem: {
        set: () => {
          throw new Error('注册表写不进去');
        },
        get: () => ({ openAtLogin: false }),
      },
    },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  // 磁盘上不能写着 true 而系统里没有注册项。
  assert.deepEqual(patched, [{ autoLaunch: false }]);
  assert.equal(settings.autoLaunch, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/system.test.js`
Expected: FAIL —— `Cannot find module '../../src/main/system.js'`。

- [ ] **Step 3: 实现控制器骨架 + 开机自启**

Create `src/main/system.js`：

```js
import {
  edgeGaps,
  snapToEdge,
  dockPosition,
  flushPosition,
  clampDocked,
  isFullyTucked,
  chooseDockSide,
} from './edgeDock.js';
import { clampToDisplays, displayForPoint } from './display.js';

/**
 * 系统级开关的控制器：开机自启、全局快捷键、鼠标穿透、边缘吸附与贴边停靠。
 *
 * **这个文件不得 import Electron**：本仓库的单元测试用 `node --test` 跑，
 * 没有 Electron 环境。Electron 的能力（app / globalShortcut）全部靠注入。
 *
 * 为什么要一个控制器而不是四个小模块：这四个开关共享同一套流程
 * ——落盘 → 启动恢复 → 变更生效。放在一起，它们能互相看见
 * （比如「关掉贴边隐藏时要把停靠中的桌宠取回来」）。
 */
export function createSystemController({
  getWindow,
  getDisplays,
  getSettings,
  applySettings,
  onHotkeyAction,
  onStateChanged,
  onHotkeyStatus,
  loginItem,
  shortcuts,
  getAppPath,
  isPackaged = false,
  isE2E = false,
}) {
  // 上一次**真正生效出去**的值。
  // 只有真的变了才动作：applySettings 在拖拽的每一帧都会被调用，
  // 无变化时重复写注册表、重复注册快捷键是最热的路径上的无用功。
  let applied = null;
  // 当前停靠在哪条边（null = 没停靠）。
  let dock = null;
  // 本次拖拽的期望位置（未夹紧）与净位移。
  let desired = null;
  let netDelta = { dx: 0, dy: 0 };
  // 快捷键录制中。
  let recording = false;
  let hotkeyStatus = { state: 'idle', accelerator: '', error: '' };
  // 最近一次失败的说明。空串 = 没有失败。
  // 它是「界面上说得出来」那半的载体——光在终端留痕，用户看不见。
  let lastError = '';

  // —— 开机自启 ——

  /**
   * 写登录项。
   *
   * 开发态（未打包）必须带应用路径：那时 process.execPath 是 electron.exe，
   * 不带路径的话开机只会弹一个空白的 Electron 窗口。
   * 打包后 process.execPath 就是应用自己，不需要参数。
   *
   * `path` 写死 `process.execPath`：Electron 的默认值也是它，但写出来更清楚
   * （`process` 是 Node 全局，不算 import Electron，单元测试里也能断言）。
   */
  function writeLoginItem(enabled) {
    const args = isPackaged ? [] : [getAppPath()];
    loginItem.set({ openAtLogin: Boolean(enabled), path: process.execPath, args });
  }

  /**
   * 写登录项。
   *
   * 成功返回 `null`（falsy），失败返回**错误原因**（非空串）。
   * 返回原因而不是布尔：失败原因要一路带到 `lastError` 里，
   * 用户在设置窗口看到的是「为什么没成功」，不是干巴巴一个「失败」。
   */
  function applyAutoLaunch(enabled) {
    try {
      writeLoginItem(enabled);
      return null;
    } catch (err) {
      // 失败必须留痕：否则用户勾了「开机自启」而系统里根本没有注册项，
      // 而且没有任何线索可查。
      console.warn('[desk-pet] 开机自启设置失败：', err?.message || err);
      return err?.message || '未知原因';
    }
  }

  // —— 状态上报 ——

  function getState() {
    const settings = getSettings();
    return {
      autoLaunch: Boolean(settings.autoLaunch),
      hotkey: settings.hotkey,
      hotkeyStatus: { ...hotkeyStatus },
      clickThrough: Boolean(settings.clickThrough),
      clickThroughActive: Boolean(applied?.clickThrough),
      edgeSnap: settings.edgeSnap !== false,
      dockEnabled: Boolean(settings.dockEnabled),
      dock,
      // 最近一次失败的原因。设置窗口拿它把失败显示给用户——
      // 「失败必须留痕 + 在界面上说得出来」那半的载体。
      lastError,
    };
  }

  // —— 对外接口 ——

  /**
   * 启动时恢复。
   *
   * 注意：**不重新注册登录项**——用户在系统设置里手动删掉了注册项，
   * 应用一启动就给它加回去，那是在跟用户较劲。只在用户改动开关时才写。
   */
  function init(settings) {
    applied = {
      autoLaunch: Boolean(settings.autoLaunch),
      clickThrough: Boolean(settings.clickThrough),
    };
    // 穿透模式要在窗口建好之后立刻生效。
    // 默认（关）时**不要**调 setIgnoreMouseEvents：窗口本来就是可点的，
    // 多余的一次原生调用没有意义，还会让「本次只调了一次」的断言变复杂。
    if (settings.clickThrough) applyClickThrough(true);
  }

  function applyClickThrough(enabled) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // forward: true 让 mousemove 继续送到渲染层——
    // 桌宠仍然能跟着光标转头，但点击落到桌面上。
    if (enabled) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  }

  /**
   * 设置变了：把真的变了的那部分落到实际效果上。
   */
  function applySettingsToSystem(settings) {
    if (!applied) applied = { autoLaunch: false, clickThrough: false };
    const patch = {};
    // 这次变更里有没有「做失败了」的事：有的话最后要通知外面，
    // 让界面知道出了错——失败不能是静默的。
    let failed = false;

    if (Boolean(settings.autoLaunch) !== Boolean(applied.autoLaunch)) {
      const want = Boolean(settings.autoLaunch);
      const error = applyAutoLaunch(want);
      if (error) {
        failed = true;
        // 说清是什么事、为什么：用户看到「开机自启没打开」时，
        // 得知道是注册表写不进去还是别的。
        lastError = `开机自启${want ? '开启' : '关闭'}失败：${error}`;
        // 写失败：不管开关是开还是关，注册项与磁盘都可能不一致。
        //
        // 关闭方向：**不动 applied**——留着旧值，下一次 applySettings 会重试；
        // 若把 applied 记成 false，控制器就以为已经关了（系统里的注册项还在，
        // 下次开机照样自启），而且此后同值的 applySettings 永远不会再试。
        //
        // 打开方向：必须把磁盘改回去——磁盘上的 true 是假的，
        // 用户重启后会以为自启开着。
        if (want) {
          patch.autoLaunch = false;
          applied.autoLaunch = false;
        }
      } else {
        applied.autoLaunch = want;
        lastError = '';
      }
    }

    if (Boolean(settings.clickThrough) !== Boolean(applied.clickThrough)) {
      applyClickThrough(Boolean(settings.clickThrough));
      applied.clickThrough = Boolean(settings.clickThrough);
      onStateChanged?.();
    }

    // 先把回退落盘，再通知外面：通知时 settings 必须已经是回退后的值，
    // 否则界面会停留在「已开启」而磁盘上已经是「关闭」。
    if (Object.keys(patch).length > 0) applySettings(patch);
    if (failed) onStateChanged?.();
  }

  return {
    init,
    applySettings: applySettingsToSystem,
    getState,
    dispose() {},
  };
}
```

> 停靠（`undock` / `applyDockAtStartup` / 拖拽状态机）**不在本任务里**——
> Task 7 会连同它们的调用点一起加进来。
> 这里刻意不留空壳：空函数在代码里是「看起来实现了其实没有」的东西，
> 审查时很难分辨它是占位还是遗漏。

- [ ] **Step 4: 把控制器接进主进程**

`src/main/index.js`：

1. 顶部 import 加：

```js
import { createSystemController } from './system.js';
```

2. `let pendingWrite = null;` 之后加：

```js
// 系统级开关的控制器（第六部分）。
let system = null;
```

3. `app.whenReady()` 里，`win = createPetWindow({ rootDir: ROOT, settings, displays: currentDisplays() });` **之后**加：

```js
  // 系统控制器：必须在窗口建好之后创建——穿透模式要作用在窗口上。
  system = createSystemController({
    getWindow: () => win,
    getDisplays: () => currentDisplays(),
    getSettings: () => settings,
    applySettings: (patch) => persist(patch),
    onHotkeyAction: () => toggleVisible(),
    onStateChanged: () => {
      // 系统状态变了要广播出去：设置窗口的勾选框要跟着回退，
      // 而且它靠 getState().lastError 把失败原因显示出来。
      // persist() 自己不广播——落盘是防抖的，而「生效」不能等落盘。
      broadcastSettings(settings);
    },
    onHotkeyStatus: (status) => {
      // 设置窗口还没建时无处可发；它建好后会自己拉一次状态。
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('pet:hotkeyStatus', status);
      }
    },
    loginItem: {
      set: (opts) => {
        // E2E 不碰注册表：写注册表会污染跑测试的机器，
        // 而且注册表项可能指向临时路径，清理不掉。
        if (IS_E2E) return;
        app.setLoginItemSettings(opts);
      },
      get: () => app.getLoginItemSettings(),
    },
    shortcuts: {
      register: (acc, cb) => {
        // E2E 不占用系统级快捷键：注册是真的全局生效，
        // 跑测试的那几分钟里用户按这个组合会被应用吃掉。
        // 假装成功，好让「状态被正确上报」那条链路在 E2E 里仍然跑得通。
        if (IS_E2E) return true;
        return globalShortcut.register(acc, cb);
      },
      unregister: (acc) => {
        if (IS_E2E) return;
        globalShortcut.unregister(acc);
      },
      unregisterAll: () => {
        if (IS_E2E) return;
        globalShortcut.unregisterAll();
      },
      isRegistered: (acc) => globalShortcut.isRegistered(acc),
    },
    getAppPath: () => app.getAppPath(),
    isPackaged: app.isPackaged,
    isE2E: IS_E2E,
  });
  system.init(settings);
```

4. 顶部 import 里的 electron 依赖加 `globalShortcut`：

```js
import { app, screen, dialog, BrowserWindow, shell, globalShortcut } from 'electron';
```

5. `persist()` 里，在 `if (saveTimer) clearTimeout(saveTimer);` **之前**加：

```js
  // 系统级开关要立刻生效：落盘是 300ms 之后的事，生效是现在。
  system?.applySettings?.(settings);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/unit/system.test.js`
Expected: PASS（6 条全过）。

- [ ] **Step 6: 提交**

```bash
git add src/main/system.js src/main/index.js test/unit/system.test.js
git commit -m "feat(system): 系统级开关的控制器骨架与开机自启"
```

---

### Task 5: system.js——全局快捷键

**Files:**
- Modify: `src/main/system.js`
- Modify: `src/main/ipc.js`
- Modify: `src/preload/index.cjs`
- Test: `test/unit/system.test.js`（扩充）

**Interfaces:**
- Consumes: Task 4 的 `createSystemController`
- Produces:
  - `buildAccelerator(input) → string`（导出，便于单测）
  - `controller.startRecording()` / `controller.cancelRecording()` / `controller.isRecording()`
  - `controller.handleInput(input) → string | null`
  - `controller.setHotkey(accelerator) → boolean`
  - preload：`window.pet.recordHotkey()` / `cancelHotkeyRecording()` / `getSystemState()` / `onHotkeyStatus(cb)`
  - 主进程 → 渲染层通道：`pet:hotkeyStatus`，载荷 `{state, accelerator, error}`
  - IPC：`pet:getSystemState` / `pet:recordHotkey` / `pet:cancelHotkeyRecording`

- [ ] **Step 1: 写失败的测试**

在 `test/unit/system.test.js` 末尾追加（同时把 import 改成 `import { createSystemController, buildAccelerator } from '../../src/main/system.js';`）：

```js
test('加速键串：修饰键 + 主键', () => {
  assert.equal(
    buildAccelerator({ key: 'd', control: true, alt: false, shift: true, meta: false }),
    'Control+Shift+D',
  );
});

test('加速键串：纯修饰键不构成组合', () => {
  assert.equal(buildAccelerator({ key: 'Control', control: true }), '');
  assert.equal(buildAccelerator({ key: 'Shift', shift: true }), '');
});

test('加速键串：裸键被拒绝（会全局劫持字母键）', () => {
  assert.equal(buildAccelerator({ key: 'd' }), '');
  assert.equal(buildAccelerator({ key: 'F5' }), '');
});

test('加速键串：Shift 过的符号要还原成基础键', () => {
  // 用户按 Ctrl+Shift+1 时 input.key 是 '!'（美式键盘）。
  // 直接用 '!' 会得到注册不了的 'Control+Shift+!'。
  assert.equal(
    buildAccelerator({ key: '!', control: true, shift: true }),
    'Control+Shift+1',
  );
});

test('加速键串：特殊键名要换成 Electron 的写法', () => {
  assert.equal(buildAccelerator({ key: 'ArrowUp', control: true }), 'Control+Up');
  assert.equal(buildAccelerator({ key: ' ', control: true }), 'Control+Space');
});

test('快捷键注册成功：落盘新组合并注销旧的', () => {
  const registered = [];
  const unregistered = [];
  const { controller, patched, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: (acc) => unregistered.push(acc),
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  controller.init(settings);
  controller.setHotkey('Control+Alt+P');
  // init 已经按规格注册了 settings.hotkey，这里再注册新组合——
  // 两次都在列表里，顺序也反映了真实发生的事。
  assert.deepEqual(registered, ['Control+Shift+D', 'Control+Alt+P']);
  assert.deepEqual(unregistered, ['Control+Shift+D']);
  assert.equal(settings.hotkey, 'Control+Alt+P');
});

test('启动时按 settings.hotkey 注册一次', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  controller.init(settings);
  assert.deepEqual(registered, ['Control+Shift+D']);
});

test('裸键被 setHotkey 拒绝：不会注册成全局裸键', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  controller.init(settings);
  registered.length = 0;
  assert.equal(controller.setHotkey('D'), false);
  assert.deepEqual(registered, []);
  assert.equal(controller.getState().hotkeyStatus.state, 'error');
});

test('快捷键注册失败：旧组合保留，且不落盘新组合', () => {
  const { controller, patched, settings } = makeController({
    options: {
      shortcuts: {
        register: () => false,
        unregister: () => {
          throw new Error('不该注销旧的');
        },
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  controller.init(settings);
  const ok = controller.setHotkey('Control+Alt+P');
  assert.equal(ok, false);
  // 磁盘上的组合没变：用户不至于连原来的快捷键也丢掉。
  assert.deepEqual(patched, []);
  assert.equal(settings.hotkey, 'Control+Shift+D');
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'error');
  assert.match(state.hotkeyStatus.error, /占用/);
});

test('快捷键语法非法：提示与「被占用」区分开', () => {
  // 「被占用」要用户换个组合；「这个组合不能用」是设置本身写坏了。
  // 混成一句话等于让用户瞎猜。
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: () => {
          throw new Error('Invalid accelerator token');
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  controller.init(settings);
  assert.equal(controller.setHotkey('Control+Alt+P'), false);
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'error');
  assert.match(state.hotkeyStatus.error, /不能用/);
  assert.doesNotMatch(state.hotkeyStatus.error, /占用/);
});

test('录制：开始 → 处理按键 → 注册', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  controller.init(settings);
  controller.startRecording();
  assert.equal(controller.isRecording(), true);
  const acc = controller.handleInput({ key: 'k', control: true, alt: true });
  assert.equal(acc, 'Control+Alt+K');
  assert.deepEqual(registered, ['Control+Alt+K']);
  assert.equal(controller.isRecording(), false);
});

test('录制：Esc 取消', () => {
  const { controller, settings } = makeController();
  controller.init(settings);
  controller.startRecording();
  assert.equal(controller.handleInput({ key: 'Escape' }), null);
  assert.equal(controller.isRecording(), false);
});

test('录制：纯修饰键不算数，继续等', () => {
  const { controller, settings } = makeController();
  controller.init(settings);
  controller.startRecording();
  assert.equal(controller.handleInput({ key: 'Control', control: true }), null);
  assert.equal(controller.isRecording(), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/system.test.js`
Expected: FAIL —— `buildAccelerator` 不是导出、`controller.setHotkey` 不是函数。

- [ ] **Step 3: 实现加速键串的拼装**

在 `src/main/system.js` 顶部（import 之后）加：

```js
/**
 * 键盘上带 Shift 时会变成的符号 → 基础键。
 *
 * 用户按 Ctrl+Shift+1 时 input.key 是 '!'（美式键盘），
 * 直接用 '!' 会拼出注册不了的 'Control+Shift+!'。
 */
const SHIFTED_TO_BASE = Object.freeze({
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']',
  '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
});

/** input.key → Electron 加速键里的键名。 */
const KEY_NAMES = Object.freeze({
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
});

/** 这些键是修饰键，单独按不算一个组合。 */
const MODIFIER_KEYS = new Set([
  'Control', 'Alt', 'Shift', 'Meta', 'Super', 'CapsLock',
  'AltGraph', 'Fn', 'Hyper', 'NumLock', 'ScrollLock', 'Dead',
]);

/**
 * 把一次按键拼成 Electron 的加速键串。
 *
 * 返回空串表示「还不算一个组合」（纯修饰键，或没有修饰键的裸键）。
 *
 * **必须至少一个修饰键**：Windows 的 RegisterHotKey 允许注册裸键，
 * 那意味着全局劫持用户的字母键——「按 D 一下」会同时被桌宠吃掉。
 */
export function buildAccelerator(input) {
  if (!input || typeof input.key !== 'string' || input.key === '') return '';
  const raw = input.key;
  if (raw === 'Escape') return '';
  if (MODIFIER_KEYS.has(raw)) return '';
  const mods = [];
  if (input.control) mods.push('Control');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (input.meta) mods.push('Super');
  if (mods.length === 0) return '';
  const base = SHIFTED_TO_BASE[raw] || raw;
  const key = KEY_NAMES[base] || (base.length === 1 ? base.toUpperCase() : base);
  return [...mods, key].join('+');
}
```

- [ ] **Step 4: 实现快捷键的注册与录制**

在 `src/main/system.js` 的 `createSystemController` 内部，`// —— 状态上报 ——` 之前加：

```js
  // —— 全局快捷键 ——

  /**
   * 注册一个组合。
   *
   * 返回 'ok' | 'taken' | 'invalid'：
   * - 'ok'：注册成功。
   * - 'taken'：**被别的程序占用**。`globalShortcut.register` 在这种情况下
   *   返回 false 而且**不抛错**（Windows 上是静默失败，Electron 文档明说
   *   这是操作系统的有意行为）。
   * - 'invalid'：**加速键串语法非法**，这时 register 会抛异常。
   *
   * **两者必须分开**：用户看到的提示不同。
   * 「被占用」要他去换个组合；「这个组合不能用」是设置本身写错了
   * （比如从磁盘上读进来一个手改坏的字符串）。混成一句话等于让用户瞎猜。
   */
  function registerShortcut(accelerator) {
    try {
      return shortcuts.register(accelerator, onHotkeyAction) ? 'ok' : 'taken';
    } catch (err) {
      console.warn('[desk-pet] 快捷键注册失败：', err?.message || err);
      return 'invalid';
    }
  }

  /** 注册失败时的提示语。 */
  function shortcutErrorText(result) {
    return result === 'invalid' ? '这个组合不能用' : '该组合已被其他程序占用';
  }

  function setHotkeyStatus(next) {
    hotkeyStatus = { ...hotkeyStatus, ...next };
    notifyHotkeyStatus();
  }

  /**
   * 换一组快捷键。
   *
   * **先注册新的、成功了再注销旧的**——反过来的话，失败时连原来的组合也丢了，
   * 用户会发现自己连原来那个能用的快捷键都按不动了。
   */
  function setHotkey(accelerator) {
    if (typeof accelerator !== 'string' || accelerator === '') return false;
    const current = getSettings().hotkey;
    if (accelerator === current) {
      recording = false;
      setHotkeyStatus({ state: 'ok', accelerator, error: '' });
      return true;
    }
    const result = registerShortcut(accelerator);
    if (result !== 'ok') {
      recording = false;
      setHotkeyStatus({
        state: 'error',
        accelerator: current,
        error: shortcutErrorText(result),
      });
      return false;
    }
    if (current) shortcuts.unregister(current);
    applySettings({ hotkey: accelerator });
    recording = false;
    setHotkeyStatus({ state: 'ok', accelerator, error: '' });
    return true;
  }

  function startRecording() {
    recording = true;
    setHotkeyStatus({ state: 'recording', error: '' });
    return true;
  }

  function cancelRecording() {
    recording = false;
    setHotkeyStatus({ state: 'idle', error: '' });
    return true;
  }

  function isRecording() {
    return recording;
  }

  /** 录制中的一次按键。返回拼好的组合；不是组合时返回 null。 */
  function handleInput(input) {
    if (!recording) return null;
    if (input?.key === 'Escape') {
      cancelRecording();
      return null;
    }
    const acc = buildAccelerator(input);
    if (!acc) return null;
    setHotkey(acc);
    return acc;
  }
```

- [ ] **Step 5: 接上通知通道与启动注册**

`src/main/system.js`：

- 在 `createSystemController` 的参数解构里已经有 `onHotkeyStatus`（Task 4 加的）。
  把内部的通知函数改成用它：

```js
  // 主进程 → 设置窗口的快捷键状态通知。
  // 设置窗口是 index.js 管的，所以通知由外部注入。
  const notifyHotkeyStatus = () => {
    onHotkeyStatus?.({ ...hotkeyStatus });
  };
```

  把 Task 4 里 `let hotkeyStatus = { ... };` 那一行后面补上这个函数
  （放在 `getState()` 之前即可）。

- `init(settings)` 里加一段（穿透模式之后）：

```js
    // 快捷键：启动时就注册。失败只留痕 + 在设置窗口显示状态，不阻断启动。
    //
    // **无条件注册**：进程刚起时这个组合不可能已经被本进程注册过，
    // 加一道「已注册就不注册」的守卫反而会让「启动时注册一次」这条规格
    // 变得没法验证——而那条守卫唯一能到达的状态只有测试替身造得出来。
    if (settings.hotkey) {
      const result = registerShortcut(settings.hotkey);
      if (result === 'ok') {
        setHotkeyStatus({ state: 'ok', accelerator: settings.hotkey, error: '' });
      } else {
        // 启动就失败要留痕：否则用户以为快捷键设好了，按下去没反应，
        // 而终端里什么也没有。
        console.warn('[desk-pet] 快捷键注册失败：', shortcutErrorText(result));
        setHotkeyStatus({
          state: 'error',
          accelerator: settings.hotkey,
          error: shortcutErrorText(result),
        });
      }
    }
```

- `setHotkey` 入口加一道修饰键校验（规格 §4.3①）：

```js
  /** 加速键串里至少要有一个修饰键。 */
  function hasModifier(accelerator) {
    return /(^|\+)(Control|Ctrl|Alt|Shift|Super|Command|Meta)(\+|$)/i.test(accelerator);
  }
```

  在 `setHotkey` 里，`if (typeof accelerator !== 'string' || accelerator === '') return false;` 之后加：

```js
    // 必须至少一个修饰键：裸键注册是全局的，会劫持用户的字母键
    // （规格 §4.3①）。buildAccelerator 已经保证过，这里再挡一道——
    // 因为 setHotkey 可能被别的通道直接调用。
    if (!hasModifier(accelerator)) {
      recording = false;
      setHotkeyStatus({
        state: 'error',
        accelerator: current,
        error: '这个组合不能用：至少要带 Ctrl / Alt / Shift 之一',
      });
      return false;
    }
```

- `dispose()` 改成：

```js
    dispose() {
      // 退出时注销快捷键：不注销的话这个组合会一直被占着，
      // 下次启动注册不上。
      try {
        shortcuts.unregisterAll();
      } catch {
        /* ignore */
      }
    },
```

- [ ] **Step 6: 加 IPC 通道与 preload**

`src/main/ipc.js`：在参数解构里加 `getSystemState, recordHotkey, cancelHotkeyRecording`，在函数体里加：

```js
  // —— 系统级开关（第六部分）——
  // 设置窗口要读当前状态（勾选框、快捷键、停靠边）。
  ipcMain.handle('pet:getSystemState', () => getSystemState());
  // 开始/取消录制快捷键。真正的按键捕获在主进程（before-input-event）。
  ipcMain.handle('pet:recordHotkey', () => recordHotkey());
  ipcMain.handle('pet:cancelHotkeyRecording', () => cancelHotkeyRecording());
```

`src/preload/index.cjs`，在 `onSoundEnabled` 那段之后加：

```js
  // —— 系统级开关（第六部分）——
  getSystemState: () => ipcRenderer.invoke('pet:getSystemState'),
  recordHotkey: () => ipcRenderer.invoke('pet:recordHotkey'),
  cancelHotkeyRecording: () => ipcRenderer.invoke('pet:cancelHotkeyRecording'),
  onHotkeyStatus: (cb) => {
    ipcRenderer.on('pet:hotkeyStatus', (_e, payload) => cb(payload));
  },
```

- [ ] **Step 7: 把三个通道的实现接进主进程**

`src/main/index.js` 的 `registerIpc({...})` 里加：

```js
    // —— 系统级开关（第六部分）——
    // 设置窗口要读当前状态（勾选框、快捷键、停靠边）。
    getSystemState: () => system?.getState?.() || null,
    // 开始/取消录制快捷键。真正的按键捕获在主进程（before-input-event）。
    recordHotkey: () => system?.startRecording?.() || false,
    cancelHotkeyRecording: () => system?.cancelRecording?.() || false,
```

> `system` 在 `registerIpc` **之后**才创建，但这三个是箭头函数，
> 调用时才求值——那时 `system` 已经有值了。
>
> 这三个实现**必须与 `ipc.js` 里的通道注册在同一个任务里**：
> 只注册通道而不给实现，`registerIpc` 解构出来的是 `undefined`，
> 通道一旦被调用就会抛「getSystemState is not a function」。

再加两处接线（都在 `src/main/index.js`）：

**退出时注销快捷键**（规格 §4.6）——`app.on('before-quit', flushPendingSave);` 之后：

```js
// 退出时注销全局快捷键：不注销的话这个组合会一直被占着，
// 下次启动注册不上。
app.on('will-quit', () => system?.dispose?.());
```

**接上快捷键录制的按键捕获**——`openSettings()` 里，`settingsWin.loadURL(...)` **之前**：

```js
  // 快捷键录制：主进程接管按键捕获。
  //
  // 用 before-input-event 而不是渲染层的 keydown：它给的是
  // {key, control, alt, shift, meta}，正好是拼加速键串要的东西，
  // 而且能 preventDefault——不然那一次按键会漏进页面的输入框
  // （规格 §4.3②）。
  settingsWin.webContents.on('before-input-event', (event, input) => {
    if (!system?.isRecording?.()) return;
    event.preventDefault();
    system.handleInput(input);
  });
```

> 没有这一段，录制的按键就送不到控制器——设置窗口能点「录制」进入录制态，
> 但按下的键没有通道能进去，**录制无法完成，用户也就无法真正改快捷键**。
>
> 设置窗口关掉再打开时 `openSettings()` 会新建一个窗口，监听器随之重建，
> 不会重复注册。

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test test/unit/system.test.js`
Expected: PASS（6 + 11 = 17 条全过）。

- [ ] **Step 9: 提交**

```bash
git add src/main/system.js src/main/ipc.js src/preload/index.cjs src/main/index.js \
        test/unit/system.test.js
git commit -m "feat(hotkey): 全局快捷键的录制、注册与冲突提示"
```

---

### Task 6: 穿透模式与菜单

**Files:**
- Modify: `src/main/system.js`
- Modify: `src/main/menuTemplate.js`
- Modify: `src/main/index.js`
- Test: `test/unit/system.test.js`（扩充）、`test/unit/menuTemplate.test.js`（改写）、`test/e2e/system.spec.js`（扩充）

**Interfaces:**
- Consumes: Task 4 的控制器、Task 5 的 `getState`
- Produces:
  - `controller.toggleClickThrough() → boolean`
  - `menuTemplate(actions)` 新增两个动作：`isClickThrough()` / `toggleClickThrough()` / `isDocked()` / `retrievePet()`

- [ ] **Step 1: 写失败的单元测试**

`test/unit/menuTemplate.test.js` 整体替换为：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { menuTemplate } from '../../src/main/menuTemplate.js';

function makeActions(overrides = {}) {
  const calls = [];
  return {
    calls,
    toggleVisible: () => calls.push('toggleVisible'),
    openSettings: () => calls.push('openSettings'),
    quit: () => calls.push('quit'),
    toggleClickThrough: () => calls.push('toggleClickThrough'),
    isClickThrough: () => false,
    isDocked: () => false,
    retrievePet: () => calls.push('retrievePet'),
    ...overrides,
  };
}

test('菜单包含显示隐藏、鼠标穿透、设置、退出', () => {
  const tpl = menuTemplate(makeActions());
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ['显示 / 隐藏', '鼠标穿透', '设置…', '退出']);
});

test('点击各菜单项触发对应动作', () => {
  const actions = makeActions();
  const tpl = menuTemplate(actions);
  for (const item of tpl) item.click?.();
  assert.deepEqual(actions.calls, ['toggleVisible', 'toggleClickThrough', 'openSettings', 'quit']);
});

test('「鼠标穿透」是勾选项，且勾选状态反映当前值', () => {
  const on = menuTemplate(makeActions({ isClickThrough: () => true }));
  const item = on.find((i) => i.label === '鼠标穿透');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);

  const off = menuTemplate(makeActions());
  assert.equal(off.find((i) => i.label === '鼠标穿透').checked, false);
});

test('停靠时才出现「取回桌宠」', () => {
  const docked = menuTemplate(makeActions({ isDocked: () => true }));
  const labels = docked.filter((i) => i.label).map((i) => i.label);
  assert.ok(labels.includes('取回桌宠'));

  const free = menuTemplate(makeActions());
  const freeLabels = free.filter((i) => i.label).map((i) => i.label);
  assert.ok(!freeLabels.includes('取回桌宠'));
});

test('点「取回桌宠」触发 retrievePet', () => {
  const actions = makeActions({ isDocked: () => true });
  const tpl = menuTemplate(actions);
  tpl.find((i) => i.label === '取回桌宠').click?.();
  assert.deepEqual(actions.calls, ['retrievePet']);
});
```

在 `test/unit/system.test.js` 末尾追加：

```js
test('穿透模式：打开时窗口不吃点击但保留 mousemove 转发', () => {
  const { controller, win, settings } = makeController();
  controller.init(settings);
  controller.toggleClickThrough();
  // 只有一次原生调用：init 时默认是关的，不会多调一次。
  assert.deepEqual(win.calls, [['setIgnoreMouseEvents', true, { forward: true }]]);
  assert.equal(settings.clickThrough, true);
});

test('穿透模式：关掉时把点击还给窗口', () => {
  const { controller, win, settings } = makeController({
    settings: { clickThrough: true },
  });
  controller.init(settings);
  controller.toggleClickThrough();
  // init 时已经开过一次穿透，所以这里看**最后**一次调用。
  assert.deepEqual(win.calls[win.calls.length - 1], ['setIgnoreMouseEvents', false]);
  assert.equal(settings.clickThrough, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/menuTemplate.test.js test/unit/system.test.js`
Expected: FAIL —— 菜单里没有「鼠标穿透」，`toggleClickThrough` 不是函数。

- [ ] **Step 3: 实现菜单模板**

`src/main/menuTemplate.js` 整体替换：

```js
/**
 * 角色右键菜单 / 托盘菜单的模板。返回普通数组，便于单测。
 *
 * 两套菜单现在**是同一套**：只有「显示/隐藏 · 鼠标穿透 · 设置 · 退出」几项。
 *
 * 以前右键菜单里还有一个「小工具」子菜单（待办、提醒、番茄钟……），
 * 那条路换成了**插件面板**（见 src/main/panel.js）：
 * 左键点桌宠 → 弹出搜索框 → 模糊搜索 → 回车打开插件界面。
 * 菜单放不下搜索框，也塞不下清单——插件面板才装得下。
 */

/** 基础菜单。托盘与右键都用它。 */
export function menuTemplate(actions) {
  const items = [
    { label: '显示 / 隐藏', click: () => actions.toggleVisible() },
    { type: 'separator' },
  ];
  // 停靠（藏到屏幕边缘外）时才出现「取回桌宠」。
  if (actions.isDocked?.()) {
    items.push({ label: '取回桌宠', click: () => actions.retrievePet?.() });
    items.push({ type: 'separator' });
  }
  items.push({
    label: '鼠标穿透',
    type: 'checkbox',
    checked: Boolean(actions.isClickThrough?.()),
    click: () => actions.toggleClickThrough?.(),
  });
  items.push({ type: 'separator' });
  items.push({ label: '设置…', click: () => actions.openSettings() });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => actions.quit() });
  return items;
}
```

- [ ] **Step 4: 实现控制器的穿透开关**

`src/main/system.js`，在 `applyClickThrough` 之后加：

```js
  /**
   * 切换穿透模式，返回切换后的状态。
   *
   * 只调 applySettings 就够了：那条链会回到 applySettingsToSystem，
   * 由它统一施加效果（那里才有「真的变了才动作」的判断）。
   * 这里**不要**再直接调 applyClickThrough——那会施加两次。
   */
  function toggleClickThrough() {
    const next = !getSettings().clickThrough;
    applySettings({ clickThrough: next });
    return next;
  }
```

并在 `return { ... }` 里加 `toggleClickThrough,`。

- [ ] **Step 5: 主进程接线**

`src/main/index.js`：

> 控制器本体已经在 Task 4 里创建并接进 `persist()` 了。
> 本任务只加**菜单与快捷键动作**这一层。

1. 把 Task 4 里创建控制器时的 `onStateChanged` 改成：

```js
    onStateChanged: () => {
      refreshTrayMenu();
      // 设置窗口也要跟着变：用户可能是在**托盘菜单**里改的穿透，
      // 那条路不经过设置窗口自己的 saveSettings，不会自动广播。
      broadcastSettings(settings);
    },
```

> Task 4 已经把 `broadcastSettings(settings)` 接进去了——
> 开机自启失败时 `lastError` 要靠这条广播送到设置窗口。
> 本任务只是**再加**托盘菜单的重建。

2. 加托盘菜单重建函数与**共用的动作表**（放在 `openSettings` 之后）：

```js
/**
 * 托盘菜单与右键菜单共用的动作表。
 *
 * 两处各写一份的后果很具体：加一个动作要改两处，
 * 漏一处就是「托盘菜单里那个项点了没反应」。
 */
function menuActions() {
  return {
    toggleVisible,
    openSettings,
    quit: () => app.quit(),
    toggleClickThrough: () => system?.toggleClickThrough?.(),
    isClickThrough: () => settings?.clickThrough === true,
    isDocked: () => system?.getState?.().dock != null,
    retrievePet: () => system?.retrievePet?.(),
  };
}

/**
 * 重建托盘菜单。
 *
 * 托盘菜单**只在启动时构建一次**，所以「鼠标穿透」的勾选状态、
 * 「取回桌宠」的出现与消失都靠重建来同步——否则菜单会一直显示旧状态。
 */
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu(menuActions()));
}
```

3. `toggleVisible` 改成：

```js
function toggleVisible() {
  if (!win) return;
  const next = !win.isVisible();
  if (next) {
    // 召唤桌宠 = 想看见它：停靠中的桌宠先取回来，
    // 否则用户召唤来的是一条 24px 的窄边。
    system?.retrievePet?.();
    win.showInactive();
  } else {
    win.hide();
  }
  persist({ visible: next });
}
```

4. `showContextMenu` 改成：

```js
function showContextMenu() {
  if (!win) return;
  buildContextMenu(menuActions()).popup({ window: win });
}
```

> 三个系统级 IPC 通道的实现（`getSystemState` / `recordHotkey` /
> `cancelHotkeyRecording`）**在 Task 5 就接好了**——通道注册与实现必须同任务落地，
> 否则中间那个提交里通道引用的是未定义的绑定。

5. 托盘菜单的构建改成走 `refreshTrayMenu()`：把

```js
  tray.setContextMenu(
    buildTrayMenu({
      toggleVisible,
      openSettings,
      quit: () => app.quit(),
    })
  );
```

换成

```js
  refreshTrayMenu();
```

> 退出时注销快捷键的 `will-quit` 钩子**在 Task 5 就接好了**（规格 §4.6），
> 本任务不用再加一遍。

- [ ] **Step 6: 顺带修掉 Task 5 复审留下的三条 Minor**

这三条都在 `src/main/system.js` / `test/unit/system.test.js` 里，Task 5 已经关闭，
而本任务是下一个动 `system.js` 的任务——放在这里一起收掉，免得再开一轮。

**① `init` 的注册路径也要校验修饰键。**
Task 5 加的 `hasModifier` 只挡住了 `setHotkey` 的入口，`init` 里直接
`registerShortcut(settings.hotkey)` 绕过了它。
而 `sanitizeSettings` 对 `hotkey` 只校验「非空字符串且长度 ≤ 64」——
磁盘上手改成 `hotkey: "D"` 的设置文件会在启动时注册一个**全局裸键**，
劫持用户的 D 键。

```js
    if (settings.hotkey) {
      if (!hasModifier(settings.hotkey)) {
        // 磁盘上的组合没有修饰键：注册它会劫持用户的字母键。
        // 宁可先不注册，也不能把用户的键抢走。
        console.warn('[desk-pet] 设置里的快捷键没有修饰键，已跳过注册：', settings.hotkey);
        setHotkeyStatus({
          state: 'error',
          accelerator: settings.hotkey,
          error: '这个组合不能用：至少要带 Ctrl / Alt / Shift 之一',
        });
      } else {
        const result = registerShortcut(settings.hotkey);
        ...
      }
    }
```

**② `taken` 在启动时 warn 两次（两行内容完全相同）。**
一处来自 `registerShortcut`，一处来自 `init`。删掉 `init` 里那行——
`registerShortcut` 已经覆盖了 `taken` / `invalid` 两个分支。

**③ 警告条数断言被放松了。**
上一轮为了让双 warn 通过，把 `assert.equal(warnings.length, 1)` 改成了
`assert.ok(warnings.length >= 1)`。去掉重复 warn 之后，把**能**改回 `=== 1` 的改回去；
改不回去的说明它本来就该是 `>= 1`，在报告里写明理由。

- [ ] **Step 7: 跑单元测试确认通过**

Run: `node --test test/unit/menuTemplate.test.js test/unit/system.test.js`
Expected: PASS。

> **别忘了 `test/e2e/acceptance.spec.js`**：它写死了菜单的标签数组
> （`expect(trayMenu.labels).toEqual([...])`），菜单加一项它就必然失败。
> 那条用例的标题与注释里也写着「鼠标穿透」，一并改成新的菜单结构。

- [ ] **Step 8: 写端到端测试**

先在 `test/e2e/helpers.js` 里加一个轮询助手（**Task 8 的用例也要用**）：

```js
/**
 * 轮询主进程上报的系统状态，直到满足条件（或超时）。返回最后一次的状态。
 *
 * **不能**用 `page.waitForFunction(async () => ...)`：Playwright 不 await
 * 异步谓词——返回的 Promise 恒为真，于是「等待」立刻返回，什么也没等
 * （实测：同步谓词会等到超时，异步谓词 2ms 就返回了）。
 * 那条坑会让「等状态变成 true」这种断言变成恒真。
 */
export async function waitForSystemState(ctx, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let state = null;
  for (;;) {
    state = await ctx.win.evaluate(() => window.pet.getSystemState());
    if (predicate(state)) return state;
    if (Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
}
```

`test/e2e/system.spec.js` 末尾追加：

```js
test('穿透模式：打开后主进程上报穿透状态', async () => {
  const ctx = await launchApp();
  try {
    const before = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(before.clickThroughActive).toBe(false);

    await ctx.win.evaluate(() => window.pet.saveSettings({ clickThrough: true }));
    const after = await waitForSystemState(ctx, (s) => s.clickThroughActive === true);
    expect(after.clickThrough, '穿透应当被打开').toBe(true);
    expect(after.clickThroughActive, '穿透应当真的生效了').toBe(true);

    // 关掉：点击要还给窗口。
    await ctx.win.evaluate(() => window.pet.saveSettings({ clickThrough: false }));
    const off = await waitForSystemState(ctx, (s) => s.clickThroughActive === false);
    expect(off.clickThroughActive, '穿透应当被关掉').toBe(false);
  } finally {
    await ctx.close();
  }
});
```

> `window.pet.saveSettings` 走的是 `pet:saveSettings` → 主进程 `persist()` → `system.applySettings()`，
> 穿透状态因此会立刻生效。preload 里 `saveSettings` 已存在，不用改。

- [ ] **Step 9: 跑端到端测试确认通过**

Run: `npx playwright test test/e2e/system.spec.js`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/main/system.js src/main/menuTemplate.js src/main/index.js \
        test/unit/menuTemplate.test.js test/unit/system.test.js test/e2e/system.spec.js
git commit -m "feat(click-through): 鼠标穿透开关与菜单勾选项"
```

---

### Task 7: 边缘吸附与贴边停靠接进拖拽

**Files:**
- Modify: `src/main/system.js`
- Modify: `src/main/index.js`
- Test: `test/unit/system.test.js`（扩充）、`test/e2e/system.spec.js`（扩充）、`test/e2e/helpers.js`（加 `petBounds`）

**Interfaces:**
- Consumes: Task 2 的 `edgeDock.js`、Task 4 的控制器
- Produces:
  - `controller.dragStart()` / `controller.moveBy(dx, dy)` / `controller.dragEnd()`
  - `controller.retrievePet()` —— 把停靠中的桌宠取回
  - preload 已有 `getSystemState`，端到端用它断言停靠状态

- [ ] **Step 1: 写失败的单元测试**

在 `test/unit/system.test.js` 末尾追加：

```js
test('停靠：拖到右边缘并松手 → 藏到边缘外，只露 24px', () => {
  const { controller, win, settings } = makeController({ settings: { dockEnabled: true } });
  controller.init(settings);
  controller.dragStart();
  // 往右推很多：窗口被夹到右边缘，期望位置继续累加。
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  const state = controller.getState();
  assert.equal(state.dock, 'right');
  const last = win.calls[win.calls.length - 1];
  assert.equal(last[0], 'setPosition');
  assert.equal(last[1], 1000 - 24);
});

test('停靠：没开「贴边隐藏」时不藏', () => {
  const { controller, settings } = makeController({ settings: { dockEnabled: false } });
  controller.init(settings);
  controller.dragStart();
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  assert.equal(controller.getState().dock, null);
});

test('停靠：往回拖能把桌宠拽出来', () => {
  const { controller, win, settings } = makeController({ settings: { dockEnabled: true } });
  controller.init(settings);
  controller.dragStart();
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  assert.equal(controller.getState().dock, 'right');

  // 抓住那条窄边往左拽：桌宠被拉出来，这一趟不再判定停靠。
  controller.dragStart();
  for (let i = 0; i < 4; i++) controller.moveBy(-100, 0);
  controller.dragEnd();
  assert.equal(controller.getState().dock, null);
});

test('停靠：位置记忆存的是「完全可见的贴齐位」，不是屏幕外的真实位置', () => {
  const { controller, patched, settings } = makeController({ settings: { dockEnabled: true } });
  controller.init(settings);
  controller.dragStart();
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  // 拖拽的每一帧都会落一次盘，所以要看**最后一次**。
  const posPatch = patched.filter((p) => p.position).pop();
  assert.ok(posPatch, '应当持久化位置');
  // 完全可见贴齐位：右边缘 - 窗口宽。
  assert.equal(posPatch.position.x, 1000 - 300);
});

test('关掉「贴边隐藏」时，停靠中的桌宠要立刻取回', () => {
  const { controller, win, settings } = makeController({ settings: { dockEnabled: true } });
  controller.init(settings);
  controller.dragStart();
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  assert.equal(controller.getState().dock, 'right');

  controller.applySettings({ ...settings, dockEnabled: false });
  assert.equal(controller.getState().dock, null);
  const last = win.calls[win.calls.length - 1];
  assert.equal(last[0], 'setPosition');
  assert.equal(last[1], 1000 - 300);
});

test('「取回桌宠」把停靠中的桌宠拉回完全可见', () => {
  const { controller, win, settings } = makeController({ settings: { dockEnabled: true } });
  controller.init(settings);
  controller.dragStart();
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  controller.retrievePet();
  assert.equal(controller.getState().dock, null);
  const last = win.calls[win.calls.length - 1];
  assert.equal(last[1], 1000 - 300);
});

test('从停靠里只拽出一半就松手：落盘的位置必须还在屏幕内', () => {
  // 不夹回来的话会存下一个在屏幕外的坐标——重启时 restorePosition
  // 会判定它「不在任何显示器内」，悄悄回落到主显示器右下角，
  // 用户上次把桌宠放在哪就丢了。
  const { controller, patched, settings } = makeController({ settings: { dockEnabled: true } });
  controller.init(settings);
  controller.dragStart();
  for (let i = 0; i < 10; i++) controller.moveBy(100, 0);
  controller.dragEnd();
  assert.equal(controller.getState().dock, 'right');

  // 只拽出 50px 就松手：窗口还有一大半在屏幕外。
  controller.dragStart();
  controller.moveBy(-50, 0);
  controller.dragEnd();

  assert.equal(controller.getState().dock, null);
  const posPatch = patched.filter((p) => p.position).pop();
  assert.ok(posPatch, '应当持久化位置');
  assert.ok(
    posPatch.position.x >= 0 && posPatch.position.x + 300 <= 1000,
    `落盘的位置不能落在屏幕外，实际是 ${posPatch.position.x}`
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/system.test.js`
Expected: FAIL —— `controller.dragStart` 不是函数。

- [ ] **Step 3: 实现停靠状态机**

`src/main/system.js`：

在 `createSystemController` 内部，`// —— 开机自启 ——` 之前加：

```js
  // —— 停靠 ——
  //
  // dock 是「当前藏在哪条边」；它是状态，不是开关——
  // 用户的意图是 dockEnabled（贴边隐藏那个勾选框）。

  /** 停靠所在显示器的工作区。找不到就返回 null（退化成普通夹紧）。 */
  function dockWorkArea() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    const [x, y] = win.getPosition();
    return displayForPoint(x, y, getDisplays())?.workArea || null;
  }

  /** 取消停靠：把桌宠放回完全可见的贴齐位。 */
  function undock() {
    if (!dock) return;
    const win = getWindow();
    const side = dock;
    dock = null;
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const wa = dockWorkArea();
      if (wa) {
        const target = flushPosition(side, x, y, w, h, wa);
        win.setPosition(target.x, target.y);
        applySettings({ position: { x: Math.round(target.x), y: Math.round(target.y) } });
      }
    }
    applySettings({ dock: null });
    onStateChanged?.();
  }

  /** 「取回桌宠」：停靠中的桌宠回到完全可见。 */
  function retrievePet() {
    undock();
  }

  /** 启动时按 settings.dock 施加停靠。 */
  function applyDockAtStartup() {
    const side = getSettings().dock;
    if (!side) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const wa = dockWorkArea();
    if (!wa) return;
    dock = side;
    const target = dockPosition(side, x, y, w, h, wa);
    win.setPosition(target.x, target.y);
  }

  /** 新一次拖拽开始：期望位置重置为当前真实位置。 */
  function dragStart() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    desired = { x, y };
    netDelta = { dx: 0, dy: 0 };
  }

  /**
   * 拖拽中：累加增量 → 夹紧 → 吸附 → 落盘。
   *
   * 停靠时沿停靠轴放宽（否则藏不到屏幕外）；
   * free 时在夹紧之后做吸附（推近了磁过去）。
   */
  function moveBy(dx, dy) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    const [w, h] = win.getSize();
    if (!desired) {
      const [x, y] = win.getPosition();
      desired = { x, y };
      netDelta = { dx: 0, dy: 0 };
    }
    desired.x += dx;
    desired.y += dy;
    netDelta.dx += dx;
    netDelta.dy += dy;

    const displays = getDisplays();
    let applied;
    if (dock) {
      const wa = dockWorkArea();
      applied = wa
        ? clampDocked(desired.x, desired.y, w, h, wa, dock)
        : clampToDisplays(desired.x, desired.y, w, h, displays);
    } else {
      applied = clampToDisplays(desired.x, desired.y, w, h, displays);
      if (getSettings().edgeSnap !== false) {
        const wa = displayForPoint(applied.x, applied.y, displays)?.workArea;
        if (wa) {
          const snapped = snapToEdge(applied.x, applied.y, w, h, wa, { dx, dy });
          applied = { x: snapped.x, y: snapped.y };
        }
      }
    }
    win.setPosition(applied.x, applied.y);
    persistPosition(applied, w, h);
    return applied;
  }

  /**
   * 落盘位置。
   *
   * 停靠时存的是「完全可见的贴齐位」——真实位置在屏幕外，
   * 重启时会被 restorePosition 判定为「不在任何显示器内」而回落到主显示器右下角。
   */
  function persistPosition(applied, w, h) {
    if (!dock) {
      applySettings({ position: { x: Math.round(applied.x), y: Math.round(applied.y) } });
      return;
    }
    const wa = dockWorkArea();
    if (!wa) {
      applySettings({ position: { x: Math.round(applied.x), y: Math.round(applied.y) } });
      return;
    }
    const flush = flushPosition(dock, applied.x, applied.y, w, h, wa);
    applySettings({ position: { x: Math.round(flush.x), y: Math.round(flush.y) } });
  }

  /**
   * 拖拽结束：判定要不要停靠。
   */
  function dragEnd() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const displays = getDisplays();
    const wasDocked = dock;
    const net = { ...netDelta };
    desired = null;
    netDelta = { dx: 0, dy: 0 };

    if (wasDocked) {
      // 从停靠里出来的这一趟**不再判定停靠**：「拽出来」是明确的意思，
      // 不该在同一趟拖拽的末尾又塞回去。
      const wa = dockWorkArea();
      const stillTucked = wa ? isFullyTucked(x, y, w, h, wa, wasDocked) : true;
      if (stillTucked) {
        applySettings({ dock: wasDocked });
        return;
      }
      // 被拽出来了：取消停靠，**并把位置夹回工作区内**。
      //
      // 不夹的话会存下一个在屏幕外的坐标——窗口还有一大半在屏幕外，
      // 而重启时 restorePosition 会判定它「不在任何显示器内」，
      // 悄悄回落到主显示器右下角。用户上次把桌宠放在哪就丢了。
      //
      // 夹回去之后桌宠是「完整可见、贴着那条边」的状态——
      // 也就是「完整滑回」，与预览里那条一致。
      const pulled = clampToDisplays(x, y, w, h, getDisplays());
      win.setPosition(pulled.x, pulled.y);
      dock = null;
      applySettings({ dock: null });
      applySettings({ position: { x: Math.round(pulled.x), y: Math.round(pulled.y) } });
      onStateChanged?.();
      return;
    }

    if (!getSettings().dockEnabled) return;
    const wa = displayForPoint(x, y, displays)?.workArea;
    if (!wa) return;
    const gaps = edgeGaps(x, y, w, h, wa);
    // 净位移用**期望位置**的：窗口贴边后就被夹住不动了，
    // 实际位移恒为 0，表达不了「我往右推」这个意图。
    const side = chooseDockSide(gaps, net);
    if (!side) return;
    dock = side;
    const target = dockPosition(side, x, y, w, h, wa);
    win.setPosition(target.x, target.y);
    applySettings({ dock: side });
    onStateChanged?.();
  }
```

- [ ] **Step 4: 补上两处调用点**

Task 4 里控制器没有停靠相关的调用点（那时还没有停靠）。本任务要补上：

1. `init(settings)` 里，在 `if (settings.clickThrough) applyClickThrough(true);` 之后加：

```js
    // 停靠：把窗口挪到藏起来的位置（settings.dock 记着上次藏在哪条边）。
    applyDockAtStartup();
```

2. `applySettingsToSystem(settings)` 里，在 `if (Boolean(settings.clickThrough) !== ...)` 那段之后加：

```js
    // 「贴边隐藏」被关掉时，正在停靠的桌宠要立刻取回来：
    // 不然用户关了开关、桌宠还赖在屏幕外，开关看起来没生效。
    if (settings.dockEnabled === false && dock) {
      undock();
    }
```

- [ ] **Step 5: 暴露给 index.js**

`src/main/system.js` 的 `return { ... }` 里加上：

```js
    dragStart,
    moveBy,
    dragEnd,
    retrievePet,
    undock,
```

- [ ] **Step 6: index.js 的拖拽改走控制器**

`src/main/index.js`：

`registerIpc({...})` 里的三段改成：

```js
    // 拖拽的增量位移：累加到**期望位置**上，夹紧后才落到窗口，并持久化实际位置。
    //
    // 增量式是刻意的：渲染层把「这一段拖了多远」递过来，
    // 累加结果正好等于光标相对按下点的总位移，窗口不会与光标脱节。
    onMoveBy: (dx, dy) => {
      system?.moveBy?.(dx, dy);
    },
    // 新一次拖拽开始：期望位置重新对齐当前窗口位置。
    onDragStart: () => {
      system?.dragStart?.();
    },
    // 拖拽结束：判定要不要停靠。
    //
    // 期望位置的累加器由控制器自己清——清不掉也不会串台，
    // 因为下一次 dragStart 会重新对齐。
    onDragEnd: () => {
      system?.dragEnd?.();
    },
```

并把 `let desiredPosition = null;` 及其注释整段删除（控制器接管了），
以及 `onMoveBy` 里那套 `desiredPosition` 的逻辑一并删除。

> `index.js` 里原来的 `desiredPosition` 变量与它的注释块（约 14 行）
> 现在没有用了——**删掉它**，否则会留下两份状态。
> 删的时候把它那三行注释也一起删掉（注释解释的是已经不存在的逻辑）。

- [ ] **Step 7: 跑单元测试确认通过**

Run: `node --test test/unit/system.test.js`
Expected: PASS（14 + 6 = 20 条全过）。

- [ ] **Step 8: 加端到端测试用的辅助函数**

`test/e2e/helpers.js`，在 `windowPos` 之后加：

```js
/**
 * 桌宠窗口当前的边界。
 *
 * 停靠的断言要用它：停靠后窗口**大部分在屏幕外**，
 * 只剩一条边落在工作区里。
 */
export const petBounds = (ctx) =>
  ctx.app.evaluate(({ BrowserWindow }, petUrl) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(petUrl));
    if (!w) return null;
    return w.getBounds();
  }, PET_WINDOW_URL);
```

**再把 `waitForSystemState` 从 `test/e2e/system.spec.js` 搬到这里。**
Task 6 的修复轮把它放在了 `system.spec.js` 里（模块私有），
但 Task 8 的设置窗口用例也要用——**夹具抄成多份是本仓库反复出现过的坑**
（`docs/decisions.md` #46 记过），所以要搬，不要抄。

```js
/**
 * 轮询主进程上报的系统状态，直到满足条件（或超时）。返回最后一次的状态。
 *
 * **不能**用 `page.waitForFunction(async () => ...)`：Playwright 不 await
 * 异步谓词——返回的 Promise 恒为真，于是「等待」立刻返回，什么也没等
 * （实测：同步谓词会等到超时，异步谓词 2ms 就返回了）。
 * 那条坑会让「等状态变成 true」这种断言变成恒真。
 */
export async function waitForSystemState(ctx, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let state = null;
  for (;;) {
    state = await ctx.win.evaluate(() => window.pet.getSystemState());
    if (predicate(state)) return state;
    if (Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
}
```

`test/e2e/system.spec.js` 里删掉本地的那个定义，改成从 `./helpers.js` 导入。

**顺带把两处菜单注释改对**（Task 6 的复审发现它们漏了「取回桌宠」）：
`src/main/menu.js` 与 `src/main/menuTemplate.js` 顶部都写着菜单只有
「显示/隐藏 · 鼠标穿透 · 设置 · 退出」——停靠时还会多出「取回桌宠」。

- [ ] **Step 9: 写端到端测试**

`test/e2e/system.spec.js` 的 import 行改成：

```js
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, collectErrors, dragBy, moveToTopLeft, petBounds, PET_WINDOW_URL } from './helpers.js';
```

末尾追加：

```js
test('拖到屏幕边缘会贴齐；开了「贴边隐藏」会滑出去只留一条边', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);

    // 往右推到底：窗口被夹到右边缘。
    await dragBy(ctx.win, 2000, 0);

    const bounds = await petBounds(ctx);
    const wa = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    // 停靠后窗口大部分在屏幕外，只剩 24px 落在工作区里。
    expect(wa.x + wa.width - bounds.x).toBe(24);

    const state = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe('right');
  } finally {
    await ctx.close();
  }
});

test('停靠后拖那条窄边能把桌宠拽回来', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);
    await dragBy(ctx.win, 2000, 0);
    expect((await ctx.win.evaluate(() => window.pet.getSystemState())).dock).toBe('right');

    // 抓住窄边往左拽。
    await dragBy(ctx.win, -400, 0);
    const state = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe(null);

    const bounds = await petBounds(ctx);
    const wa = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    // 完全可见：窗口右边缘贴齐工作区右边缘。
    expect(bounds.x + bounds.width).toBe(wa.x + wa.width);
  } finally {
    await ctx.close();
  }
});

test('停靠状态重启后仍然停靠', async () => {
  // **必须自己指定 userData 目录**：launchApp() 不带参数时用的是临时目录，
  // close() 会把它删掉——那样第二次启动读到的就是别人的（干净的）目录。
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-dock-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });

  const ctx = await launchApp({ userDataDir });
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);
    await dragBy(ctx.win, 2000, 0);
    expect((await ctx.win.evaluate(() => window.pet.getSystemState())).dock).toBe('right');
  } finally {
    await ctx.close();
  }

  // 用同一个 userData 目录再启动一次。
  const again = await launchApp({ userDataDir });
  try {
    const state = await again.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe('right');
    const bounds = await petBounds(again);
    const wa = await again.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(wa.x + wa.width - bounds.x).toBe(24);
  } finally {
    await again.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('关掉「贴边隐藏」时，停靠中的桌宠立刻取回', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);
    await dragBy(ctx.win, 2000, 0);
    expect((await ctx.win.evaluate(() => window.pet.getSystemState())).dock).toBe('right');

    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: false }));
    const state = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe(null);

    const bounds = await petBounds(ctx);
    const wa = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(bounds.x + bounds.width).toBe(wa.x + wa.width);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 10: 跑端到端测试确认通过**

Run: `npx playwright test test/e2e/system.spec.js`
Expected: PASS。

- [ ] **Step 11: 提交**

```bash
git add src/main/system.js src/main/index.js test/unit/system.test.js \
        test/e2e/system.spec.js test/e2e/helpers.js
git commit -m "feat(edge-dock): 边缘吸附与贴边停靠接进拖拽"
```

---

### Task 8: 设置窗口的「系统」分区

**Files:**
- Modify: `src/settings/index.html`
- Modify: `src/settings/main.js`
- Modify: `src/main/index.js`（快捷键录制的按键捕获）
- Test: `test/e2e/settings.spec.js`（扩充）、`test/e2e/system.spec.js`（扩充）

**Interfaces:**
- Consumes: Task 5 的 `pet:getSystemState` / `pet:recordHotkey` / `pet:hotkeyStatus`，Task 6 的 `pet:toggleClickThrough`
- Produces: 设置窗口第 6 个分区 `system`

- [ ] **Step 1: 写端到端测试**

`test/e2e/settings.spec.js` 的 import 行加上 `waitForSystemState`（Task 6 加在
`test/e2e/helpers.js` 里的那个轮询助手）：

```js
import { launchApp, collectErrors, gotoSection, waitForSystemState, PET_WINDOW_URL } from './helpers.js';
```

在文件末尾追加：

```js
test('设置窗口有「系统」分区，开关能落到 settings.json', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    await gotoSection(settingsWin, 'system');

    // 开机自启：勾上 → 落盘。
    await settingsWin.locator('#autoLaunch').check();
    await settingsWin.waitForFunction(
      () => document.getElementById('autoLaunch').checked === true,
      null,
      { timeout: 5000 },
    );

    // 鼠标穿透：勾上 → 主进程上报的状态跟着变。
    await settingsWin.locator('#clickThrough').check();
    const state = await waitForSystemState(ctx, (s) => s.clickThroughActive === true);
    expect(state.clickThroughActive, '鼠标穿透应当生效').toBe(true);

    // 边缘吸附 / 贴边隐藏：落盘。
    await settingsWin.locator('#dockEnabled').check();

    // 落盘：设置的写入是防抖的，轮询等它。
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
      } catch {
        saved = null;
      }
      if (saved?.autoLaunch === true && saved?.clickThrough === true && saved?.dockEnabled === true) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.autoLaunch, '开机自启应当落盘').toBe(true);
    expect(saved?.clickThrough, '鼠标穿透应当落盘').toBe(true);
    expect(saved?.dockEnabled, '贴边隐藏应当落盘').toBe(true);
    expect(saved?.edgeSnap, '边缘吸附默认开着').toBe(true);
  } finally {
    await ctx.close();
  }
});

test('「系统」分区的摘要在目录上显示', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    await settingsWin.waitForFunction(
      () => document.querySelector('[data-summary="system"]').textContent.trim() !== '—',
      null,
      { timeout: 10000 },
    );
    const summary = (await settingsWin.locator('[data-summary="system"]').textContent()).trim();
    // 默认：只有「快捷键」与「边缘吸附」是开的。
    expect(summary).toBe('2/5');
  } finally {
    await ctx.close();
  }
});
```

> `readFile` 与 `join` 在 `test/e2e/settings.spec.js` 里已经 import 了。

- [ ] **Step 2: 跑端到端测试确认失败**

Run: `npx playwright test test/e2e/settings.spec.js -g "系统"`
Expected: FAIL —— `gotoSection` 点不到 `#tab-system`。

- [ ] **Step 3: 加 HTML**

`src/settings/index.html`：

1. 在 `tab-memory` 那个按钮之后加：

```html
        <button type="button" class="nav-tab" id="tab-system" role="tab"
                data-section="system" aria-controls="panel-system"
                aria-selected="false" tabindex="-1">
          <span class="nav-label">系统</span>
          <span class="nav-summary" data-summary="system">—</span>
        </button>
```

2. 在 `panel-memory` 那个 section 之后加：

```html
        <section class="panel" id="panel-system" role="tabpanel" aria-labelledby="tab-system" hidden>
          <h1>系统</h1>
          <p class="panel-sub">开机自启、快捷键、穿透与贴边——这些是桌宠与系统的关系。</p>

          <div class="toggle solo">
            <input type="checkbox" id="autoLaunch">
            <label for="autoLaunch">
              <span class="t-label">开机自启</span>
              <span class="t-hint">登录 Windows 后自动启动桌宠</span>
            </label>
          </div>

          <p class="hint error" id="systemError" hidden></p>

（`src/settings/index.html` 的 `<style>` 里还要加一条 `.hint.error` 的样式——
设置页已经有 `--danger` / `--danger-bg` / `--danger-border` 这几个变量了，直接用：

```css
    /* 系统级失败的提示：它要说清「是什么事、为什么」。 */
    .hint.error {
      color: var(--danger);
      background: var(--danger-bg);
      border: 1px solid var(--danger-border);
      border-radius: var(--radius-sm);
      padding: 6px 9px;
      margin: 0 0 var(--gap);
    }
```
）

          <div class="field stack">
            <label for="hotkeyValue">全局快捷键</label>
            <div class="control inline">
              <input type="text" id="hotkeyValue" readonly placeholder="未设置">
              <button type="button" id="recordHotkey" class="btn">重新录制</button>
            </div>
            <p class="hint" id="hotkeyHint">呼出 / 隐藏桌宠。被别的程序占用时这里会写明。</p>
          </div>

          <div class="toggle solo">
            <input type="checkbox" id="clickThrough">
            <label for="clickThrough">
              <span class="t-label">鼠标穿透</span>
              <span class="t-hint">开启后点不到桌宠，桌面照常操作</span>
            </label>
          </div>

          <div class="toggle solo">
            <input type="checkbox" id="edgeSnap">
            <label for="edgeSnap">
              <span class="t-label">边缘吸附</span>
              <span class="t-hint">拖到屏幕边缘时自动贴齐</span>
            </label>
          </div>

          <div class="toggle solo">
            <input type="checkbox" id="dockEnabled">
            <label for="dockEnabled">
              <span class="t-label">贴边隐藏</span>
              <span class="t-hint">贴齐后滑出屏幕，只留一条边；拖那条边可以把它拉回来</span>
            </label>
          </div>
        </section>
```

- [ ] **Step 4: 加设置窗口的 JS**

`src/settings/main.js`：

1. 在文件顶部的元素查询区加：

```js
// 系统
const autoLaunchBox = document.getElementById('autoLaunch');
const clickThroughBox = document.getElementById('clickThrough');
const edgeSnapBox = document.getElementById('edgeSnap');
const dockEnabledBox = document.getElementById('dockEnabled');
const hotkeyInput = document.getElementById('hotkeyValue');
const recordHotkeyBtn = document.getElementById('recordHotkey');
const hotkeyHint = document.getElementById('hotkeyHint');
const systemError = document.getElementById('systemError');
```

2. `SECTION_KEYS` 改成：

```js
const SECTION_KEYS = ['appearance', 'assistant', 'voice', 'chat', 'memory', 'system'];
```

3. 在 `refreshNavSummaries()` 里加：

```js
  // 系统：五项里开了几项（快捷键非空即算「开」）。
  const systemFlags = [
    autoLaunchBox.checked,
    Boolean(hotkeyInput.value.trim()),
    clickThroughBox.checked,
    edgeSnapBox.checked,
    dockEnabledBox.checked,
  ];
  setSummary('system', `${systemFlags.filter(Boolean).length}/${systemFlags.length}`);
```

> 分母从数组长度取：以后加分项不会漏改分母。

4. 在 `init()` 里，`window.pet.onSettingsChanged(...)` 之后加：

```js
  // 快捷键状态：录制中 / 成功 / 失败。
  window.pet.onHotkeyStatus?.((status) => {
    if (!status) return;
    hotkeyStatus = status;
    applyHotkeyStatus();
  });
```

5. 在 `init()` 的 `Promise.all` 里加上 `window.pet.getSystemState()`：

```js
  const [settings, models, assistantState, tts, llm, systemState] = await Promise.all([
    window.pet.getSettings(),
    window.pet.listModels(),
    window.pet.getAssistantState(),
    window.pet.getTtsStatus(),
    window.pet.getLlmStatus(),
    window.pet.getSystemState(),
  ]);
```

6. 在 `init()` 的 `applyAssistantState(assistantState);` 之后加：

```js
  applySystemState(systemState);
```

7. 在文件里加这些函数：

```js
// ---------------------------------------------------------------------------
// 系统分区
// ---------------------------------------------------------------------------

/** 主进程报上来的快捷键状态。 */
let hotkeyStatus = { state: 'idle', accelerator: '', error: '' };

/** 把主进程报上来的系统状态填进控件。 */
function applySystemState(state) {
  if (!state) return;
  autoLaunchBox.checked = Boolean(state.autoLaunch);
  clickThroughBox.checked = Boolean(state.clickThrough);
  edgeSnapBox.checked = state.edgeSnap !== false;
  dockEnabledBox.checked = Boolean(state.dockEnabled);
  if (typeof state.hotkey === 'string' && state.hotkey) {
    hotkeyInput.value = state.hotkey;
  }
  if (state.hotkeyStatus) hotkeyStatus = state.hotkeyStatus;
  applyHotkeyStatus();
  // 系统级失败的原因（开机自启写注册表失败之类）。
  // 「失败必须留痕 + 在界面上说得出来」那半的载体——只有终端日志用户看不见。
  if (state.lastError) {
    systemError.textContent = state.lastError;
    systemError.hidden = false;
  } else {
    systemError.textContent = '';
    systemError.hidden = true;
  }
  refreshNavSummaries();
}

/** 快捷键那一行的文字：按钮文案 + 说明行。 */
function applyHotkeyStatus() {
  if (hotkeyStatus.state === 'recording') {
    recordHotkeyBtn.textContent = '请按下组合键…（Esc 取消）';
    hotkeyHint.textContent = '按下 Ctrl / Alt / Shift 加一个键。';
    return;
  }
  recordHotkeyBtn.textContent = '重新录制';
  if (hotkeyStatus.state === 'error') {
    hotkeyHint.textContent = hotkeyStatus.error || '这个组合不能用了，原来的组合仍然有效。';
    return;
  }
  if (hotkeyStatus.state === 'ok' && hotkeyStatus.accelerator) {
    hotkeyHint.textContent = `已生效：${hotkeyStatus.accelerator}`;
    return;
  }
  hotkeyHint.textContent = '呼出 / 隐藏桌宠。被别的程序占用时这里会写明。';
}

/** 录快捷键：主进程接管按键捕获（before-input-event）。 */
recordHotkeyBtn.addEventListener('click', async () => {
  if (hotkeyStatus.state === 'recording') {
    await window.pet.cancelHotkeyRecording?.();
    return;
  }
  try {
    await window.pet.recordHotkey?.();
  } catch (err) {
    show(`录制失败：${err?.message || err}`, 'error');
  }
});

for (const box of [autoLaunchBox, clickThroughBox, edgeSnapBox, dockEnabledBox]) {
  box.addEventListener('change', async () => {
    refreshNavSummaries();
    try {
      await window.pet.saveSettings({
        autoLaunch: autoLaunchBox.checked,
        clickThrough: clickThroughBox.checked,
        edgeSnap: edgeSnapBox.checked,
        dockEnabled: dockEnabledBox.checked,
      });
    } catch (err) {
      show(`保存失败：${err?.message || err}`, 'error');
    }
  });
}
```

> 四个勾选框一起存：`saveSettings` 是整份设置对象的浅合并补丁，
> 四个字段一起送过去省得漏。

8. 在 `window.pet.onSettingsChanged` 的回调里加（让别的窗口改了设置也能同步）：

```js
    if (typeof s.autoLaunch === 'boolean') autoLaunchBox.checked = s.autoLaunch;
    if (typeof s.clickThrough === 'boolean') clickThroughBox.checked = s.clickThrough;
    if (typeof s.edgeSnap === 'boolean') edgeSnapBox.checked = s.edgeSnap;
    if (typeof s.dockEnabled === 'boolean') dockEnabledBox.checked = s.dockEnabled;
    // 系统状态可能变了（比如开机自启写注册表失败、开关被回退）：
    // 广播里带的是**设置**，不是系统状态——重新拉一次才能拿到 lastError。
    void window.pet.getSystemState?.()?.then((next) => applySystemState(next))?.catch?.(() => {});
```

> 那个 `?.then(...)?.catch(...)` 是为了吃掉拒绝：设置窗口关掉时
> invoke 会拒绝，而渲染层没有全局 unhandledrejection 兜底。

- [ ] **Step 5: 把既有的「按分区显示」用例加上新分区**

`test/e2e/settings.spec.js` 的 `设置窗口按分区显示：一次只显示一个区` 里，
`keys` 数组改成：

```js
    const keys = ['appearance', 'assistant', 'voice', 'chat', 'memory', 'system'];
```

`test/e2e/helpers.js` 的 `gotoSection` 的 JSDoc 里，分区 key 列表补上 `'system'`：

```js
 * @param {'appearance'|'assistant'|'voice'|'chat'|'memory'|'system'} key 分区 key
```

- [ ] **Step 6: 主进程侧的快捷键状态推送**

`src/main/index.js`：

`createSystemController` 的 `onHotkeyStatus` 注入项（Task 4 留的位、Task 5 用的）在这里接上实现：

```js
    onHotkeyStatus: (status) => {
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('pet:hotkeyStatus', status);
      }
    },
```

> **按键捕获本身（`before-input-event`）在 Task 5 就接好了**——
> 没有它，录制的按键送不到控制器，录制无法完成。
> 本任务只补「状态送回设置窗口」这一半。

- [ ] **Step 7: 跑端到端测试确认通过**

Run: `npx playwright test test/e2e/settings.spec.js -g "系统"`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/settings/index.html src/settings/main.js src/main/index.js src/main/system.js \
        test/e2e/settings.spec.js test/e2e/helpers.js
git commit -m "feat(settings): 新增「系统」分区"
```

---

### Task 9: 设置窗口的「音量」滑块

**Files:**
- Modify: `src/settings/index.html`
- Modify: `src/settings/main.js`
- Test: `test/e2e/settings.spec.js`（扩充）

**Interfaces:**
- Consumes: Task 3 的 `assistant.json` 的 `sound.volume`
- Produces: 设置窗口「语音」分区的音量滑块

- [ ] **Step 1: 写端到端测试**

`test/e2e/settings.spec.js` 末尾追加：

```js
test('「语音」分区的音量滑块能改总音量', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    await gotoSection(settingsWin, 'voice');

    await settingsWin.evaluate(() => {
      const input = document.getElementById('volume');
      input.value = '0.35';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 渲染层要立刻收到（拖滑块时音量马上变，落盘是 300ms 之后的事）。
    await ctx.win.waitForFunction(() => window.__pet.volume === 0.35, null, { timeout: 10000 });

    // 落盘：助理状态的写入是防抖的，轮询等它。
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        saved = JSON.parse(await readFile(join(ctx.userDataDir, 'assistant.json'), 'utf8'));
      } catch {
        saved = null;
      }
      if (saved?.sound?.volume === 0.35) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.sound?.volume, '总音量应当落到 assistant.json').toBe(0.35);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 2: 跑端到端测试确认失败**

Run: `npx playwright test test/e2e/settings.spec.js -g "音量"`
Expected: FAIL —— `document.getElementById('volume')` 是 null。

- [ ] **Step 3: 加 HTML**

`src/settings/index.html`，在「语速」那个 field 之后加：

```html
          <div class="field">
            <label for="volume">音量</label>
            <div class="control range">
              <input type="range" id="volume" min="0" max="1" step="0.05">
              <span class="val" id="volumeVal"></span>
            </div>
          </div>
          <p class="hint">总音量：同时影响提示音与桌宠说话。</p>
```

- [ ] **Step 4: 加设置窗口的 JS**

`src/settings/main.js`：

1. 元素查询区加：

```js
const volumeInput = document.getElementById('volume');
const volumeVal = document.getElementById('volumeVal');
```

2. 加一个格式化函数（放在 `formatOpacity` 之后）：

```js
function formatVolume(v) {
  return `${Math.round(Number(v) * 100)}%`;
}
```

3. 加一个更新函数（放在 `updateOpacity` 之后）：

```js
function updateVolume(v) {
  volumeInput.value = String(v);
  volumeVal.textContent = formatVolume(v);
  setRangeFill(volumeInput);
}
```

4. `applyAssistantState(state)` 里，在 `speedVal.textContent = ...` 之后加：

```js
  updateVolume(state.sound?.volume ?? 0.8);
```

> `init()` 里不用再调一次 `updateVolume`——`applyAssistantState(assistantState)`
> 已经填好了。填两遍不会出错，但会多一处要维护的地方。

5. 滑块监听（在 `opacityInput` 的监听之后）：

```js
volumeInput.addEventListener('input', async () => {
  const v = Number(volumeInput.value);
  volumeVal.textContent = formatVolume(v);
  setRangeFill(volumeInput);
  try {
    await window.pet.saveAssistantPrefs({ sound: { volume: v } });
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
});
```

> `saveAssistantPrefs` 传的是 `{sound:{volume}}` 一层——`mergePatch` 会把 `sound`
> 里的字段**深一层**合并（`{...current.sound, ...value}`），
> 所以 `sound.enabled` 不会被抹掉。

- [ ] **Step 5: 跑端到端测试确认通过**

Run: `npx playwright test test/e2e/settings.spec.js -g "音量"`
Expected: PASS。

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: 全部通过（单元 + 端到端）。

- [ ] **Step 7: 提交**

```bash
git add src/settings/index.html src/settings/main.js test/e2e/settings.spec.js
git commit -m "feat(settings): 「语音」分区加总音量滑块"
```

---

### Task 10: 收尾——裁决记录、README 与整体验证

**Files:**
- Modify: `docs/decisions.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部九个任务
- Produces: 无（文档）

- [ ] **Step 1: 写裁决记录**

在 `docs/decisions.md` 末尾追加一节：

```markdown
---

# 第六部分（系统与工程化）的裁决

> 本节记录 2026-11-03 实现 `idea.md` 第六部分时的裁决。
> 规格见 `docs/superpowers/specs/2026-11-03-live2d-desk-pet-system-design.md`。

### 86. ⚠️ 吸附必须带「本帧位移朝那条边」
**为什么：** 只判「间隙 ≤ 24px 就贴齐」的话，窗口贴上边之后往回拖会被立刻吸回去——
用户会发现「拽不动」。加上「位移朝那条边」这一条，窗口一离开边缘就自由了。
**代价：** 无。

### 87. ⚠️ 停靠判定用**期望位置**的净位移，不用窗口的实际位移
**为什么：** 窗口被推到屏幕边缘后就被夹住不动了，此时**实际位移恒为 0**，
表达不了「我往右推」这个意图。期望位置（`desiredPosition`）还在继续累加，
它才记录了用户的动作。
**代价：** 用户把桌宠推到边缘后多推了一段，再往回拉时窗口会「慢半拍」才跟上。
这是夹紧的固有行为，既有拖拽已经如此。

### 88. ⚠️ `dockEnabled`（用户意图）与 `dock`（当前状态）分成两个字段
**为什么：** 设置页上的「贴边隐藏」勾选框要读的是**用户的意图**，
而桌宠现在藏在哪条边是**状态**。合成一个字段的话，桌宠已经藏起来时
勾选框的语义就乱了。
**代价：** 多一个字段。

### 89. ⚠️ 换快捷键时「先注册新的、再注销旧的」
**为什么：** 先 `unregisterAll()` 会把刚注册成功的新组合一起注销掉；
而先注销旧的再注册新的，注册失败时用户连原来那个能用的组合都丢了。
**代价：** 注册成功的瞬间可能有两个组合同时有效（几毫秒）。

### 90. ⚠️ 不做「开机静默启动」
**为什么：** Electron 45 **已经移除了 `openAsHidden`**
（核对 `node_modules/electron/electron.d.ts`：`Settings` 接口只剩
`openAtLogin`/`type`/`serviceName`/`path`/`args`/`enabled`/`name`）。
要实现得自己约定 `--hidden` 参数。而且桌宠窗口用的是 `showInactive()`——
**不抢焦点**；「上次是不是可见」本来也记在 `settings.visible` 里。
**代价：** 用户没法「开机自启但启动时不弹出来」。

### 91. ⚠️ E2E 不碰注册表、不按全局键
**为什么：** 写注册表会污染跑测试的机器，而且注册表项可能指向临时路径，清理不掉；
按全局键会抢走别的软件的键，测试机上正在跑的东西会中招。
**代价：** 这两项只能人工验证。

### 92. 总音量走**渲染层主增益**，不动 TTS 的 `vol` 参数
**为什么：** TTS 的缓存键里含 `vol`——用它当音量会让用户拖一次滑块就多一份缓存文件。
而且现状里语音是直连 `ac.destination` 的，**绕过了主增益**，
所以「提示音有音量控制、桌宠说话没有」——那是要补的缺口，不是设计。
**代价：** 无。
```

> 编号从 86 起接着上一节的 85（`docs/decisions.md` 目前的最大编号）。

- [ ] **Step 2: 更新 README 的已知限制**

在 `README.md` 的「已知限制」一节里补三条（若该节已有同类条目，合并进去）：

```markdown
- ⚠️ **全局快捷键与开机自启无法自动化验证**：E2E 不写注册表、不按全局键
  （会污染测试机），这两项只能人工验证。
- ⚠️ **停靠状态不支持每屏独立配置**：停靠边是一个全局值。
- ⚠️ **语音原先不受音量控制**：现状是提示音有音量、桌宠说话没有，
  本次把语音接进了主增益——但依赖第三方 TTS 返回的音频本身。
```

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 4: 人工验证清单**

按下面四条**手动**走一遍（自动化覆盖不到的部分）：

1. **开机自启**：在设置里勾上「开机自启」→ 打开「任务管理器 → 启动」→
   确认有本应用 → 注销重登 → 桌宠自动出现。
2. **快捷键**：在设置里点「重新录制」→ 按 `Ctrl+Alt+K` → 显示「已生效」→
   最小化所有窗口 → 按 `Ctrl+Alt+K` → 桌宠出现/消失。
3. **快捷键冲突**：录制一个已被别的程序占用的组合（如 `Ctrl+Alt+Delete`）→
   提示「已被其他程序占用」，且原来的组合仍然能用。
4. **穿透 + 停靠同时开**：两个开关都打开 → 桌宠既点不到也只露一条边 →
   用快捷键唤回 → 桌宠完整出现。

- [ ] **Step 5: 提交**

```bash
git add docs/decisions.md README.md
git commit -m "docs: 记录第六部分的裁决与已知限制"
```

---

## 附：任务依赖图

```
Task 1（设置 schema）
  └─→ Task 4（system.js + 开机自启）
        ├─→ Task 5（全局快捷键）
        ├─→ Task 6（穿透模式 + 菜单）
        └─→ Task 7（停靠接进拖拽）← 依赖 Task 2
Task 2（edgeDock 纯几何）──→ Task 7
Task 3（总音量）──→ Task 9（设置窗口音量滑块）
Task 5 + Task 6 ──→ Task 8（设置窗口「系统」分区）
全部 ──→ Task 10（收尾）
```

Task 1、2、3 互不依赖，可以并行。Task 4 是主干。
