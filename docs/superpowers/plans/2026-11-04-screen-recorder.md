# 录屏插件（screen-recorder）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给桌宠加一个录屏插件：全屏/选区/窗口三种录制方式，可录麦克风与扬声器，输出 MP4 或 GIF，存放目录可配。

**Architecture:** 插件是 `plugins/screen-recorder/` 下的一个目录，宿主照旧扫目录加载，**宿主代码一行不改**。插件跑在主进程里，自建四个窗口：隐藏的捕获页（取流 + 编码）、全屏遮罩（选区）、悬浮控制条（计时 + 停止）、工作台（设置 + 快捷键）。纯逻辑（配置、命名、页面拼装、GIF 编码、坐标换算）拆成独立模块，能用 `node --test` 单独测。

**Tech Stack:** Electron 45.1.0（`desktopCapturer` / `session.setDisplayMediaRequestHandler` / `MediaRecorder` / `canvas.captureStream` / `globalShortcut`）、纯 JS GIF89a 编码器（不引新依赖）、Node ≥ 20、node:test、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-04-screen-recorder-design.md`

## Global Constraints

以下每一条都**逐字来自规格**，每个任务都默认遵守：

- **不新增任何 npm 依赖**——GIF 编码器自己写。
- **宿主不改一行代码**（`src/` 下一个字都不动），插件靠 `import { … } from 'electron'` 自力更生。
- 插件目录名 = 清单 `id` = `screen-recorder`；id 只能有小写字母、数字、连字符。
- 插件的渲染层页面用 `file://` 加载（`BrowserWindow.loadFile`）→ **页面里的脚本必须是经典脚本**（`<script src>`，挂 `globalThis`），**不能用 ES module 的 `import`**（`file://` 下会被 CORS 拦掉）。主进程侧的模块是普通 ESM。
- 渲染层能用的纯逻辑只有两个文件：`web/geometry.js`、`web/gif.js`。它们**既能被浏览器当经典脚本加载，也能被 node 测试加载**——测试用 `node:vm` 在新上下文里执行文件，取 `globalThis` 上的导出。
- 坐标有**两套**：显示器 `bounds` 是 DIP（逻辑像素），截图与捕获轨是物理像素。换算必须过 `web/geometry.js`。
- 默认输出目录 = `app.getPath('videos')`（Windows 里显示为「视频」）。配置里存空串表示「用默认」。
- 文件名格式：`录屏_YYYYMMDD_HHMMSS.<ext>`，重名自动加 `_2`。
- **GIF 没有音频**（格式不支持），界面上必须写明。
- 系统声音（`audio: 'loopback'`）**只有 Windows 支持**；别的平台要把「扬声器」置灰并说明原因。
- 配置存 `userData/screen-recorder.json`，**原子写**（先写 `.tmp` 再 `rename`）。
- 注释、文档、界面文案一律中文，且解释「为什么」而不只是「是什么」。
- 单元测试：`node --test test/unit/<名字>.test.js`；e2e：`npx playwright test test/e2e/screen-recorder.spec.js`。
- e2e 用临时 userData（`DESK_PET_USER_DATA` 环境变量指向 `.tmp-e2e-recorder`），测完删掉。
- **退出时必须销毁自建的窗口**：Electron 正常的 `app.quit()` 流程遇到还有窗口活着会卡住退不出去（宿主在 `src/main/plugins/window.js` 的 `destroyAll` 注释里写过这个坑）。

## Review Focus

规格是愿景文档，它没写到的输入不等于可以忽略。下面五条是最可能真的咬到人的，每条都指到拥有那段代码的任务里、由那个任务自己的测试钉住：

1. **遮罩没关就开录** → 遮罩被录进画面。必须先销毁遮罩窗口再取流。（Task 6）
2. **Windows 缩放 150%/200%** → 选区录出来是歪的、位置不对。（Task 3）
3. **这台机器没有麦克风 / 用户不给权限** → 必须给出明确提示（「没有找到麦克风」），不能静默录不到声音。（Task 5）
4. **被录的窗口中途被关掉** → 应该自动停止并保存已有内容，而不是整个程序卡住。（Task 4）
5. **退出时自建窗口还活着** → `app.quit()` 卡住，程序退不出去。（Task 8）

## 文件结构

```text
plugins/screen-recorder/
  plugin.json            清单
  main.js                入口（主进程）：组装配置、页面、录制会话、窗口、IPC
  lib/                   只在主进程跑（普通 ESM）
    config.js            配置读写与规整
    naming.js            文件名与去重
    page.js              面板页面拼装
    capture.js           录制会话（状态机、取流编排、落盘）
    windows.js           四个自建窗口
    hotkey.js            快捷键注册与注销
    ipc.js               插件自己的 IPC 路由
  web/                   渲染层与主进程共用（经典脚本）
    geometry.js          坐标换算
    gif.js               GIF89a 编码器
  pages/
    recorder.html/js     隐藏捕获页
    picker.html/js       全屏遮罩
    control.html/js      悬浮控制条
    workbench.html/js    工作台
  preload/rec.cjs        这些页面的桥

test/unit/screen-recorder-*.test.js
test/e2e/screen-recorder.spec.js
test/e2e/helpers/mp4.js  解析 mp4 的轨道类型与画面尺寸
```

---

### Task 1: 插件骨架、配置读写与面板页面

**Files:**
- Create: `plugins/screen-recorder/plugin.json`
- Create: `plugins/screen-recorder/lib/config.js`
- Create: `plugins/screen-recorder/lib/naming.js`
- Create: `plugins/screen-recorder/lib/page.js`
- Create: `plugins/screen-recorder/main.js`
- Create: `test/unit/screen-recorder-config.test.js`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `lib/config.js`：`DEFAULT_CONFIG`、`MODES`、`FORMATS`、`normalizeConfig(raw) → object`、`readConfig(userDataDir) → Promise<object>`、`writeConfig(userDataDir, config) → Promise<object>`、`configPath(userDataDir) → string`
  - `lib/naming.js`：`recordingFileName(date, ext) → string`、`uniquePath(dir, fileName) → Promise<string>`
  - `lib/page.js`：`buildPanelPage(ui, data) → object`，`data = { config, targets, recording, status }`
  - `main.js`：默认导出 `createScreenRecorderPlugin(ctx)`，返回 `{ page, action }`

- [ ] **Step 1: 写失败的测试（配置与命名）**

```js
// test/unit/screen-recorder-config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  MODES,
  FORMATS,
  configPath,
  normalizeConfig,
  readConfig,
  writeConfig,
} from '../../plugins/screen-recorder/lib/config.js';
import { recordingFileName, uniquePath } from '../../plugins/screen-recorder/lib/naming.js';

test('规整后的配置：认得的字段留下，认不出的退回默认', () => {
  const c = normalizeConfig({
    mode: 'region',
    format: 'gif',
    mic: 'yes',
    speaker: false,
    fps: 999,
    gifWidth: 10,
    gifFps: 60,
    hotkey: '  Control+Shift+R  ',
    outputDir: 123,
  });
  assert.equal(c.mode, 'region');
  assert.equal(c.format, 'gif');
  assert.equal(c.mic, true, '真值都当开');
  assert.equal(c.speaker, false);
  assert.equal(c.fps, 60, '帧率夹到上限 60');
  assert.equal(c.gifWidth, 160, 'GIF 宽度夹到下限 160');
  assert.equal(c.gifFps, 30, 'GIF 帧率夹到上限 30');
  assert.equal(c.hotkey, 'Control+Shift+R', '快捷键两边空白去掉');
  assert.equal(c.outputDir, '', '不是字符串就当没设');
});

test('认不出的模式与格式退回默认', () => {
  const c = normalizeConfig({ mode: '投影仪', format: 'avi' });
  assert.ok(MODES.includes(c.mode));
  assert.ok(FORMATS.includes(c.format));
  assert.equal(c.mode, DEFAULT_CONFIG.mode);
  assert.equal(c.format, DEFAULT_CONFIG.format);
});

test('配置读写往返：写完再读回来一模一样', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    const saved = await writeConfig(dir, { mode: 'window', mic: true, outputDir: 'D:\\录屏' });
    assert.equal(saved.mode, 'window');
    const raw = JSON.parse(await readFile(configPath(dir), 'utf8'));
    assert.equal(raw.mode, 'window');
    assert.equal(raw.mic, true);
    const back = await readConfig(dir);
    assert.equal(back.outputDir, 'D:\\录屏');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置读不到时退回默认值，不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    await writeFile(configPath(dir), '{ 这不是 JSON', 'utf8');
    const c = await readConfig(dir);
    assert.equal(c.mode, DEFAULT_CONFIG.mode);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写不留临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    await writeConfig(dir, { mode: 'screen' });
    const raw = await readFile(configPath(dir), 'utf8');
    assert.ok(!raw.includes('.tmp'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件名：录屏_年月日_时分秒', () => {
  const d = new Date(2026, 10, 4, 23, 15, 30);
  assert.equal(recordingFileName(d, 'mp4'), '录屏_20261104_231530.mp4');
  assert.equal(recordingFileName(d, 'gif'), '录屏_20261104_231530.gif');
});

test('重名时自动加 _2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    const name = recordingFileName(new Date(2026, 10, 4, 23, 15, 30), 'mp4');
    const first = await uniquePath(dir, name);
    assert.equal(first, join(dir, name));
    await writeFile(first, 'x');
    const second = await uniquePath(dir, name);
    assert.equal(second, join(dir, '录屏_20261104_231530_2.mp4'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/screen-recorder-config.test.js`
Expected: FAIL —— `Cannot find module '../../plugins/screen-recorder/lib/config.js'`

- [ ] **Step 3: 写 `lib/config.js`**

```js
// plugins/screen-recorder/lib/config.js
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 录屏插件的配置。
 *
 * 配置存在 userData/screen-recorder.json——**不放插件目录里**：
 * 插件目录在安装目录下，多半没有写权限。
 *
 * 写盘是**原子**的（先写 .tmp 再 rename）：普通 writeFile 会先把目标截断成
 * 0 字节，写到一半被强杀就留下一个空文件，下次启动配置全丢。
 */

/** 默认值。outputDir 为空串 = 用系统的「视频」文件夹。 */
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'screen', // screen | region | window
  format: 'video', // video | gif
  mic: false,
  speaker: true,
  outputDir: '',
  sourceId: '',
  hotkey: 'Control+Shift+R',
  fps: 30,
  gifWidth: 480,
  gifFps: 12,
});

export const MODES = Object.freeze(['screen', 'region', 'window']);
export const FORMATS = Object.freeze(['video', 'gif']);

/** 配置文件的位置。 */
export function configPath(userDataDir) {
  return join(userDataDir, 'screen-recorder.json');
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 规整一份配置。
 *
 * 配置是**磁盘上的文件**，用户（或手滑的程序）写什么都不奇怪：
 * 认不出的值一律退回默认，而不是照着坏值往下跑。
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const c = { ...DEFAULT_CONFIG, ...source };
  if (!MODES.includes(c.mode)) c.mode = DEFAULT_CONFIG.mode;
  if (!FORMATS.includes(c.format)) c.format = DEFAULT_CONFIG.format;
  c.mic = Boolean(c.mic);
  c.speaker = Boolean(c.speaker);
  c.outputDir = typeof c.outputDir === 'string' ? c.outputDir : '';
  c.sourceId = typeof c.sourceId === 'string' ? c.sourceId : '';
  c.hotkey = typeof c.hotkey === 'string' ? c.hotkey.trim() : DEFAULT_CONFIG.hotkey;
  c.fps = clampInt(c.fps, 5, 60, DEFAULT_CONFIG.fps);
  c.gifWidth = clampInt(c.gifWidth, 160, 1920, DEFAULT_CONFIG.gifWidth);
  c.gifFps = clampInt(c.gifFps, 5, 30, DEFAULT_CONFIG.gifFps);
  return c;
}

/** 读配置；读不到或读坏了都退回默认。 */
export async function readConfig(userDataDir) {
  try {
    const text = await readFile(configPath(userDataDir), 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[录屏] 配置读不了，用默认值：', err?.message);
    }
    return normalizeConfig({});
  }
}

/** 写配置（原子）。 */
export async function writeConfig(userDataDir, config) {
  const value = normalizeConfig(config);
  await mkdir(userDataDir, { recursive: true });
  const target = configPath(userDataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return value;
}
```

- [ ] **Step 4: 写 `lib/naming.js`**

```js
// plugins/screen-recorder/lib/naming.js
import { access } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 录制文件的名字。
 *
 * 名字里带日期时间：一天录好几段时，光看「录屏.mp4」根本分不清。
 */
export function recordingFileName(date, ext) {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `录屏_${y}${mo}${d}_${h}${mi}${s}.${ext}`;
}

/**
 * 找一个不重名的路径。
 *
 * 同一秒里录两次（或用户开着「同名覆盖」）都会撞名：
 * 撞了就加 _2、_3……
 */
export async function uniquePath(dir, fileName) {
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  let candidate = join(dir, fileName);
  let n = 2;
  // eslint-disable-next-line no-await-in-loop -- 一次只查一个候选，串行才对
  while (await exists(candidate)) {
    candidate = join(dir, `${base}_${n}${ext}`);
    n += 1;
  }
  return candidate;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node --test test/unit/screen-recorder-config.test.js`
Expected: PASS —— 6 个用例全过

- [ ] **Step 6: 写清单、页面拼装与入口**

`plugins/screen-recorder/plugin.json`：

```json
{
  "id": "screen-recorder",
  "name": "录屏",
  "icon": "🎥",
  "description": "全屏、选区、窗口录制，输出视频或 GIF",
  "keywords": ["录屏", "屏幕", "录像", "录制", "luping", "screen", "record", "gif"],
  "entry": "main.js"
}
```

> 清单里**故意不写 `window` / `widget` 段**：宿主那套「一个插件一个窗口、两种形态互斥」的机制用不上（工作台与控制条要同时开着），写了只会在面板上多出两个用不上的按钮。

`plugins/screen-recorder/lib/page.js`：

```js
// plugins/screen-recorder/lib/page.js

/**
 * 面板页面的拼装。
 *
 * 插件界面是**无状态**的：动作 → 重算一次页面 → 新的页面。
 * 这样只有一份「我现在长什么样」的代码，不会出现「改了数据但界面没跟着变」。
 */

export const MODE_LABELS = Object.freeze({ screen: '全屏', region: '选区', window: '窗口' });

/** 模式按钮：当前模式前面加个 ●，其余是 ○。 */
function modeButtons(ui, mode) {
  return ui.buttonsBlock(
    Object.keys(MODE_LABELS).map((key) => ({
      id: `mode:${key}`,
      label: `${mode === key ? '●' : '○'} ${MODE_LABELS[key]}`,
    }))
  );
}

/**
 * 拼出面板页面。
 *
 * @param {object} ui 宿主给的界面积木（ctx.ui）
 * @param {object} data
 * @param {object} data.config 当前配置
 * @param {Array<{id:string,label:string,hint?:string}>} data.targets 可录的目标（显示器/窗口）
 * @param {boolean} data.recording 正在录吗
 * @param {string} data.status 底部那行提示
 */
export function buildPanelPage(ui, data) {
  const { config, targets = [], recording = false, status = '' } = data;
  const blocks = [];

  blocks.push(modeButtons(ui, config.mode));

  if (targets.length) {
    blocks.push(ui.listBlock(targets.map((t) => ({ id: t.id, label: t.label, hint: t.hint || '' }))));
  }

  blocks.push(ui.toggleBlock('mic', '录制麦克风', config.mic));
  blocks.push(ui.toggleBlock('speaker', '录制扬声器', config.speaker));

  blocks.push(
    ui.buttonsBlock([
      { id: 'format:video', label: `${config.format === 'video' ? '●' : '○'} 视频` },
      { id: 'format:gif', label: `${config.format === 'gif' ? '●' : '○'} GIF` },
    ])
  );

  blocks.push(ui.inputBlock('outputDir', '输出目录（留空＝视频文件夹）', '保存', config.outputDir));

  blocks.push(
    ui.buttonsBlock([
      { id: 'pick-dir', label: '浏览…' },
      { id: 'open-workbench', label: '设置…' },
    ])
  );

  blocks.push(
    ui.buttonsBlock([
      recording
        ? { id: 'stop', label: '停止录制', primary: true }
        : { id: 'start', label: '开始录制', primary: true },
    ])
  );

  return ui.makePage({
    pluginId: 'screen-recorder',
    title: '录屏',
    subtitle: recording ? '正在录制' : MODE_LABELS[config.mode],
    status,
    blocks,
  });
}
```

`plugins/screen-recorder/main.js`：

```js
// plugins/screen-recorder/main.js
import { app, dialog } from 'electron';
import { readConfig, writeConfig, normalizeConfig } from './lib/config.js';
import { buildPanelPage } from './lib/page.js';

/**
 * 录屏插件。
 *
 * 插件跑在**主进程**里（宿主用动态 import 加载它），所以 electron 的 API
 * 直接就能用——这里没有沙箱，插件与宿主之间靠的是约定，不是权限边界。
 */
export default function createScreenRecorderPlugin(ctx) {
  /** 配置只在第一次用时读盘，之后走缓存。 */
  let config = null;
  /** 底部那行提示：做完某个动作的结果。 */
  let status = '';
  /** 可录的目标（显示器/窗口），随模式变。 */
  let targets = [];
  let recording = false;

  async function ensureConfig() {
    if (!config) config = await readConfig(app.getPath('userData'));
    return config;
  }

  async function save(next) {
    config = await writeConfig(app.getPath('userData'), { ...(await ensureConfig()), ...next });
    return config;
  }

  /** 面板页面。 */
  async function page() {
    const cfg = await ensureConfig();
    return buildPanelPage(ctx.ui, { config: cfg, targets, recording, status });
  }

  /** 面板里的一个动作。 */
  async function action(currentCtx, actionId, value) {
    const cfg = await ensureConfig();
    if (actionId.startsWith('mode:')) {
      const mode = actionId.slice('mode:'.length);
      await save({ mode });
      targets = [];
      status = '';
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
    } else if (actionId === 'pick-dir') {
      const picked = await pickDirectory();
      if (picked) {
        await save({ outputDir: picked });
        status = `输出目录：${picked}`;
      }
    } else {
      // 「开始录制」「停止录制」「设置…」在后面的任务里接上。
      status = '';
    }
    return page();
  }

  /** 选输出目录：原生对话框。 */
  async function pickDirectory() {
    const result = await dialog.showOpenDialog({
      title: '录屏文件放哪儿',
      defaultPath: (await ensureConfig()).outputDir || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return '';
    return result.filePaths[0];
  }

  return { page, action };
}
```

- [ ] **Step 7: 手动确认插件能被宿主认出来**

Run: `npm start` → 左键点桌宠 → 搜「录屏」→ 打开
Expected: 页面出现三个模式按钮、两个声音开关、格式按钮、输出目录输入框、浏览/设置按钮、开始录制按钮；点「选区」「GIF」再打开，模式与格式保持住了。

- [ ] **Step 8: 提交**

```bash
git add plugins/screen-recorder test/unit/screen-recorder-config.test.js
git commit -m "feat(录屏): 插件骨架、配置读写与面板页面"
```

---

### Task 2: GIF89a 编码器

**Files:**
- Create: `plugins/screen-recorder/web/gif.js`
- Create: `test/unit/screen-recorder-gif.test.js`
- Create: `test/unit/helpers/load-web-script.js`

**Interfaces:**
- Consumes: 无
- Produces: `web/gif.js` 挂 `globalThis.ScreenRecorderGif = { GifEncoder }`；`new GifEncoder({ width, height, loop, maxColors })`；`addFrame(rgba: Uint8Array, delayMs: number) → Uint8Array`；`bytes() → Uint8Array`（头 + 所有帧 + 结尾）。
  - `rgba` 是**一整帧**的像素，长度 = width × height × 4。
  - `addFrame` 返回这一帧自己的字节（便于增量落盘），`bytes()` 返回完整文件。

- [ ] **Step 1: 写测试用的加载器**

```js
// test/unit/helpers/load-web-script.js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 加载一个**经典脚本**（渲染层用的那种）。
 *
 * 插件的页面走 file://，ES module 的 import 会被 CORS 拦掉，
 * 所以 web/ 下的脚本是经典脚本：挂到 globalThis 上，而不是 export。
 * 单元测试要在 node 里跑它们，就用 vm 在一个新上下文里执行文件，
 * 再从那个上下文的 globalThis 上取导出。
 *
 * 放在 vm 的新上下文里（而不是 eval 到当前上下文）是有意的：
 * 脚本里的 globalThis 应该是「它自己那个世界的 globalThis」，
 * 不该碰到测试进程的。
 */
export async function loadWebScript(relativePath) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = await readFile(path, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: path });
  return sandbox;
}
```

- [ ] **Step 2: 写失败的测试**

```js
// test/unit/screen-recorder-gif.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebScript } from './helpers/load-web-script.js';

const { ScreenRecorderGif } = await loadWebScript('../../plugins/screen-recorder/web/gif.js');

/** 造一帧纯色像素。 */
function solidFrame(width, height, r, g, b) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * 解一段 LZW 数据，返回索引序列。
 *
 * 这是**测试自己写的解码器**：编码器与解码器互相印证，
 * 才能发现「LZW 写反了」「码宽提前变了」这类结构性错误。
 */
function lzwDecode(bytes, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const dict = [];
  const reset = () => {
    dict.length = 0;
    for (let i = 0; i < clear; i += 1) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
  };
  reset();
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let bitPos = 0;
  const out = [];
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = bytes[bitPos >> 3];
      if (byte === undefined) return eoi;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }
    return code;
  };
  let prev = null;
  for (;;) {
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) {
      reset();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = null;
      continue;
    }
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error(`LZW 解码失败：码 ${code} 越界`);
    out.push(...entry);
    if (prev) {
      dict[next] = [...prev, entry[0]];
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  return out;
}

/** 把 GIF 的字节拆成：头、逻辑屏、每帧的（延时、尺寸、像素）。 */
function parseGif(bytes) {
  const text = (from, len) => String.fromCharCode(...bytes.slice(from, from + len));
  assert.equal(text(0, 6), 'GIF89a', '文件头得是 GIF89a');
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  let pos = 13;
  const frames = [];
  for (;;) {
    const marker = bytes[pos];
    if (marker === 0x3b) {
      pos += 1;
      break;
    }
    if (marker === 0x21) {
      // 扩展块：跳过，直到块结束
      pos += 2;
      while (bytes[pos] !== 0) pos += 1 + bytes[pos];
      pos += 1;
      continue;
    }
    if (marker === 0x2c) {
      const frameWidth = bytes[pos + 5] | (bytes[pos + 6] << 8);
      const frameHeight = bytes[pos + 7] | (bytes[pos + 8] << 8);
      const packed = bytes[pos + 9];
      let cursor = pos + 10;
      let palette = [];
      if (packed & 0x80) {
        const size = 2 ** ((packed & 0x07) + 1);
        palette = [];
        for (let i = 0; i < size; i += 1) {
          palette.push([bytes[cursor], bytes[cursor + 1], bytes[cursor + 2]]);
          cursor += 3;
        }
      }
      const minCodeSize = bytes[cursor];
      cursor += 1;
      const data = [];
      while (bytes[cursor] !== 0) {
        const len = bytes[cursor];
        for (let i = 1; i <= len; i += 1) data.push(bytes[cursor + i]);
        cursor += 1 + len;
      }
      frames.push({ width: frameWidth, height: frameHeight, palette, pixels: lzwDecode(data, minCodeSize) });
      pos = cursor + 1;
      continue;
    }
    throw new Error(`没见过的块标记 0x${marker.toString(16)}（位置 ${pos}）`);
  }
  return { width, height, frames, tail: bytes.slice(pos) };
}

test('编码出来的 GIF 结构完整：头、尺寸、结尾', () => {
  const enc = new ScreenRecorderGif.GifEncoder({ width: 4, height: 2 });
  enc.addFrame(solidFrame(4, 2, 255, 0, 0), 100);
  const bytes = enc.bytes();
  const parsed = parseGif(bytes);
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.frames.length, 1);
  assert.equal(bytes[bytes.length - 1], 0x3b, '结尾得是 0x3B');
  assert.equal(parsed.tail.length, 0, '结尾之后没有别的');
});

test('像素能原样回来：红色就是红色', () => {
  const enc = new ScreenRecorderGif.GifEncoder({ width: 4, height: 2 });
  enc.addFrame(solidFrame(4, 2, 255, 0, 0), 100);
  const parsed = parseGif(enc.bytes());
  const frame = parsed.frames[0];
  assert.equal(frame.pixels.length, 8, '4×2 = 8 个像素');
  for (const index of frame.pixels) {
    assert.deepEqual(frame.palette[index], [255, 0, 0]);
  }
});

test('多帧各自带自己的延时与颜色', () => {
  const enc = new ScreenRecorderGif.GifEncoder({ width: 2, height: 1 });
  enc.addFrame(solidFrame(2, 1, 255, 0, 0), 100);
  enc.addFrame(solidFrame(2, 1, 0, 0, 255), 250);
  const parsed = parseGif(enc.bytes());
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(parsed.frames[0].palette[parsed.frames[0].pixels[0]], [255, 0, 0]);
  assert.deepEqual(parsed.frames[1].palette[parsed.frames[1].pixels[0]], [0, 0, 255]);
});

test('颜色多于 256 种时会被量化，但像素仍然是那些颜色里的', () => {
  const width = 32;
  const height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = i % 256;
    rgba[i + 1] = (i * 3) % 256;
    rgba[i + 2] = (i * 7) % 256;
    rgba[i + 3] = 255;
  }
  const enc = new ScreenRecorderGif.GifEncoder({ width, height });
  enc.addFrame(rgba, 100);
  const parsed = parseGif(enc.bytes());
  const frame = parsed.frames[0];
  assert.ok(frame.palette.length <= 256, '调色板不超过 256 色');
  assert.equal(frame.palette.length, 2 ** Math.round(Math.log2(frame.palette.length)), '颜色表大小得是 2 的幂');
  assert.equal(frame.pixels.length, width * height);
  for (const index of frame.pixels) {
    assert.ok(index < frame.palette.length, '索引不能越界');
  }
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `node --test test/unit/screen-recorder-gif.test.js`
Expected: FAIL —— `Cannot find module '../../plugins/screen-recorder/web/gif.js'`

- [ ] **Step 4: 写 `web/gif.js`**

```js
// plugins/screen-recorder/web/gif.js
/**
 * GIF89a 编码器。
 *
 * 这个文件是**经典脚本**：渲染层页面用 `<script src>` 加载它。
 * 插件的页面走 file://，ES module 的 import 会被 CORS 拦掉，
 * 所以这里挂到 globalThis 上，而不是 export。
 *
 * MediaRecorder 产不出 GIF，所以这一路是**完全独立**的编码：
 * 逐帧取像素 → median cut 量化 → 索引 → LZW → GIF 的块结构。
 */
(function () {
  const MAGIC = 'GIF89a';

  function pushU16(bytes, value) {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  function pushString(bytes, text) {
    for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i));
  }

  /** 一个盒子：一批颜色，以及它们在三个通道上的取值范围。 */
  function makeBox(colors) {
    let rMin = 255;
    let rMax = 0;
    let gMin = 255;
    let gMax = 0;
    let bMin = 255;
    let bMax = 0;
    for (const c of colors) {
      const r = (c >> 16) & 0xff;
      const g = (c >> 8) & 0xff;
      const b = c & 0xff;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    return { colors, rMin, rMax, gMin, gMax, bMin, bMax };
  }

  function boxRange(box) {
    return Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
  }

  /** 沿范围最大的通道对半切。 */
  function splitBox(box) {
    const dr = box.rMax - box.rMin;
    const dg = box.gMax - box.gMin;
    const db = box.bMax - box.bMin;
    const shift = dr >= dg && dr >= db ? 16 : dg >= db ? 8 : 0;
    const sorted = box.colors.slice().sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    const mid = sorted.length >> 1;
    return [makeBox(sorted.slice(0, mid)), makeBox(sorted.slice(mid))];
  }

  function averageColor(colors) {
    if (!colors.length) return 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of colors) {
      r += (c >> 16) & 0xff;
      g += (c >> 8) & 0xff;
      b += c & 0xff;
    }
    const n = colors.length;
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
  }

  /**
   * 量化：把一帧的像素压到不超过 maxColors 种颜色。
   *
   * 颜色数不多时原样保留；多了才做 median cut。
   */
  function quantize(rgba, maxColors) {
    const unique = new Set();
    for (let i = 0; i < rgba.length; i += 4) {
      unique.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    }
    let colors = Array.from(unique);
    if (colors.length > maxColors) {
      const boxes = [makeBox(colors)];
      while (boxes.length < maxColors) {
        boxes.sort((a, b) => boxRange(b) - boxRange(a));
        const box = boxes.shift();
        if (!box || box.colors.length < 2 || boxRange(box) === 0) break;
        const [left, right] = splitBox(box);
        boxes.push(left, right);
      }
      colors = boxes.map((b) => averageColor(b.colors)).filter((c) => c !== null);
    }
    // GIF 的颜色表大小必须是 2 的幂，且至少 2 项。
    let bits = 1;
    while (1 << bits < colors.length) bits += 1;
    const tableSize = Math.min(256, 1 << bits);
    const palette = colors.slice(0, tableSize);
    while (palette.length < tableSize) palette.push(0);
    return { palette, tableSize };
  }

  /**
   * 把像素映射成调色板索引。
   *
   * **必须带缓存**：每帧 23 万个像素 × 256 色线性查找，单帧要 200ms 以上，
   * 逐帧编码直接卡死。缓存命中后是 O(1)。
   */
  function mapIndices(rgba, palette) {
    const cache = new Map();
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

  /**
   * GIF 的变长 LZW 编码。
   *
   * 与 PNG 的 LZW 不同：码宽从最小码长 + 1 起，涨到 12 位；
   * 码表满了要发一个 clear 码重新开始。
   */
  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let table = new Map();
    const out = [];
    let bitBuffer = 0;
    let bitCount = 0;

    const emit = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        out.push(bitBuffer & 0xff);
        bitBuffer >>= 8;
        bitCount -= 8;
      }
    };

    emit(clearCode);
    if (!indices.length) {
      emit(eoiCode);
      if (bitCount > 0) out.push(bitBuffer & 0xff);
      return out;
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const k = indices[i];
      const key = prefix * 4096 + k;
      const found = table.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (nextCode < 4096) {
        table.set(key, nextCode);
        nextCode += 1;
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      } else {
        emit(clearCode);
        table = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bitCount > 0) out.push(bitBuffer & 0xff);
    return out;
  }

  /**
   * 一个 GIF 编码器。
   *
   * 帧是**逐个加**进去的：每一帧自己编码成字节就存起来，
   * 不把原始像素留在内存里（480×360×4 = 691KB/帧，攒一分钟就是几百 MB）。
   */
  class GifEncoder {
    constructor({ width, height, loop = 0, maxColors = 256 } = {}) {
      this.width = Math.max(1, Math.round(width));
      this.height = Math.max(1, Math.round(height));
      this.loop = loop;
      this.maxColors = maxColors;
      this.frames = [];

      const head = [];
      pushString(head, MAGIC);
      pushU16(head, this.width);
      pushU16(head, this.height);
      // 有全局颜色表（2 项占位）、色深 8 位、背景色 0、宽高比 0
      head.push(0xf0, 0x00, 0x00);
      head.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
      // Netscape 循环扩展
      head.push(0x21, 0xff, 0x0b);
      pushString(head, 'NETSCAPE2.0');
      head.push(0x03, 0x01);
      pushU16(head, loop);
      head.push(0x00);
      this.head = head;
    }

    /**
     * 加一帧。
     *
     * @param {Uint8Array} rgba 一整帧的像素（width×height×4）
     * @param {number} delayMs 这一帧显示多久
     * @returns {Uint8Array} 这一帧自己的字节
     */
    addFrame(rgba, delayMs) {
      const { palette, tableSize } = quantize(rgba, this.maxColors);
      const indices = mapIndices(rgba, palette);
      const bits = Math.max(1, Math.round(Math.log2(tableSize)));
      const minCodeSize = Math.max(2, bits);

      const bytes = [];
      // 图形控制扩展：disposal=1（不处理）、不透明、延时（1/100 秒）
      bytes.push(0x21, 0xf9, 0x04, 0x04);
      pushU16(bytes, Math.max(1, Math.round((delayMs || 100) / 10)));
      bytes.push(0x00, 0x00);
      // 图像描述：局部颜色表、尺寸
      bytes.push(0x2c);
      pushU16(bytes, 0);
      pushU16(bytes, 0);
      pushU16(bytes, this.width);
      pushU16(bytes, this.height);
      bytes.push(0x80 | (bits - 1));
      for (const c of palette) bytes.push((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
      for (let i = palette.length; i < tableSize; i += 1) bytes.push(0x00, 0x00, 0x00);
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

    /** 完整的 GIF 文件字节。 */
    bytes() {
      const total = this.head.length + this.frames.reduce((n, f) => n + f.length, 0) + 1;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const b of this.head) {
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

  globalThis.ScreenRecorderGif = { GifEncoder };
})();
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node --test test/unit/screen-recorder-gif.test.js`
Expected: PASS —— 4 个用例全过

- [ ] **Step 6: 用 ffmpeg 验一次真解码（手工核对，不进 CI）**

```bash
node -e "
const { readFile, writeFile } = require('node:fs/promises');
const vm = require('node:vm');
const src = require('node:fs').readFileSync('plugins/screen-recorder/web/gif.js','utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { GifEncoder } = sandbox.ScreenRecorderGif;
const w = 64, h = 48;
const enc = new GifEncoder({ width: w, height: h });
for (let f = 0; f < 3; f++) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i + f * 40) % 256; rgba[i+1] = (i * 2) % 256; rgba[i+2] = (i * 3) % 256; rgba[i+3] = 255;
  }
  enc.addFrame(rgba, 120);
}
writeFileSync('.tmp-gif-check.gif', Buffer.from(enc.bytes()));
"
ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames -of default=noprint_wrappers=1 .tmp-gif-check.gif
```

Expected: `codec_name=gif`、`width=64`、`height=48`、`nb_frames=3`。
如果 ffprobe 报错说 GIF 头不对或帧数不对，**先别提交**——LZW 或块结构有问题。

- [ ] **Step 7: 提交**

```bash
git add plugins/screen-recorder/web/gif.js test/unit/screen-recorder-gif.test.js test/unit/helpers/load-web-script.js
git commit -m "feat(录屏): GIF89a 编码器（量化 + 变长 LZW，不引新依赖）"
```

---

### Task 3: 坐标换算（DIP ↔ 截图物理像素 ↔ 捕获轨像素）

**Files:**
- Create: `plugins/screen-recorder/web/geometry.js`
- Create: `test/unit/screen-recorder-geometry.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `web/geometry.js` 挂 `globalThis.ScreenRecorderGeometry`：
  - `normalizeRect(start, end) → {x, y, width, height}`：拖拽起止点归一化成矩形（CSS 空间）
  - `scaleRect(rect, from, to) → {x, y, width, height}`：矩形从 `from` 空间换算到 `to` 空间
  - `clampRect(rect, size) → {x, y, width, height}`：把矩形夹在 `size` 边界内

- [ ] **Step 1: 写失败的测试**

```js
// test/unit/screen-recorder-geometry.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebScript } from './helpers/load-web-script.js';

const { ScreenRecorderGeometry: G } = await loadWebScript(
  '../../plugins/screen-recorder/web/geometry.js'
);

test('拖拽起止点归一化成矩形：往左往上都算数', () => {
  assert.deepEqual(G.normalizeRect({ x: 100, y: 80 }, { x: 300, y: 200 }), {
    x: 100,
    y: 80,
    width: 200,
    height: 120,
  });
  assert.deepEqual(G.normalizeRect({ x: 300, y: 200 }, { x: 100, y: 80 }), {
    x: 100,
    y: 80,
    width: 200,
    height: 120,
  });
});

test('没有拖动（起止同一点）得到空矩形', () => {
  const r = G.normalizeRect({ x: 50, y: 50 }, { x: 50, y: 50 });
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
});

test('缩放：100% 时原样，150% 时按比例放大', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(G.scaleRect(rect, { width: 800, height: 600 }, { width: 800, height: 600 }), rect);
  const scaled = G.scaleRect(rect, { width: 800, height: 600 }, { width: 1200, height: 900 });
  assert.deepEqual(scaled, { x: 15, y: 30, width: 150, height: 75 });
});

test('缩放：200% 缩放比下，CSS 坐标换算到物理像素', () => {
  // 显示器 bounds 是 DIP（1280×800），截图与捕获轨是物理像素（2560×1600）。
  const css = { x: 100, y: 50, width: 200, height: 100 };
  const dip = { width: 1280, height: 800 };
  const physical = { width: 2560, height: 1600 };
  const rect = G.scaleRect(css, dip, physical);
  assert.deepEqual(rect, { x: 200, y: 100, width: 400, height: 200 });
});

test('夹在边界内：拖出窗口的部分被切掉', () => {
  const clamped = G.clampRect({ x: -50, y: -20, width: 5000, height: 3000 }, { width: 800, height: 600 });
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.width, 800);
  assert.equal(clamped.height, 600);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/screen-recorder-geometry.test.js`
Expected: FAIL —— 找不到 `web/geometry.js`

- [ ] **Step 3: 写 `web/geometry.js`**

```js
// plugins/screen-recorder/web/geometry.js
/**
 * 坐标换算。
 *
 * 这个文件是**经典脚本**（渲染层页面用 `<script src>` 加载），
 * 挂到 globalThis 上而不是 export——插件的页面走 file://，
 * ES module 的 import 会被 CORS 拦掉。
 *
 * 这里有两套坐标，别混：
 *
 * - **DIP**（逻辑像素）：显示器 bounds、遮罩窗口的大小。
 *   Windows 缩放 150% 时，2560 宽的屏幕在 bounds 里只有 1707。
 * - **物理像素**：截图的原始尺寸、捕获轨的 videoWidth。
 *
 * 换算漏了任何一级，选区录出来就是歪的。
 */
(function () {
  function toNumber(value) {
    return Number.isFinite(value) ? value : 0;
  }

  /** 拖拽的起止点 → 矩形（宽高为正）。 */
  function normalizeRect(start, end) {
    const x1 = toNumber(start?.x);
    const y1 = toNumber(start?.y);
    const x2 = toNumber(end?.x);
    const y2 = toNumber(end?.y);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  /** 矩形从一个空间换算到另一个空间。 */
  function scaleRect(rect, from, to) {
    const fromWidth = toNumber(from?.width) || 1;
    const fromHeight = toNumber(from?.height) || 1;
    const toWidth = toNumber(to?.width) || 1;
    const toHeight = toNumber(to?.height) || 1;
    const sx = toWidth / fromWidth;
    const sy = toHeight / fromHeight;
    return {
      x: Math.round(toNumber(rect?.x) * sx),
      y: Math.round(toNumber(rect?.y) * sy),
      width: Math.round(toNumber(rect?.width) * sx),
      height: Math.round(toNumber(rect?.height) * sy),
    };
  }

  /** 把矩形夹在给定尺寸内。 */
  function clampRect(rect, size) {
    const width = toNumber(size?.width);
    const height = toNumber(size?.height);
    const x = Math.max(0, Math.min(toNumber(rect?.x), width));
    const y = Math.max(0, Math.min(toNumber(rect?.y), height));
    return {
      x,
      y,
      width: Math.max(0, Math.min(toNumber(rect?.width), width - x)),
      height: Math.max(0, Math.min(toNumber(rect?.height), height - y)),
    };
  }

  globalThis.ScreenRecorderGeometry = { normalizeRect, scaleRect, clampRect };
})();
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test test/unit/screen-recorder-geometry.test.js`
Expected: PASS —— 5 个用例全过

- [ ] **Step 5: 提交**

```bash
git add plugins/screen-recorder/web/geometry.js test/unit/screen-recorder-geometry.test.js
git commit -m "feat(录屏): 坐标换算（DIP ↔ 物理像素 ↔ 捕获轨）"
```

---

### Task 4: 全屏视频录制（无音频）

这一任务把**主进程侧**与**捕获页**一次接通：取流 → 编码 → 落盘。音频在 Task 5 加。

**Files:**
- Create: `plugins/screen-recorder/lib/windows.js`
- Create: `plugins/screen-recorder/lib/capture.js`
- Create: `plugins/screen-recorder/lib/ipc.js`
- Create: `plugins/screen-recorder/preload/rec.cjs`
- Create: `plugins/screen-recorder/pages/recorder.html`
- Create: `plugins/screen-recorder/pages/recorder.js`
- Modify: `plugins/screen-recorder/main.js`
- Create: `test/e2e/screen-recorder.spec.js`

**Interfaces:**
- Consumes: Task 1 的 `readConfig` / `writeConfig` / `buildPanelPage` / `recordingFileName` / `uniquePath`
- Produces:
  - `lib/windows.js`：`createWindows({ pluginDir, preloadPath, onMessage }) → { createCapture(), destroyCapture(), openPicker(...), showControl(), hideControl(), openWorkbench(), closeWorkbench(), isWorkbenchOpen(), destroyAll() }`
  - `lib/capture.js`：`createCaptureSession({ windows, getConfig, onState }) → { listTargets(mode), start(options), stop(), isRecording(), dispose() }`
  - `lib/ipc.js`：`registerIpc({ channel, handler }) → () => void`（注销函数）
  - `preload/rec.cjs` 暴露 `window.rec = { send(msg), invoke(msg), onMessage(cb) }`
  - 消息协议（`rec:screen-recorder:message`）：
    - 主进程 → 捕获页：`{type:'begin', payload:{ sourceId, format, fps, audio:{mic,speaker}, crop, snapshotSize }}`、`{type:'stop'}`
    - 捕获页 → 主进程：`{type:'ready'}`、`{type:'error', payload:{message}}`、`{type:'saved', payload:{bytes: ArrayBuffer, ext}}`

- [ ] **Step 1: 写 `preload/rec.cjs`**

```js
// plugins/screen-recorder/preload/rec.cjs
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 插件页面的桥。
 *
 * 只暴露「发消息给主进程」和「收主进程的消息」两件事——
 * 页面不该拿到 ipcRenderer 本体（那等于把主进程的门开着）。
 */
contextBridge.exposeInMainWorld('rec', {
  send: (message) => ipcRenderer.send('rec:screen-recorder:message', message),
  invoke: (message) => ipcRenderer.invoke('rec:screen-recorder:message', message),
  onMessage: (callback) => {
    ipcRenderer.on('rec:screen-recorder:message', (_event, message) => callback(message));
  },
});
```

- [ ] **Step 2: 写 `lib/ipc.js`**

```js
// plugins/screen-recorder/lib/ipc.js
import { ipcMain } from 'electron';

const CHANNEL = 'rec:screen-recorder:message';

/**
 * 注册插件自己的 IPC。
 *
 * 通道名带插件 id：用户要是装了第二个录屏插件，两个插件的通道不会打架。
 *
 * @param {(message: object, event: object) => any} handler
 * @returns {() => void} 注销函数
 */
export function registerIpc(handler) {
  ipcMain.on(CHANNEL, (event, message) => {
    try {
      handler(message, event);
    } catch (err) {
      console.warn('[录屏] IPC 处理出错：', err?.message);
    }
  });
  ipcMain.handle(CHANNEL, async (event, message) => {
    try {
      return await handler(message, event);
    } catch (err) {
      console.warn('[录屏] IPC 处理出错：', err?.message);
      return { ok: false, message: err?.message || String(err) };
    }
  });
  return () => {
    ipcMain.removeHandler(CHANNEL);
    ipcMain.removeAllListeners(CHANNEL);
  };
}

export { CHANNEL };
```

- [ ] **Step 3: 写 `lib/windows.js`**

```js
// plugins/screen-recorder/lib/windows.js
import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/**
 * 插件自建的四个窗口。
 *
 * 不用宿主那套「一个插件一个窗口、window 与 widget 互斥」的机制：
 * 工作台与控制条要**同时开着**（录着屏还得能改设置）。
 *
 * 页面用 file:// 加载：file:// 在 Chromium 里是 secure context，
 * navigator.mediaDevices 才能用（已实测）。
 */
export function createWindows({ pluginDir, preloadPath, onWorkbenchChanged }) {
  /** webContents.id → 窗口的角色。 */
  const roles = new Map();
  const windows = { capture: null, picker: null, control: null, workbench: null };

  function track(win, role) {
    roles.set(win.webContents.id, role);
    win.on('closed', () => {
      roles.delete(win.webContents.id);
    });
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('rec:screen-recorder:message', { type: 'hello', role });
    });
    return win;
  }

  /** 捕获页：隐藏着，真正干活的地方。 */
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
      windows.capture = null;
    });
    win.loadFile(join(pluginDir, 'pages', 'recorder.html'));
    windows.capture = track(win, 'capture');
    return win;
  }

  function destroyCapture() {
    if (windows.capture && !windows.capture.isDestroyed()) windows.capture.destroy();
    windows.capture = null;
  }

  /** 控制条：置顶的小浮窗。 */
  function showControl() {
    if (windows.control && !windows.control.isDestroyed()) {
      windows.control.focus();
      return windows.control;
    }
    const win = new BrowserWindow({
      width: 240,
      height: 64,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadFile(join(pluginDir, 'pages', 'control.html'));
    windows.control = track(win, 'control');
    return win;
  }

  function hideControl() {
    if (windows.control && !windows.control.isDestroyed()) windows.control.destroy();
    windows.control = null;
  }

  /** 工作台：设置与快捷键。 */
  function openWorkbench() {
    if (windows.workbench && !windows.workbench.isDestroyed()) {
      windows.workbench.focus();
      return windows.workbench;
    }
    const win = new BrowserWindow({
      width: 460,
      height: 560,
      title: '录屏设置',
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.loadFile(join(pluginDir, 'pages', 'workbench.html'));
    windows.workbench = track(win, 'workbench');
    return win;
  }

  function closeWorkbench() {
    if (windows.workbench && !windows.workbench.isDestroyed()) windows.workbench.destroy();
    windows.workbench = null;
  }

  function isWorkbenchOpen() {
    return Boolean(windows.workbench && !windows.workbench.isDestroyed());
  }

  /**
   * 退出前把窗口全拆掉。
   *
   * Electron 正常的 app.quit() 流程遇到还有窗口活着会**卡住**——
   * 宿主的 destroyAll() 就是为这个存在的（见 src/main/plugins/window.js）。
   */
  function destroyAll() {
    for (const key of Object.keys(windows)) {
      const win = windows[key];
      if (win && !win.isDestroyed()) win.destroy();
      windows[key] = null;
    }
    roles.clear();
  }

  return {
    createCapture,
    destroyCapture,
    captureWindow: () => windows.capture,
    showControl,
    hideControl,
    openWorkbench,
    closeWorkbench,
    isWorkbenchOpen,
    destroyAll,
    roleOf: (contentsId) => roles.get(contentsId) || '',
  };
}
```

- [ ] **Step 4: 写 `lib/capture.js`**

```js
// plugins/screen-recorder/lib/capture.js
import { desktopCapturer, session } from 'electron';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { recordingFileName, uniquePath } from './naming.js';

const PARTITION = 'persist:screen-recorder';

/**
 * 录制会话。
 *
 * 状态机只有四态：idle → starting → recording → idle。
 * 一次只录一段（再来一次就是「已经在录了」）。
 */
export function createCaptureSession({ windows, getConfig, getOutputDir, onState }) {
  let state = 'idle';
  let startedAt = 0;
  let timer = null;
  /** 本次录制要用的源 id（显示器或窗口）。 */
  let sourceId = '';
  /** 捕获窗的分区会话（handler 装在上面）。 */
  let captureSession = null;

  function isRecording() {
    return state === 'recording' || state === 'starting';
  }

  function tick() {
    onState?.({ recording: isRecording(), elapsedMs: Date.now() - startedAt });
  }

  /** 列出可录的目标。 */
  async function listTargets(mode) {
    const types = mode === 'window' ? ['window'] : ['screen'];
    const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });
    return sources
      .filter((s) => s.thumbnail.getSize().width > 0 || mode === 'window')
      .map((s) => ({
        id: s.id,
        label: s.name || s.id,
        hint: mode === 'window' ? '窗口' : '显示器',
      }));
  }

  /**
   * 装好捕获窗用的 session。
   *
   * handler 只认**这一次**选好的源：用户选哪个窗口就录哪个，
   * 不是弹一个系统的选择框（那会把桌宠的界面也列进去）。
   */
  function prepareSession() {
    if (captureSession) return captureSession;
    captureSession = session.fromPartition(PARTITION);
    captureSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
    captureSession.setPermissionCheckHandler(() => true);
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      void (async () => {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const picked = sources.find((s) => s.id === sourceId) || sources[0];
        if (!picked) {
          callback(null);
          return;
        }
        callback({ video: picked, audio: request.audioRequested ? 'loopback' : undefined });
      })();
    });
    return captureSession;
  }

  /**
   * 开始录制。
   *
   * @param {object} options
   * @param {string} options.sourceId 显示器或窗口的源 id
   * @param {'video'|'gif'} options.format
   * @param {number} options.fps
   * @param {{mic:boolean,speaker:boolean}} options.audio
   */
  async function start(options) {
    if (isRecording()) throw new Error('已经在录了');
    state = 'starting';
    startedAt = Date.now();
    sourceId = options.sourceId || '';

    prepareSession();
    const win = windows.createCapture();
    win.webContents.send('rec:screen-recorder:message', {
      type: 'begin',
      payload: {
        sourceId,
        format: options.format,
        fps: options.fps,
        audio: options.audio,
        crop: options.crop || null,
        snapshotSize: options.snapshotSize || null,
      },
    });
    state = 'recording';
    timer = setInterval(tick, 500);
    tick();
  }

  /** 停止录制：让捕获页把已经录好的部分交回来。 */
  function stop() {
    if (!isRecording()) return false;
    const win = windows.captureWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('rec:screen-recorder:message', { type: 'stop' });
    }
    return true;
  }

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
    windows.destroyCapture();
    onState?.({ recording: false, elapsedMs: 0, file: target });
    return target;
  }

  /** 出错了也要能回到 idle。 */
  function fail(message) {
    state = 'idle';
    if (timer) clearInterval(timer);
    timer = null;
    windows.hideControl();
    windows.destroyCapture();
    onState?.({ recording: false, elapsedMs: 0, error: message });
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    state = 'idle';
    if (captureSession) {
      captureSession.setDisplayMediaRequestHandler(null);
      captureSession = null;
    }
  }

  return { listTargets, start, stop, save, fail, isRecording, dispose };
}
```

- [ ] **Step 5: 写 `pages/recorder.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>录屏捕获</title>
  </head>
  <body>
    <script src="../web/geometry.js"></script>
    <script src="../web/gif.js"></script>
    <script src="recorder.js"></script>
  </body>
</html>
```

- [ ] **Step 6: 写 `pages/recorder.js`**

```js
// plugins/screen-recorder/pages/recorder.js
/**
 * 捕获页。
 *
 * 这个页面是隐藏窗口里的真正干活的地方：
 * 取流 → 混音 → 编码 → 把字节交回主进程。
 *
 * 页面用 file:// 加载，所以这里的脚本是**经典脚本**，
 * 不能 import——web/ 下的公共逻辑用 <script src> 引进来。
 */
(function () {
  const G = globalThis.ScreenRecorderGeometry;
  const GIF = globalThis.ScreenRecorderGif;

  const state = {
    recorder: null,
    chunks: [],
    gifEncoder: null,
    canvas: null,
    canvasStream: null,
    drawTimer: null,
    video: null,
    stopped: false,
  };

  function report(type, payload) {
    window.rec.send({ type, payload });
  }

  /** 开始录制。 */
  async function begin(payload) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: Boolean(payload.audio?.speaker),
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('没拿到画面');
      state.video = stream;

      // 被录的窗口被关掉时，轨道会结束。
      // 这时候要**自动停止并保存已有内容**，而不是让录制一直挂着。
      videoTrack.addEventListener('ended', () => {
        report('ended', {});
        stop();
      });

      const settings = videoTrack.getSettings();
      const trackWidth = settings.width || 1280;
      const trackHeight = settings.height || 720;

      // 选区：把整屏流裁一块出来。
      let outputTrack = videoTrack;
      if (payload.crop && payload.snapshotSize) {
        const crop = G.scaleRect(payload.crop, payload.snapshotSize, {
          width: trackWidth,
          height: trackHeight,
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, crop.width);
        canvas.height = Math.max(2, crop.height);
        const ctx = canvas.getContext('2d');
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        const draw = () => {
          ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        };
        state.canvas = canvas;
        state.drawTimer = setInterval(draw, 1000 / (payload.fps || 30));
        draw();
        outputTrack = canvas.captureStream(payload.fps || 30).getVideoTracks()[0];
        state.canvasStream = canvas.captureStream(payload.fps || 30);
        outputTrack = state.canvasStream.getVideoTracks()[0];
      }

      const mime = pickMime();
      const recorder = new MediaRecorder(new MediaStream([outputTrack]), {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });
      state.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(state.chunks, { type: mime });
        blob.arrayBuffer().then((buffer) => {
          report('saved', { bytes: buffer, ext: 'mp4' });
        });
      };
      state.recorder = recorder;
      recorder.start(200);
    } catch (err) {
      report('error', { message: err?.message || String(err) });
    }
  }

  /** 挑一个浏览器支持的容器：优先 MP4（H.264 + AAC）。 */
  function pickMime() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  /** 停止。 */
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.drawTimer) clearInterval(state.drawTimer);
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    if (state.video) state.video.getTracks().forEach((t) => t.stop());
  }

  window.rec.onMessage(async (message) => {
    if (message.type === 'begin') {
      await begin(message.payload || {});
    } else if (message.type === 'stop') {
      stop();
    }
  });

  report('ready');
})();
```

- [ ] **Step 7: 把录制接进 `main.js`**

在 `main.js` 里补上：

```js
import { createWindows } from './lib/windows.js';
import { createCaptureSession } from './lib/capture.js';
import { registerIpc } from './lib/ipc.js';
import { join } from 'node:path';
```

在 `createScreenRecorderPlugin(ctx)` 里补上：

```js
  const pluginDir = ctx.plugin.dir;
  const windows = createWindows({
    pluginDir,
    preloadPath: join(pluginDir, 'preload', 'rec.cjs'),
  });

  const capture = createCaptureSession({
    windows,
    getConfig: () => config,
    getOutputDir: () => (config?.outputDir || '').trim() || app.getPath('videos'),
    onState: (state) => {
      recording = state.recording;
      if (state.file) status = `已保存：${state.file}`;
      if (state.error) status = `出错了：${state.error}`;
      void ctx.update?.(buildPanelPage(ctx.ui, { config, targets, recording, status }));
    },
  });

  registerIpc((message) => {
    if (message?.type === 'saved') {
      void capture.save(message.payload.bytes, message.payload.ext);
    } else if (message?.type === 'error') {
      capture.fail(message.payload?.message || '录制失败');
    }
  });
```

并在 `action` 里加上 `start` / `stop` 两个分支：

```js
    } else if (actionId === 'start') {
      await startRecording();
    } else if (actionId === 'stop') {
      capture.stop();
    }
```

再把「开始录制」抽成一个函数——快捷键（Task 8）也要用它：

```js
  /** 开始录制。用上次选的目标，没有就用列表里的第一个。 */
  async function startRecording() {
    if (capture.isRecording()) {
      status = '已经在录了';
      return;
    }
    const cfg = await ensureConfig();
    const list = await capture.listTargets(cfg.mode);
    if (!list.length) {
      status = '没有可录的目标';
      return;
    }
    const picked = list.find((t) => t.id === cfg.sourceId) || list[0];
    targets = list;
    await save({ sourceId: picked.id });
    try {
      await capture.start({
        mode: cfg.mode,
        sourceId: picked.id,
        format: cfg.format,
        fps: cfg.fps,
        audio: { mic: cfg.mic, speaker: cfg.speaker },
      });
    } catch (err) {
      status = `开始不了：${err?.message || err}`;
    }
  }
```

IPC 要按**窗口的角色**分清楚：控制条发的 `stop` 与工作台发的设置不能混在一起。所以 IPC 处理里先问一句「是谁发的」：

```js
  registerIpc((message, event) => {
    const role = windows.roleOf(event.sender?.id);
    if (message?.type === 'saved') {
      void capture.save(message.payload.bytes, message.payload.ext);
    } else if (message?.type === 'error') {
      capture.fail(message.payload?.message || '录制失败');
    } else if (message?.type === 'stop' && role === 'control') {
      capture.stop();
    } else if (message?.type === 'ended') {
      // 目标没了：记一句，等文件存好了一起显示。
      endedNote = '目标没了，录制已经停下来了';
    }
  });
```

`endedNote` 是插件里的一个变量，`onState` 里存好文件时把它带上：

```js
      if (state.file) {
        status = endedNote ? `${endedNote}；已保存：${state.file}` : `已保存：${state.file}`;
      }
```

> `config.sourceId`（上次选的目标）在 Task 1 里已经加进 `DEFAULT_CONFIG` 与 `normalizeConfig` 了。

- [ ] **Step 8: 写 e2e：全屏录制要产出 mp4**

建 `test/e2e/screen-recorder.spec.js`（后面的用例都往这个文件里加）：

```js
// test/e2e/screen-recorder.spec.js
// 录屏插件的端到端验证。
//
// 覆盖真实链路：开面板 → 打开录屏 → 开始录制 → 录一会儿 → 停止 → 产出文件。
// 这套用例**需要一块真的屏幕**：抓屏在无显示器的机器上跑不起来。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-recorder');
const OUT_DIR = join(USER_DATA, 'out');

async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/**
 * 在所有窗口里按 URL 找某一个。
 *
 * **不能**用 waitForEvent('window')：桌宠打招呼时会冒出一个气泡窗口，
 * 那个事件可能先到。
 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开插件面板，找到「录屏」并打开它。 */
async function openRecorder(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  if (!panel) throw new Error('面板窗口没有出现');
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, { timeout: 15000 });
  // 用拼音搜：'luping' 是这个插件独有的关键词，不会搜到别的东西。
  await panel.fill('#query', 'luping');
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).includes('screen-recorder'), null, {
    timeout: 15000,
  });
  await panel.click('#results li:has-text("录屏")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, { timeout: 10000 });
  return panel;
}

/**
 * 点面板里的一个按钮（按文字找）。
 *
 * **用 evaluate 派发 click，不用 Playwright 的 click**：面板失焦就会收起，
 * Playwright 的命中检测会一直重试到超时（见 test/e2e/panel.spec.js 的 clickIn）。
 */
async function clickButton(panel, label) {
  await panel.evaluate((text) => {
    const btn = [...document.querySelectorAll('#plugin-body .block-buttons button')].find((b) =>
      b.textContent.includes(text)
    );
    if (!btn) throw new Error(`面板里没有按钮：${text}`);
    btn.click();
  }, label);
}

/** 勾一个开关（按文字找）。 */
async function toggle(panel, label, checked) {
  await panel.evaluate(
    ({ text, want }) => {
      const row = [...document.querySelectorAll('#plugin-body .block-toggle')].find((l) =>
        l.textContent.includes(text)
      );
      const box = row?.querySelector('input[type="checkbox"]');
      if (!box) throw new Error(`面板里没有开关：${text}`);
      if (box.checked !== want) box.click();
    },
    { text: label, want: checked }
  );
}

/** 改输入框的值并提交。 */
async function setInput(panel, value) {
  await panel.evaluate((text) => {
    const row = document.querySelector('#plugin-body .block-input');
    if (!row) throw new Error('面板里没有输入框');
    row.querySelector('input').value = text;
    row.querySelector('button').click();
  }, value);
}

test.describe('录屏插件', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('全屏录制产出 mp4', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      // 输出目录指到临时目录里，别把文件丢进用户的视频文件夹。
      await setInput(panel, OUT_DIR);
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 3000));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 2500));

      const files = await readdir(OUT_DIR);
      const mp4 = files.find((f) => f.endsWith('.mp4'));
      expect(mp4, `应该产出 mp4：${files.join('、')}`).toBeTruthy();
      const buffer = await readFile(join(OUT_DIR, mp4));
      // mp4 的第一个 box 是 ftyp：看它就知道文件头是对的。
      expect(buffer.subarray(4, 8).toString('latin1')).toBe('ftyp');
      expect(buffer.length).toBeGreaterThan(1000);
    } finally {
      await app.close();
    }
  });
});
```

> 面板的 DOM（见 `src/renderer/panel/index.html`）：插件的块都画在 `#plugin-body` 里，
> 按钮是 `#plugin-body .block-buttons button`，开关是 `#plugin-body .block-toggle`，
> 状态行是 `#plugin-status`。

- [ ] **Step 9: 跑 e2e，确认通过**

Run: `npx playwright test test/e2e/screen-recorder.spec.js`
Expected: PASS —— 产出目录里有一个 `.mp4`，文件头是 `ftyp`。

- [ ] **Step 10: 手动验证一次全屏录制**

Run: `npm start` → 搜「录屏」→ 模式选「全屏」→ 点「开始录制」→ 录 3 秒 → 点「停止录制」
Expected:
- 状态行变成「已保存：C:\Users\Felix\Videos\录屏_2026….mp4」
- 文件存在且能播（用 ffprobe 看：`codec_name=h264`、宽高等于屏幕分辨率）

- [ ] **Step 11: 提交**

```bash
git add plugins/screen-recorder test/e2e/screen-recorder.spec.js
git commit -m "feat(录屏): 全屏视频录制（捕获页 + 会话 + 落盘）"
```

---

### Task 5: 声音（系统声音 + 麦克风 + 混音）

**Files:**
- Modify: `plugins/screen-recorder/pages/recorder.js`
- Modify: `plugins/screen-recorder/lib/capture.js`
- Modify: `plugins/screen-recorder/main.js`
- Modify: `test/e2e/screen-recorder.spec.js`
- Create: `test/e2e/helpers/mp4.js`

**Interfaces:**
- Consumes: Task 4 的捕获页与录制会话
- Produces:
  - `test/e2e/helpers/mp4.js`：`parseMp4Tracks(buffer) → { tracks: [{type:'vide'|'soun', width, height}] }`

- [ ] **Step 1: 写 mp4 解析助手**

```js
// test/e2e/helpers/mp4.js
/**
 * 极简 mp4 解析：找出每个轨道是画面还是声音，以及画面的尺寸。
 *
 * 不引 ffprobe——那是本机装的东西，不是项目的依赖。
 * 这里只需要回答两个问题：有没有声音轨？画面多大？
 */

/** 读一个 box 的头，返回 {type, size, bodyStart}。 */
function readBox(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  let size = bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let headerSize = 8;
  if (size === 1) {
    // 64 位长度：取高 4 字节（这里只用到小文件，取低 4 字节够了）
    size = bytes[offset + 12] * 0x1000000 + (bytes[offset + 13] << 16) + (bytes[offset + 14] << 8) + bytes[offset + 15];
    headerSize = 16;
  }
  if (!size) return null;
  return { type, size, bodyStart: offset + headerSize, end: offset + size };
}

/** 在一段字节里找所有指定类型的 box。 */
function findBoxes(bytes, start, end, type) {
  const found = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(bytes, offset);
    if (!box || box.end > end || box.end <= offset) break;
    if (box.type === type) found.push(box);
    offset = box.end;
  }
  return found;
}

/** 在某个 box 的内容里递归找。 */
function findDeep(bytes, start, end, type) {
  const direct = findBoxes(bytes, start, end, type);
  if (direct.length) return direct;
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(bytes, offset);
    if (!box || box.end > end || box.end <= offset) break;
    const nested = findDeep(bytes, box.bodyStart, box.end, type);
    if (nested.length) return nested;
    offset = box.end;
  }
  return [];
}

/**
 * 解析 mp4。
 *
 * @param {ArrayBuffer|Buffer} input
 * @returns {{tracks: Array<{type:string,width:number,height:number}>}}
 */
export function parseMp4Tracks(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const moov = findBoxes(bytes, 0, bytes.length, 'moov')[0];
  const tracks = [];
  if (!moov) return { tracks };
  for (const trak of findBoxes(bytes, moov.bodyStart, moov.end, 'trak')) {
    const hdlr = findDeep(bytes, trak.bodyStart, trak.end, 'hdlr')[0];
    let type = '';
    if (hdlr) {
      // hdlr 的内容：版本(1) + 标志(3) + 预定义(4) + 处理类型(4)
      type = String.fromCharCode(bytes[hdlr.bodyStart + 8], bytes[hdlr.bodyStart + 9], bytes[hdlr.bodyStart + 10], bytes[hdlr.bodyStart + 11]);
    }
    const tkhd = findDeep(bytes, trak.bodyStart, trak.end, 'tkhd')[0];
    let width = 0;
    let height = 0;
    if (tkhd) {
      // tkhd 尾部：版本0 是 4 字节宽高（16.16 定点），版本1 是 8 字节
      const version = bytes[tkhd.bodyStart];
      const base = tkhd.end - (version === 1 ? 8 : 4);
      width = bytes[base] * 0x1000000 + (bytes[base + 1] << 16) + (bytes[base + 2] << 8) + bytes[base + 3];
      height = bytes[base + 4] * 0x1000000 + (bytes[base + 5] << 16) + (bytes[base + 6] << 8) + bytes[base + 7];
      width = Math.round(width / 65536);
      height = Math.round(height / 65536);
    }
    tracks.push({ type, width, height });
  }
  return { tracks };
}
```

- [ ] **Step 2: 在 e2e 里加声音相关的用例**

e2e 的骨架（`launch` / `findWindow` / `openRecorder` / `clickButton` / `toggle` /
`setInput`）在 Task 4 里已经建好了。这一步只往那个文件里加两条用例，
并把 mp4 的解析助手引进来：

```js
// 加到 test/e2e/screen-recorder.spec.js 的 import 那一行：
import { parseMp4Tracks } from './helpers/mp4.js';

// 加到 test.describe('录屏插件', …) 里面：

  test('没有麦克风时给的是明确提示，不是静默', async () => {
    // 这台机器没有音频输入设备：正好用来验「拿不到麦克风」这条路。
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      await setInput(panel, OUT_DIR);
      await toggle(panel, '麦克风', true);
      await toggle(panel, '扬声器', false);
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 2000));

      const status = await panel.textContent('#plugin-status');
      expect(status, `状态里应该说清楚为什么没声音：${status}`).toContain('麦克风');
    } finally {
      await app.close();
    }
  });
});
```

再把 Task 4 那条用例的断言补完整——加上「画面轨的尺寸」与「有声音轨」：

```js
// Task 4 的 '全屏录制产出 mp4' 用例里，把最后几行换成：
      const buffer = await readFile(join(OUT_DIR, mp4));
      const { tracks } = parseMp4Tracks(buffer);
      const video = tracks.find((t) => t.type === 'vide');
      expect(video, '得有一个画面轨').toBeTruthy();
      expect(video.width).toBeGreaterThan(0);
      expect(video.height).toBeGreaterThan(0);
```

- [ ] **Step 3: 把声音接进捕获页**

在 `pages/recorder.js` 的 `begin()` 里，取流之后加混音：

```js
      // 声音：系统声音（loopback）由主进程的 handler 给，麦克风自己取。
      const audioTracks = [];
      if (payload.audio?.speaker) {
        const systemTrack = stream.getAudioTracks()[0];
        if (systemTrack) audioTracks.push(systemTrack);
      }
      let micTrack = null;
      if (payload.audio?.mic) {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          micTrack = mic.getAudioTracks()[0] || null;
        } catch (err) {
          // 没有麦克风 / 用户不给权限：说清楚，别静默录不到声音。
          report('error', { message: `没有拿到麦克风：${err?.message || err}`, soft: true });
        }
      }

      let audioTrack = null;
      if (audioTracks.length || micTrack) {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        if (audioTracks.length) {
          context.createMediaStreamSource(new MediaStream(audioTracks)).connect(destination);
        }
        if (micTrack) {
          context.createMediaStreamSource(new MediaStream([micTrack])).connect(destination);
        }
        audioTrack = destination.stream.getAudioTracks()[0] || null;
      }
```

然后把音轨加进录制的流里：

```js
      const tracks = [outputTrack];
      if (audioTrack) tracks.push(audioTrack);
      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });
```

> `report('error', …)` 带 `soft: true` 时**不中断录制**——麦克风没有不该让整段录制白费。主进程那边要认这个标志。

- [ ] **Step 4: 主进程认 soft 错误**

在 `lib/capture.js` 加一个 `warn(message)`，并在 `main.js` 的 IPC 处理里区分：

```js
  registerIpc((message) => {
    if (message?.type === 'saved') {
      void capture.save(message.payload.bytes, message.payload.ext);
    } else if (message?.type === 'error') {
      if (message.payload?.soft) {
        capture.warn(message.payload.message);
      } else {
        capture.fail(message.payload?.message || '录制失败');
      }
    }
  });
```

```js
  /** 出错了但还能继续录：只提示，不停。 */
  function warn(message) {
    onState?.({ recording: isRecording(), elapsedMs: Date.now() - startedAt, warning: message });
  }
```

- [ ] **Step 5: 跑 e2e，确认能产出 mp4 且有画面轨**

Run: `npx playwright test test/e2e/screen-recorder.spec.js`
Expected: PASS

- [ ] **Step 6: 断言音频轨存在**

在 e2e 里把产出文件读回来，用 `parseMp4Tracks` 检查：

```js
      const file = join(OUT_DIR, files[0]);
      const buffer = await readFile(file);
      const { tracks } = parseMp4Tracks(buffer);
      expect(tracks.some((t) => t.type === 'vide'), '得有一个画面轨').toBe(true);
      expect(tracks.some((t) => t.type === 'soun'), '系统声音得录进去').toBe(true);
```

> 本机**没有音频输入设备**，所以「麦克风」这一路在这台机器上只能测到「没有找到麦克风」的提示；系统声音（loopback）是可以真录进去的。

- [ ] **Step 7: 提交**

```bash
git add plugins/screen-recorder test/e2e
git commit -m "feat(录屏): 系统声音与麦克风（自动混音）"
```

---

### Task 6: 选区录制（全屏遮罩 + 裁剪）

**Files:**
- Create: `plugins/screen-recorder/pages/picker.html`
- Create: `plugins/screen-recorder/pages/picker.js`
- Modify: `plugins/screen-recorder/lib/windows.js`
- Modify: `plugins/screen-recorder/lib/capture.js`
- Modify: `plugins/screen-recorder/main.js`
- Modify: `test/e2e/screen-recorder.spec.js`

**Interfaces:**
- Consumes: Task 3 的 `web/geometry.js`；Task 4 的捕获会话
- Produces:
  - `lib/windows.js` 增 `openPicker({ display, snapshot, image }) → Promise<{crop, snapshotSize} | null>`
  - 消息协议增：主进程 → 遮罩页 `{type:'picker', payload:{ image, snapshotSize }}`；遮罩页 → 主进程 `{type:'picked', payload:{ crop, snapshotSize }}` / `{type:'picked-cancel'}`

- [ ] **Step 1: 写 `pages/picker.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>选一块要录的区域</title>
    <style>
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
        cursor: crosshair;
        user-select: none;
      }
      /* 底图铺满窗口（窗口就是显示器的大小，DIP）。 */
      #shot {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: fill;
      }
      /* 变暗层：让选中的那块显眼。 */
      #dim {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
      }
      #sel {
        position: absolute;
        border: 2px solid #4f9dff;
        background: rgba(79, 157, 255, 0.16);
        display: none;
      }
      #bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 24px;
        display: flex;
        gap: 12px;
        justify-content: center;
      }
      button {
        font: 15px/1.2 "Microsoft YaHei", sans-serif;
        padding: 8px 18px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        background: #fff;
        color: #222;
      }
      button.primary {
        background: #4f9dff;
        color: #fff;
      }
      #size {
        position: absolute;
        left: 12px;
        top: 12px;
        color: #fff;
        font: 13px/1.4 "Microsoft YaHei", sans-serif;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
      }
    </style>
  </head>
  <body>
    <img id="shot" alt="" />
    <div id="dim"></div>
    <div id="sel"></div>
    <div id="size"></div>
    <div id="bar">
      <button id="cancel" type="button">取消</button>
      <button id="ok" class="primary" type="button">确定</button>
    </div>
    <script src="../web/geometry.js"></script>
    <script src="picker.js"></script>
  </body>
</html>
```

- [ ] **Step 2: 写 `pages/picker.js`**

```js
// plugins/screen-recorder/pages/picker.js
/**
 * 选区遮罩。
 *
 * 窗口铺满一块显示器，底图是那张显示器的整屏截图（变暗），
 * 用户在上面拖一个框。选完把矩形交回主进程。
 *
 * 坐标有两条路：
 * - 这里拿到的是 **CSS 像素**（= DIP，窗口多大就是多大）；
 * - 主进程要的是**截图的物理像素**，所以这里顺手换算好再发。
 *
 * 换算用的是 web/geometry.js —— 和捕获页裁剪用的是同一份，
 * 两边算法不一样的话，选区就会偏。
 */
(function () {
  const G = globalThis.ScreenRecorderGeometry;

  const shot = document.getElementById('shot');
  const sel = document.getElementById('sel');
  const sizeLabel = document.getElementById('size');

  let snapshotSize = { width: 0, height: 0 };
  let start = null;
  let current = null;

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** CSS 空间 → 截图物理像素空间。 */
  function toSnapshot(rect) {
    return G.scaleRect(rect, viewport(), snapshotSize);
  }

  function paint() {
    if (!current) return;
    sel.style.display = 'block';
    sel.style.left = `${current.x}px`;
    sel.style.top = `${current.y}px`;
    sel.style.width = `${current.width}px`;
    sel.style.height = `${current.height}px`;
    const snap = toSnapshot(current);
    sizeLabel.textContent = `${snap.width} × ${snap.height}`;
  }

  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('#bar')) return;
    start = { x: event.clientX, y: event.clientY };
    current = G.normalizeRect(start, start);
    paint();
  });

  document.addEventListener('mousemove', (event) => {
    if (!start) return;
    current = G.normalizeRect(start, { x: event.clientX, y: event.clientY });
    paint();
  });

  document.addEventListener('mouseup', () => {
    if (!start) return;
    start = null;
  });

  document.getElementById('ok').addEventListener('click', () => {
    const rect = current ? toSnapshot(current) : null;
    if (!rect || rect.width < 4 || rect.height < 4) {
      // 没框到东西就别录：告诉用户重框一次，而不是录一段全黑。
      sizeLabel.textContent = '先在上面拖一个框';
      return;
    }
    window.rec.send({ type: 'picked', payload: { crop: rect, snapshotSize } });
  });

  document.getElementById('cancel').addEventListener('click', () => {
    window.rec.send({ type: 'picked-cancel' });
  });

  window.rec.onMessage((message) => {
    if (message.type !== 'picker') return;
    const payload = message.payload || {};
    snapshotSize = payload.snapshotSize || { width: 0, height: 0 };
    shot.src = payload.image || '';
  });
})();
```

- [ ] **Step 3: `lib/windows.js` 加遮罩窗口**

在 `createWindows` 里加：

```js
  /**
   * 开遮罩：铺满一块显示器，等用户框一块区域。
   *
   * 遮罩是**独立窗口**而不是画在桌宠上：它要盖住整块屏幕，
   * 并且始终置顶（'screen-saver' 这一档比 'floating' 更靠前）。
   */
  function openPicker({ display, snapshot, image }) {
    return new Promise((resolve) => {
      if (windows.picker && !windows.picker.isDestroyed()) windows.picker.destroy();
      const win = new BrowserWindow({
        ...display.bounds,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      windows.picker = track(win, 'picker');
      win.on('closed', () => {
        windows.picker = null;
        resolve(null); // 窗口被直接关掉 = 用户放弃了
      });
      win.webContents.on('did-finish-load', () => {
        win.webContents.send('rec:screen-recorder:message', {
          type: 'picker',
          payload: { image, snapshotSize: snapshot },
        });
      });
      win.loadFile(join(pluginDir, 'pages', 'picker.html'));
    });
  }
```

并把它加进返回的对象里。

- [ ] **Step 4: `lib/capture.js` 加「先框再录」的流程**

```js
import { desktopCapturer, screen, session } from 'electron';

/**
 * 选区模式：先把遮罩开出来，等用户框一块。
 *
 * **顺序很重要**：遮罩必须先关掉，再开始取流。
 * 遮罩还在的时候取流，那块半透明的暗色层会被录进画面里。
 */
async function pickRegion() {
  const displays = screen.getAllDisplays();
  const display = displays[0];
  if (!display) return null;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: display.bounds.width * display.scaleFactor,
      height: display.bounds.height * display.scaleFactor,
    },
  });
  const source = sources.find((s) => s.display_id === display.id) || sources[0];
  if (!source) return null;

  const picked = await windows.openPicker({
    display,
    snapshot: { width: source.thumbnail.getSize().width, height: source.thumbnail.getSize().height },
    image: source.thumbnail.toDataURL(),
  });
  if (!picked) return null;
  return { crop: picked.crop, snapshotSize: picked.snapshotSize, sourceId: source.id };
}
```

并把 `pickRegion` 加进 `createCaptureSession` 的返回值里（主进程要调它）。

在 `start()` 里，模式是选区时先走这一趟：

```js
    if (options.mode === 'region') {
      const region = await pickRegion();
      if (!region) {
        state = 'idle';
        throw new Error('没选区域');
      }
      sourceId = region.sourceId;
      options = { ...options, crop: region.crop, snapshotSize: region.snapshotSize };
    }
```

- [ ] **Step 5: 主进程接上遮罩的结果**

`main.js` 的 `start` 分支里，模式是选区时先开遮罩：

```js
      } else if (cfg.mode === 'region') {
        // 遮罩的结果回来了才真的开始录。
        void (async () => {
          const region = await capture.pickRegion();
          if (!region) {
            status = '没选区域';
            void ctx.update?.(buildPanelPage(ctx.ui, { config, targets, recording, status }));
            return;
          }
          await capture.start({
            mode: 'region',
            sourceId: region.sourceId,
            format: cfg.format,
            fps: cfg.fps,
            audio: { mic: cfg.mic, speaker: cfg.speaker },
            crop: region.crop,
            snapshotSize: region.snapshotSize,
          });
        })();
      }
```

遮罩页发回的 `picked` / `picked-cancel` 消息由 `windows.js` 里的 `openPicker` 的 Promise 收口，所以主进程不用单独处理这两个消息——但 `openPicker` 需要能收到它们：在 `createWindows` 里加一个 `pendingPicker` 的 resolver，由 `onMessage` 分发。

- [ ] **Step 6: e2e 断言「遮罩关掉之后才开始录」**

```js
  test('选区录制：遮罩在开始录制之前就关掉了', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      await clickButton(panel, '选区');
      await clickButton(panel, '开始录制');

      const picker = await findWindow(app, 'picker.html');
      expect(picker, '遮罩窗口应该出现').not.toBeNull();
      await picker.mouse.move(200, 200);
      await picker.mouse.down();
      await picker.mouse.move(600, 500, { steps: 8 });
      await picker.mouse.up();
      await picker.click('#ok');

      // 录制进行中：遮罩必须已经没了（不然它会被录进画面）。
      await new Promise((r) => setTimeout(r, 1500));
      const stillThere = await findWindow(app, 'picker.html');
      expect(stillThere, '遮罩应该已经关掉了').toBeNull();
    } finally {
      await app.close();
    }
  });
```

- [ ] **Step 7: 提交**

```bash
git add plugins/screen-recorder test/e2e/screen-recorder.spec.js
git commit -m "feat(录屏): 选区录制（全屏遮罩拉框 + 画布裁剪）"
```

---

### Task 7: GIF 模式

**Files:**
- Modify: `plugins/screen-recorder/pages/recorder.js`
- Modify: `plugins/screen-recorder/lib/capture.js`
- Modify: `plugins/screen-recorder/main.js`
- Modify: `plugins/screen-recorder/lib/page.js`
- Modify: `test/e2e/screen-recorder.spec.js`

**Interfaces:**
- Consumes: Task 2 的 `web/gif.js`（`ScreenRecorderGif.GifEncoder`）；Task 4 的捕获会话
- Produces: 捕获页支持 `format: 'gif'`：逐帧取像 → 编码 → 停止时交回 `{bytes, ext:'gif'}`

- [ ] **Step 1: 捕获页加 GIF 分支**

在 `pages/recorder.js` 的 `begin()` 里，`format === 'gif'` 时走另一条路——
**这个分支要放在「选区裁剪」那段之前**：GIF 自己管缩放与裁剪，
别让前面的 canvas 裁剪把它处理两遍：

```js
      if (payload.format === 'gif') {
        await beginGif(payload, stream, videoTrack);
        return;
      }
```

```js
  /**
   * GIF 模式。
   *
   * 走的是**完全不同的**一路：MediaRecorder 产不出 GIF，
   * 所以这里自己逐帧取像素、量化、编码。
   *
   * GIF 没有音频——格式本身不支持，界面上要写明。
   */
  async function beginGif(payload, stream, videoTrack) {
    const settings = videoTrack.getSettings();
    const trackWidth = settings.width || 1280;
    const trackHeight = settings.height || 720;

    // 目标尺寸：宽度不超过配置值，高度按比例。
    const targetWidth = Math.min(payload.gif?.width || 480, trackWidth);
    const targetHeight = Math.round((targetWidth * trackHeight) / trackWidth);

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let crop = null;
    if (payload.crop && payload.snapshotSize) {
      crop = G.scaleRect(payload.crop, payload.snapshotSize, {
        width: trackWidth,
        height: trackHeight,
      });
    }

    const encoder = new GIF.GifEncoder({ width: targetWidth, height: targetHeight });
    state.gifEncoder = encoder;

    const frameMs = Math.round(1000 / (payload.gif?.fps || 12));
    state.drawTimer = setInterval(() => {
      if (crop) {
        ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, targetWidth, targetHeight);
      } else {
        ctx.drawImage(video, 0, 0, trackWidth, trackHeight, 0, 0, targetWidth, targetHeight);
      }
      const image = ctx.getImageData(0, 0, targetWidth, targetHeight);
      encoder.addFrame(image.data, frameMs);
    }, frameMs);
  }
```

停止时（`stop()`）要把 GIF 的字节交回去：

```js
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.drawTimer) clearInterval(state.drawTimer);
    if (state.gifEncoder) {
      const bytes = state.gifEncoder.bytes();
      report('saved', { bytes: bytes.buffer, ext: 'gif' });
    } else if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    if (state.video) state.video.getTracks().forEach((t) => t.stop());
  }
```

- [ ] **Step 2: 主进程把 gif 参数传下去**

`main.js` 的 `start` 分支里：

```js
            await capture.start({
              sourceId: picked.id,
              format: cfg.format,
              fps: cfg.fps,
              gif: { width: cfg.gifWidth, fps: cfg.gifFps },
              audio: { mic: cfg.mic, speaker: cfg.speaker },
            });
```

`lib/capture.js` 的 `start()` 里把 `gif` 放进 `begin` 的 payload：

```js
        gif: options.gif || null,
```

- [ ] **Step 3: 界面上写明「GIF 没有音频」**

`lib/page.js` 的 `buildPanelPage`：当格式是 GIF 时，在声音开关前加一条说明：

```js
  if (config.format === 'gif') {
    blocks.push(ui.textBlock('GIF 存不了声音——切到 GIF 时不会录声音。'));
  }
```

- [ ] **Step 4: e2e 断言产出的是 GIF**

```js
  test('GIF 模式产出 GIF 文件', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      await clickButton(panel, 'GIF');
      await new Promise((r) => setTimeout(r, 300));
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 3000));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 3000));

      const files = await readdir(OUT_DIR);
      const gif = files.find((f) => f.endsWith('.gif'));
      expect(gif, `应该产出 GIF：${files.join('、')}`).toBeTruthy();
      const buffer = await readFile(join(OUT_DIR, gif));
      expect(buffer.subarray(0, 6).toString('latin1')).toBe('GIF89a');
      expect(buffer[buffer.length - 1]).toBe(0x3b);
    } finally {
      await app.close();
    }
  });
```

- [ ] **Step 5: 提交**

```bash
git add plugins/screen-recorder test/e2e/screen-recorder.spec.js
git commit -m "feat(录屏): GIF 模式（逐帧编码）"
```

---

### Task 8: 控制条、工作台与快捷键

**Files:**
- Create: `plugins/screen-recorder/pages/control.html`
- Create: `plugins/screen-recorder/pages/control.js`
- Create: `plugins/screen-recorder/pages/workbench.html`
- Create: `plugins/screen-recorder/pages/workbench.js`
- Create: `plugins/screen-recorder/lib/hotkey.js`
- Modify: `plugins/screen-recorder/lib/windows.js`
- Modify: `plugins/screen-recorder/main.js`
- Modify: `test/e2e/screen-recorder.spec.js`

**Interfaces:**
- Consumes: Task 4 的 `windows.js`（`showControl` / `openWorkbench`）、Task 1 的配置读写
- Produces:
  - `lib/hotkey.js`：`registerHotkey(accel, onTrigger) → boolean`、`unregisterHotkey()`、`currentHotkey() → string`
  - 消息协议增：主进程 → 控制条 `{type:'state', payload:{recording, elapsedMs}}`；控制条 → 主进程 `{type:'stop'}`
  - 主进程 → 工作台 `{type:'workbench', payload:{config, recording, elapsedMs, hotkeyError, status}}`；工作台 → 主进程 `{type:'hotkey', payload:{accel}}`、`{type:'workbench-set', payload:{...}}`、`{type:'workbench-pick-dir'}`、`{type:'workbench-open-dir'}`

- [ ] **Step 1: 写 `lib/hotkey.js`**

```js
// plugins/screen-recorder/lib/hotkey.js
import { globalShortcut } from 'electron';

let registered = null;

/**
 * 注册全局快捷键。
 *
 * 只有**工作台窗口开着**的时候才注册：关掉工作台就把这个组合键
 * 让回给别的程序——一个常驻抢键的录屏插件是很讨人厌的。
 *
 * @param {string} accel Electron 的快捷键写法，如 'Control+Shift+R'
 * @param {() => void} onTrigger
 * @returns {boolean} 注册成功吗
 */
export function registerHotkey(accel, onTrigger) {
  unregisterHotkey();
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, onTrigger);
    if (ok) registered = accel;
    return ok;
  } catch (err) {
    console.warn('[录屏] 快捷键注册不了：', err?.message);
    return false;
  }
}

/** 注销。 */
export function unregisterHotkey() {
  if (!registered) return;
  try {
    globalShortcut.unregister(registered);
  } catch {
    // 已经没了就算了。
  }
  registered = null;
}

/** 现在注册着哪个键。 */
export function currentHotkey() {
  return registered || '';
}
```

- [ ] **Step 2: 写 `pages/control.html`**

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
      #bar {
        display: flex;
        align-items: center;
        gap: 12px;
        height: 100%;
        padding: 0 14px;
        border-radius: 14px;
        background: rgba(28, 28, 32, 0.88);
        color: #fff;
        font: 14px/1.2 "Microsoft YaHei", sans-serif;
        -webkit-app-region: drag;
      }
      #dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ff4d4f;
        flex: none;
      }
      #time {
        font-variant-numeric: tabular-nums;
        flex: 1;
      }
      button {
        -webkit-app-region: no-drag;
        font: 14px/1.2 "Microsoft YaHei", sans-serif;
        padding: 6px 14px;
        border: 0;
        border-radius: 8px;
        background: #ff4d4f;
        color: #fff;
        cursor: pointer;
      }
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

- [ ] **Step 3: 写 `pages/control.js`**

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

  document.getElementById('stop').addEventListener('click', () => {
    window.rec.send({ type: 'stop' });
  });

  window.rec.onMessage((message) => {
    if (message.type !== 'state') return;
    const payload = message.payload || {};
    time.textContent = format(payload.elapsedMs || 0);
  });
})();
```

- [ ] **Step 4: 写 `pages/workbench.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>录屏设置</title>
    <style>
      body {
        margin: 0;
        padding: 18px 20px;
        font: 14px/1.6 "Microsoft YaHei", sans-serif;
        color: #222;
        background: #fffdf8;
      }
      h1 {
        font-size: 17px;
        margin: 0 0 14px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
      }
      .row label {
        width: 96px;
        flex: none;
        color: #555;
      }
      input[type='text'] {
        flex: 1;
        padding: 6px 8px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font: inherit;
      }
      button {
        padding: 6px 14px;
        border: 1px solid #ddd;
        border-radius: 6px;
        background: #fff;
        font: inherit;
        cursor: pointer;
      }
      button.primary {
        background: #4f9dff;
        border-color: #4f9dff;
        color: #fff;
      }
      #status {
        margin-top: 14px;
        padding: 8px 10px;
        border-radius: 6px;
        background: #f3f3f3;
        color: #555;
        min-height: 20px;
      }
      #hotkeyError {
        color: #c0392b;
      }
      .hint {
        color: #888;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <h1>录屏设置</h1>

    <div class="row">
      <label for="outputDir">存放位置</label>
      <input id="outputDir" type="text" placeholder="留空＝视频文件夹" />
      <button id="pickDir" type="button">浏览…</button>
    </div>

    <div class="row">
      <label for="hotkey">快捷键</label>
      <input id="hotkey" type="text" readonly placeholder="点右边录制" />
      <button id="recordHotkey" type="button">录制</button>
    </div>
    <p class="hint">快捷键只在这个窗口开着的时候生效——关掉窗口就把这个组合键让回给别的程序。</p>

    <div class="row">
      <label for="fps">视频帧率</label>
      <input id="fps" type="text" />
    </div>

    <div class="row">
      <label for="gifWidth">GIF 宽度</label>
      <input id="gifWidth" type="text" />
    </div>

    <div class="row">
      <button id="openDir" type="button">打开输出文件夹</button>
    </div>

    <div id="status"></div>
    <div id="hotkeyError"></div>

    <script src="workbench.js"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 `pages/workbench.js`**

```js
// plugins/screen-recorder/pages/workbench.js
/**
 * 工作台：设置与快捷键。
 *
 * 快捷键的「录制」是**在这个页面里捕获按键**：
 * 页面拿到 keydown，翻译成 Electron 的快捷键写法，发给主进程注册。
 */
(function () {
  const outputDir = document.getElementById('outputDir');
  const hotkey = document.getElementById('hotkey');
  const fps = document.getElementById('fps');
  const gifWidth = document.getElementById('gifWidth');
  const status = document.getElementById('status');
  const hotkeyError = document.getElementById('hotkeyError');

  let recording = false;

  /** 按键 → Electron 的快捷键写法。 */
  function toAccelerator(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');
    const code = event.code || '';
    let key = '';
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F[0-9]{1,2}$/.test(code)) key = code;
    else if (code === 'Space') key = 'Space';
    else if (code === 'Enter') key = 'Return';
    else if (code === 'Escape') key = 'Escape';
    else if (code === 'Backspace') key = 'Backspace';
    else if (code.startsWith('Arrow')) {
      key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[code] || '';
    }
    if (!key) return '';
    if (!parts.length) return ''; // 裸键会劫持所有字母键，不要
    return [...parts, key].join('+');
  }

  document.getElementById('recordHotkey').addEventListener('click', () => {
    hotkey.value = '按下新的组合键…';
    hotkeyError.textContent = '';
    recording = true;
  });

  document.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      recording = false;
      hotkey.value = '';
      return;
    }
    const accel = toAccelerator(event);
    if (!accel) return;
    recording = false;
    hotkey.value = accel;
    window.rec.send({ type: 'hotkey', payload: { accel } });
  });

  document.getElementById('pickDir').addEventListener('click', () => {
    window.rec.send({ type: 'workbench-pick-dir' });
  });

  document.getElementById('openDir').addEventListener('click', () => {
    window.rec.send({ type: 'workbench-open-dir' });
  });

  function commit() {
    window.rec.send({
      type: 'workbench-set',
      payload: {
        outputDir: outputDir.value.trim(),
        fps: Number(fps.value),
        gifWidth: Number(gifWidth.value),
      },
    });
  }
  outputDir.addEventListener('change', commit);
  fps.addEventListener('change', commit);
  gifWidth.addEventListener('change', commit);

  window.rec.onMessage((message) => {
    if (message.type !== 'workbench') return;
    const payload = message.payload || {};
    const config = payload.config || {};
    if (document.activeElement !== outputDir) outputDir.value = config.outputDir || '';
    if (document.activeElement !== hotkey) hotkey.value = config.hotkey || '';
    if (document.activeElement !== fps) fps.value = String(config.fps ?? 30);
    if (document.activeElement !== gifWidth) gifWidth.value = String(config.gifWidth ?? 480);
    hotkeyError.textContent = payload.hotkeyError || '';
    status.textContent = payload.status || '';
  });
})();
```

- [ ] **Step 6: `main.js` 把控制条、工作台、快捷键接起来**

```js
import { registerHotkey, unregisterHotkey } from './lib/hotkey.js';
import { shell } from 'electron';
```

在插件里加状态与处理：

```js
  let hotkeyError = '';

  /** 往工作台推一份状态。 */
  function pushWorkbenchState() {
    windows.sendTo('workbench', {
      type: 'workbench',
      payload: { config, recording, status, hotkeyError },
    });
  }

  /** 工作台开着的时候，快捷键才生效。 */
  async function syncHotkey() {
    if (!windows.isWorkbenchOpen()) {
      unregisterHotkey();
      return;
    }
    const cfg = await ensureConfig();
    const ok = registerHotkey(cfg.hotkey, () => {
      if (capture.isRecording()) capture.stop();
      else void startRecording();
    });
    hotkeyError = ok ? '' : `快捷键 ${cfg.hotkey} 注册不了——可能已经被别的程序占着了`;
  }
```

在 IPC 处理里加（**按窗口角色分开**：控制条只能停，工作台只能改设置）：

```js
    } else if (message?.type === 'stop' && role === 'control') {
      capture.stop();
    } else if (role === 'workbench' && message?.type === 'hotkey') {
      await save({ hotkey: message.payload?.accel || '' });
      await syncHotkey();
      pushWorkbenchState();
    } else if (role === 'workbench' && message?.type === 'workbench-set') {
      await save(message.payload || {});
      pushWorkbenchState();
    } else if (role === 'workbench' && message?.type === 'workbench-pick-dir') {
      const dir = await pickDirectory();
      if (dir) {
        await save({ outputDir: dir });
        pushWorkbenchState();
      }
    } else if (role === 'workbench' && message?.type === 'workbench-open-dir') {
      await shell.openPath((config?.outputDir || '').trim() || app.getPath('videos'));
    }
```

工作台窗口开合时同步快捷键：`lib/windows.js` 的 `openWorkbench()` 与 `closeWorkbench()` 里调用一个回调：

```js
  // lib/windows.js 的 createWindows 里加一个参数
  function createWindows({ pluginDir, preloadPath, onWorkbenchChanged }) { … }

  // openWorkbench() 末尾
  onWorkbenchChanged?.(true);
  // closeWorkbench() 与 workbench 的 'closed' 事件里
  onWorkbenchChanged?.(false);
```

主进程接上：

```js
  const windows = createWindows({
    pluginDir,
    preloadPath: join(pluginDir, 'preload', 'rec.cjs'),
    onWorkbenchChanged: (open) => {
      if (!open) unregisterHotkey();
      else syncHotkey();
      pushWorkbenchState();
    },
  });
```

录制状态变化时，控制条要收到：

```js
    onState: (state) => {
      recording = state.recording;
      if (state.file) status = `已保存：${state.file}`;
      if (state.error) status = `出错了：${state.error}`;
      if (state.warning) status = state.warning;
      windows.sendTo('control', { type: 'state', payload: { recording, elapsedMs: state.elapsedMs } });
      void ctx.update?.(buildPanelPage(ctx.ui, { config, targets, recording, status }));
      pushWorkbenchState();
    },
```

并且**开始录制时把控制条开出来**——在 `lib/capture.js` 的 `start()` 里加 `windows.showControl();`。

- [ ] **Step 7: `lib/windows.js` 加 `sendTo`**

```js
import { BrowserWindow, webContents } from 'electron';

/** 给某个角色的窗口发消息。 */
function sendTo(role, message) {
  for (const [contentsId, r] of roles) {
    if (r !== role) continue;
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) {
      contents.send('rec:screen-recorder:message', message);
    }
  }
}
```

并把 `sendTo` 加进 `createWindows` 的返回值里。

- [ ] **Step 8: 退出前收拾干净**

在 `main.js` 里：

```js
  app.on('before-quit', () => {
    windows.destroyAll();
    unregisterHotkey();
  });
```

> 这一条是**必须的**：Electron 正常的 `app.quit()` 流程遇到还有窗口活着会卡住（宿主在 `src/main/plugins/window.js` 的 `destroyAll` 注释里写过）。

- [ ] **Step 9: e2e 断言工作台开着时快捷键才注册**

```js
  test('工作台开着时快捷键才生效，关掉就注销', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      await clickButton(panel, '设置');
      const workbench = await findWindow(app, 'workbench.html');
      expect(workbench, '工作台应该出现').not.toBeNull();
      await workbench.waitForLoadState('domcontentloaded');

      await workbench.waitForFunction(
        () => (document.getElementById('hotkey')?.value || '').includes('+'),
        null,
        { timeout: 10000 }
      );

      await workbench.evaluate(() => window.close());
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      // app.close() 必须在超时内返回——它返回不了就说明有窗口挡住了退出。
      await app.close();
    }
  });
```

- [ ] **Step 10: 提交**

```bash
git add plugins/screen-recorder test/e2e/screen-recorder.spec.js
git commit -m "feat(录屏): 控制条、工作台与快捷键（窗口开着才生效）"
```

---

### Task 9: 收尾——README 与整体验收

**Files:**
- Modify: `README.md`
- Modify: `test/e2e/screen-recorder.spec.js`

**Interfaces:**
- Consumes: Task 1–8 的全部产出
- Produces: 文档与整体验收

- [ ] **Step 1: 更新 README**

在 README 的「功能」一节加一条，在「插件系统」一节补上录屏插件的说明：

```markdown
### 录屏

插件面板里搜「录屏」：

- **三种录法**：全屏、选区（像截图那样在屏幕上拉一个框）、窗口；
- **声音**：麦克风与扬声器可以分开开，也可以一起开（自动混音）；
- **两种格式**：MP4（H.264）或 GIF（GIF 存不了声音）；
- **存放位置**：默认是系统的「视频」文件夹，可以在插件里改；
- **快捷键**：默认 `Control+Shift+R`，可以改。**只有录屏的工作台窗口开着的时候才生效**——关掉窗口就把这个组合键让回给别的程序；
- 录制中桌面上会出现一个置顶的小控制条，显示时长与「停止」。
```

并在 README 的「哪些设置在设置窗口，哪些在插件里」那张表里加一行：

```markdown
| 录屏 | 面板里打开「录屏」→ 模式/声音/格式/存放位置；点「设置…」打开工作台改快捷键 |
```

- [ ] **Step 2: 跑全部测试**

```bash
npm run test:unit
npm run test:e2e
```

Expected: 全部 PASS。

- [ ] **Step 3: 手工验收清单**

逐条走一遍：

1. 面板搜「录屏」能打开，模式/声音/格式切换后**重开面板还在**（配置落盘了）；
2. 全屏录制 5 秒 → 产出 mp4，能播放；
3. 选区录制 → 遮罩出现 → 拉框 → 遮罩消失 → 开始录 → 产出 mp4 的画面尺寸正好是框的大小；
4. 窗口录制 → 列表里有窗口 → 选一个 → 产出 mp4；
5. 只开扬声器 → mp4 里有声音轨；只开麦克风 → 本机没有麦克风，会提示「没有拿到麦克风」；
6. 切到 GIF → 录 3 秒 → 产出 gif，能播放；
7. 输出目录改到别处 → 文件真的落在那儿；
8. 打开工作台 → 按 `Control+Shift+R` → 开始录制 → 再按一次 → 停止；
9. 关掉工作台 → 按 `Control+Shift+R` → **没有反应**（快捷键已经注销）；
10. 录制中关掉被录的窗口 → 录制自动停止，已有内容保存下来；
11. 退出程序 → 窗口全没了，进程正常退出（任务管理器里不留 electron.exe）。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: 录屏插件的使用说明"
```

---

## 附：技术事实备忘

实现时用得上的实测结论（在本机 Electron 45.1.0 / Windows 11 上跑过）：

| 事实 | 值 |
| --- | --- |
| `desktopCapturer.getSources()` 在主进程可用 | 显示器源 id 形如 `screen:0:0`，窗口源形如 `window:659066:0` |
| 显示器源与 `screen.getAllDisplays()` 的对应关系 | 源的 `display_id` 等于显示器的 `id` |
| 捕获轨的实际尺寸 | 2560×1440@30fps（物理像素，与显示器的物理分辨率一致） |
| `setDisplayMediaRequestHandler` 的回调 | `{ video: 源, audio: 'loopback' }`；`audio` 只在 Windows 上能录到系统声音 |
| `request.audioRequested` | 渲染层要了音频时才为 true |
| MediaRecorder 支持的容器 | `video/mp4;codecs=avc1.42E01E,mp4a.40.2`、`video/webm;codecs=vp8,opus` 都可用 |
| `file://` 页面 | 是 secure context，`navigator.mediaDevices` 可用；ES module 的 `import` 会被 CORS 拦掉 |
| 独立 session 分区 | `session.fromPartition('persist:screen-recorder')` 能正常捕获，不影响 defaultSession |
| 隐藏窗口里的定时器 | `webPreferences.backgroundThrottling: false` 才能按 33ms 稳定跑（实测 3 秒 91 帧） |
| canvas 裁剪 | `canvas.captureStream()` 出来的流尺寸正好是画布尺寸（实测 800×450） |

**本机没有音频输入设备**（只有 3 个输出设备），所以麦克风这条路只能验「没有设备时的提示」，没法验真的录到人声。
