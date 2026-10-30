# Live2D 桌面宠物 MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 桌面上运行一个透明置顶的 Live2D 桌宠（默认 Haru），支持待机动画、视线跟随、摸头/点击反应、拖拽移动、系统托盘、右键菜单、位置记忆、多屏适配，并支持运行时更换形象。

**Architecture:** Electron 主进程负责窗口/托盘/菜单/设置持久化/多显示器计算；渲染进程用 pixi.js v6 + pixi-live2d-display 渲染 Live2D Cubism 3 模型。渲染层资源经自建 `app://` 标准协议加载（`file://` 下 fetch 会被 CORS 拦截）。模型相关信息全部外置为 `pet.json` 清单，换形象只改数据不改代码。

**Tech Stack:** Electron ^45（ESM）、pixi.js 6.5.10、pixi-live2d-display 0.4.0、live2dcubismcore 1.0.2、Live2D 官方样例模型 Haru + Natori、node:test（单测）、@playwright/test（`_electron` 端到端）

**Spec:** `docs/superpowers/specs/2026-10-29-live2d-desk-pet-mvp-design.md`

## Global Constraints

- 目标平台仅 Windows 11；不做跨平台抽象，不写平台分支
- 交付形态为开发模式跑通，**不配置 electron-builder / 安装包**
- 全部源码使用 ESM：`package.json` 设 `"type": "module"`；preload 因需 `sandbox: true` 而使用 CommonJS，文件后缀 `.cjs`
- **禁止引入打包器**（无 esbuild / vite / webpack）。pixi 与 pixi-live2d-display 通过 `<script>` 全局加载
- 脚本加载顺序固定为 `pixi.js` → `live2dcubismcore.min.js` → `cubism4.min.js` → 应用模块
- **禁止使用 `-webkit-app-region: drag`**（会吞掉指针事件，使命中判定与摸头失效）
- 渲染进程必须 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 模型相关具体名字（`F05`、`TapBody`、`HitAreaHead` 等）**一律不得出现在交互逻辑代码中**，只能出现在 `pet.json` 清单里
- 命中区一律按 `HitArea.Name` 归一化（大小写不敏感），不按 `Id`
- 清单缺失时必须自动探测降级，不得抛错
- 切换模型时必须显式释放纹理，不得造成显存持续增长
- 依赖版本锁定：`pixi.js@6.5.10`、`pixi-live2d-display@0.4.0`、`live2dcubismcore@1.0.2`
- 提交信息使用 Conventional Commits 格式，结尾附 Co-Authored-By 行

## Review Focus

以下五类输入/状况是 spec 隐含但各任务测试未必然覆盖、最可能真正咬到使用者的点。每一项都已在其归属任务中安排了对应测试。

1. **配置文件被手工改坏**（`settings.json` 里 `scale` 是字符串 `"abc"`、`position` 是 `null`、多出未知字段）—— 期望应用正常启动并回退到默认值，而不是崩溃或渲染出 NaN 尺寸的模型。
2. **保存位置所在的显示器被拔掉** —— 期望角色回落到主显示器可见区域内的右下角，而不是停在屏幕外的不可见坐标。
3. **模型缺少某项能力**（无表情 / 无命中区 / 动作组改名）—— 期望该功能静默降级，其余功能（渲染、拖拽、视线跟随）仍完全可用，不抛异常。
4. **连续多次切换形象** —— 期望显存/纹理不持续增长，旧模型确实被销毁，切换后交互仍正常。
5. **窗口在屏幕边缘外 / 负坐标 / 跨越多屏边界** —— 期望角色始终完整可见且拖拽跟随准确，不出现半截身子在屏幕外的状态。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `package.json` | 依赖、脚本（start / setup / test） |
| `scripts/setup-assets.mjs` | 从 Live2D 官方仓库下载 Haru/Natori 模型资源到 `assets/live2d/models/`（幂等、可离线重跑） |
| `scripts/gen-icon.mjs` | 生成托盘图标 PNG（内置最小 PNG 编码器，无第三方依赖） |
| `assets/live2d/index.json` | 形象注册表 |
| `assets/live2d/models/<id>/pet.json` | 单个形象的清单：语义映射 + 动作映射 + 视口/缩放 |
| `assets/icons/tray.png`, `tray@2x.png` | 托盘图标（生成物，可被用户替换为自有图片） |
| `src/main/index.js` | 应用入口：生命周期、单实例锁、装配各模块 |
| `src/main/staticFiles.js` | **纯函数**：`resolveStaticFile(rootDir, urlPath)` |
| `src/main/settings.js` | 设置持久化：`sanitizeSettings`（纯函数）、`loadSettings`、`saveSettings` |
| `src/main/display.js` | **纯函数**：`clampToDisplays`、`defaultPosition` |
| `src/main/protocol.js` | 注册 `app://` 标准协议，静态资源服务 |
| `src/main/window.js` | 创建/更新宠物窗口 |
| `src/main/tray.js` | 系统托盘 |
| `src/main/menu.js` | 托盘菜单与右键原生菜单构建 |
| `src/main/menuTemplate.js` | 菜单模板（纯数据，与 Electron 解耦，可单测） |
| `src/main/ipc.js` | IPC 处理器装配 |
| `src/preload/index.cjs` | `contextBridge` 白名单 API |
| `src/renderer/index.html` | 渲染层页面（按序加载三个全局脚本 + 应用模块） |
| `src/renderer/main.js` | 渲染层引导，装配 stage/model/interaction |
| `src/renderer/pet/stage.js` | pixi Application 创建与模型缩放适配 |
| `src/renderer/pet/manifest.js` | 清单加载、能力探测、语义映射解析 |
| `src/renderer/pet/model.js` | 模型加载 / 切换 / 销毁 |
| `src/renderer/pet/texture.js` | 显式释放 Live2D 纹理（切换形象时防止显存泄漏） |
| `src/renderer/pet/hitZone.js` | 命中区归一化与几何兜底 |
| `src/renderer/pet/behavior.js` | 反应表：交互 → 表情 + 动作 |
| `src/renderer/pet/interaction.js` | 指针事件编排 |
| `src/renderer/ui/drag.js` | 拖拽状态机（点击 vs 拖拽判定） |
| `src/renderer/ui/contextMenu.js` | 右键菜单 IPC |
| `src/settings/index.html` + `src/settings/main.js` | 设置窗口 |
| `test/unit/*.test.js` | node:test 单测（纯函数） |
| `test/e2e/*.spec.js` | Playwright `_electron` 端到端 |
| `test/e2e/helpers.js` | 启动被测应用的公共封装 |

---

### Task 1: 项目脚手架、依赖、资源与图标脚本、冒烟测试

**Files:**
- Create: `package.json`
- Create: `scripts/setup-assets.mjs`
- Create: `scripts/gen-icon.mjs`
- Create: `assets/live2d/index.json`
- Create: `assets/live2d/models/haru/pet.json`
- Create: `assets/live2d/models/natori/pet.json`
- Create: `src/main/index.js`
- Create: `test/e2e/helpers.js`
- Create: `test/e2e/smoke.spec.js`
- Create: `playwright.config.js`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `npm start` 启动 Electron 并打开一个标题为 `Desk Pet` 的窗口
  - `npm run setup` 下载模型资源到 `assets/live2d/models/{haru,natori}/`，生成 `assets/icons/tray.png` 与 `tray@2x.png`
  - `npm test` 同时跑单测与 E2E
  - `test/e2e/helpers.js` 导出 `launchApp(options)` → `{ app, win, userDataDir }`，其中 `win` 已等待 `window.__pet.ready === true`；`options.env` 可追加环境变量
  - 主进程读取环境变量 `DESK_PET_USER_DATA`（存在时用其作为 userData 目录）与 `DESK_PET_E2E`（存在时跳过单实例锁）

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "desk-pet",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Live2D 桌面宠物",
  "main": "src/main/index.js",
  "scripts": {
    "start": "electron .",
    "setup": "node scripts/setup-assets.mjs && node scripts/gen-icon.mjs",
    "test": "npm run test:unit && npm run test:e2e",
    "test:unit": "node --test \"test/unit/**/*.test.js\"",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "live2dcubismcore": "1.0.2",
    "pixi-live2d-display": "0.4.0",
    "pixi.js": "6.5.10"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "electron": "^45.0.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 安装成功；`node_modules/electron/dist/electron.exe` 存在；`npm ls pixi.js pixi-live2d-display live2dcubismcore` 显示锁定版本。

- [ ] **Step 3: 写 `scripts/setup-assets.mjs`（下载官方样例模型，幂等）**

```js
// 从 Live2D 官方示例仓库拉取样例模型资源。
// 幂等：已存在且大小一致的文件会跳过，因此首次运行后即可离线重复执行。
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'assets', 'live2d', 'models');
const API = 'https://api.github.com/repos/Live2D/CubismWebSamples/git/trees/develop?recursive=1';
// 注意：GitHub tree API 返回的 f.path 已含 "Samples/Resources/" 前缀，
// 所以这里只能到 develop 为止，再拼 ${RAW}/${f.path}，否则会重复一层导致全部 404。
const RAW = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop';

const MODELS = [
  { id: 'haru', dir: 'Haru' },
  { id: 'natori', dir: 'Natori' },
];

async function fetchWithRetry(url, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw lastErr;
}

async function existingSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function downloadTree(tree, prefix, destRoot) {
  const files = tree.filter((n) => n.type === 'blob' && n.path.startsWith(prefix));
  let downloaded = 0;
  let skipped = 0;
  for (const f of files) {
    // 排除音效（MVP 不需要，且体积可观）
    if (f.path.includes('/sounds/')) continue;
    const rel = relative(prefix, f.path);
    const dest = join(destRoot, rel);
    if ((await existingSize(dest)) === f.size) {
      skipped++;
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    const res = await fetchWithRetry(`${RAW}/${f.path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== f.size) throw new Error(`大小不符 ${rel}: ${buf.length} != ${f.size}`);
    await writeFile(dest, buf);
    downloaded++;
  }
  return { downloaded, skipped };
}

const treeRes = await fetchWithRetry(API);
const tree = (await treeRes.json()).tree;
if (!Array.isArray(tree)) throw new Error('无法解析 GitHub tree 响应');

let totalDownloaded = 0;
let totalSkipped = 0;
for (const m of MODELS) {
  const destRoot = join(OUT_ROOT, m.id);
  await mkdir(destRoot, { recursive: true });
  const r = await downloadTree(tree, `Samples/Resources/${m.dir}/`, destRoot);
  totalDownloaded += r.downloaded;
  totalSkipped += r.skipped;
  console.log(`${m.id}: 下载 ${r.downloaded} 个, 跳过 ${r.skipped} 个`);
}
console.log(`完成：新增 ${totalDownloaded} 个文件, 复用 ${totalSkipped} 个文件`);
```

- [ ] **Step 4: 写 `scripts/gen-icon.mjs`（生成托盘图标 PNG）**

```js
// 生成托盘图标 PNG，不依赖任何第三方图像库。
// 输出 32x32 与 64x64 两个尺寸，托盘优先使用 @2x。
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 以 4 倍超采样绘制再降采样，得到平滑边缘。
function drawIcon(size) {
  const S = 4;
  const W = size * S;
  const acc = new Float32Array(W * W * 4);
  const put = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const sa = a / 255;
    acc[i] = acc[i] * (1 - sa) + r * sa;
    acc[i + 1] = acc[i + 1] * (1 - sa) + g * sa;
    acc[i + 2] = acc[i + 2] * (1 - sa) + b * sa;
    acc[i + 3] = acc[i + 3] * (1 - sa) + a;
  };
  const ell = (cx, cy, rx, ry, color) => {
    const x0 = Math.floor((cx - rx) * W), x1 = Math.ceil((cx + rx) * W);
    const y0 = Math.floor((cy - ry) * W), y1 = Math.ceil((cy + ry) * W);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5) / W, ny = (y + 0.5) / W;
        const d = ((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2;
        if (d <= 1) put(x, y, color);
      }
    }
  };
  const arc = (cx, cy, r, thick, yMin, color) => {
    const x0 = Math.floor((cx - r - thick) * W), x1 = Math.ceil((cx + r + thick) * W);
    const y0 = Math.floor((cy - r - thick) * W), y1 = Math.ceil((cy + r + thick) * W);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5) / W, ny = (y + 0.5) / W;
        const d = Math.abs(Math.hypot(nx - cx, ny - cy) - r);
        if (d <= thick && ny >= yMin) put(x, y, color);
      }
    }
  };

  const HAIR = [138, 118, 196, 255];
  const SKIN = [250, 219, 191, 255];
  const INK = [58, 48, 68, 255];
  const BLUSH = [243, 146, 158, 150];
  const OUTLINE = [90, 74, 120, 255];

  ell(0.5, 0.40, 0.44, 0.36, HAIR);       // 头发
  ell(0.5, 0.44, 0.40, 0.30, OUTLINE);    // 外描边
  ell(0.5, 0.46, 0.38, 0.28, SKIN);       // 脸
  ell(0.5, 0.36, 0.40, 0.24, HAIR);       // 刘海
  ell(0.385, 0.53, 0.055, 0.075, INK);    // 左眼
  ell(0.615, 0.53, 0.055, 0.075, INK);    // 右眼
  ell(0.275, 0.62, 0.075, 0.045, BLUSH);  // 左腮红
  ell(0.725, 0.62, 0.075, 0.045, BLUSH);  // 右腮红
  arc(0.5, 0.60, 0.10, 0.018, 0.60, INK); // 微笑

  // 降采样到目标尺寸
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; a += acc[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      out[o] = Math.round(alpha > 0 ? r / n : 0);
      out[o + 1] = Math.round(alpha > 0 ? g / n : 0);
      out[o + 2] = Math.round(alpha > 0 ? b / n : 0);
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'assets', 'icons');
await mkdir(ICON_DIR, { recursive: true });
for (const size of [32, 64]) {
  const png = encodePng(size, size, drawIcon(size));
  const name = size === 32 ? 'tray.png' : 'tray@2x.png';
  await writeFile(join(ICON_DIR, name), png);
  console.log(`已生成 assets/icons/${name} (${size}x${size}, ${png.length} 字节)`);
}
```

- [ ] **Step 5: 写形象注册表与两个清单**

`assets/live2d/index.json`：

```json
{
  "models": [
    { "id": "haru", "name": "Haru", "manifest": "haru/pet.json", "model3": "Haru.model3.json" },
    { "id": "natori", "name": "Natori", "manifest": "natori/pet.json", "model3": "Natori.model3.json" }
  ]
}
```

> 注册表里的 `model3` 字段是**兜底**用的：当某个模型目录没有 `pet.json` 时，
> `loadManifest` 仍能知道该加载哪个 `.model3.json`，从而满足「把模型目录放进去就能加载」的要求。

`assets/live2d/models/haru/pet.json`：

```json
{
  "id": "haru",
  "name": "Haru",
  "model3": "Haru.model3.json",
  "viewport": { "width": 300, "height": 560 },
  "fit": { "scale": 1.0, "anchor": [0.5, 1.0], "offset": [0, 0] },
  "expressions": {
    "normal": "F01",
    "happy": "F05",
    "smile": "F08",
    "shy": "F07",
    "angry": "F02",
    "surprised": "F06",
    "sad": "F03"
  },
  "motions": {
    "idle": { "group": "Idle", "index": 0 },
    "tapHead": { "group": "TapBody", "index": 0 },
    "tapBody": { "group": "TapBody", "index": 1 },
    "drag": { "group": "TapBody", "index": 3 }
  }
}
```

`assets/live2d/models/natori/pet.json`：

```json
{
  "id": "natori",
  "name": "Natori",
  "model3": "Natori.model3.json",
  "viewport": { "width": 300, "height": 560 },
  "fit": { "scale": 1.0, "anchor": [0.5, 1.0], "offset": [0, 0] },
  "expressions": {
    "normal": "Normal",
    "happy": "Smile",
    "smile": "Smile",
    "shy": "Blushing",
    "angry": "Angry",
    "surprised": "Surprised",
    "sad": "Sad"
  },
  "motions": {
    "idle": { "group": "Idle", "index": 0 },
    "tapHead": { "group": "TapBody", "index": 0 },
    "tapBody": { "group": "TapBody", "index": 1 },
    "drag": { "group": "TapBody", "index": 2 }
  }
}
```

- [ ] **Step 6: 写最小主进程 `src/main/index.js`**

此版本只负责把窗口开起来并暴露 `window.__pet.ready`，供冒烟测试断言。后续任务会逐步替换其内容。

```js
import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.env.DESK_PET_USER_DATA) {
  app.setPath('userData', process.env.DESK_PET_USER_DATA);
}

if (!process.env.DESK_PET_E2E && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 300,
    height: 560,
    show: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // 注意：此时 src/preload/index.cjs 还不存在（Task 3 才创建），先不挂 preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 标题必须是 "Desk Pet"：本任务的冒烟测试会断言 window.title()
  win.loadURL(
    'data:text/html,<title>Desk Pet</title><body style="background:transparent">' +
      '<script>window.__pet={ready:true}</script></body>'
  );
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
```

- [ ] **Step 7: 写 E2E 辅助与冒烟测试**

`test/e2e/helpers.js`：

```js
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function launchApp(options = {}) {
  const userDataDir = options.userDataDir || (await mkdtemp(join(tmpdir(), 'desk-pet-e2e-')));
  const app = await electron.launch({
    args: [join(ROOT, 'src', 'main', 'index.js')],
    cwd: ROOT,
    env: {
      ...process.env,
      DESK_PET_E2E: '1',
      DESK_PET_USER_DATA: userDataDir,
      ...(options.env || {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });
  return {
    app,
    win,
    userDataDir,
    async close() {
      await app.close();
      if (!options.userDataDir) await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
```

`test/e2e/smoke.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('应用能启动并打开窗口', async () => {
  const ctx = await launchApp();
  try {
    expect(await ctx.win.title()).toBe('Desk Pet');
    const size = await ctx.win.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(size.w).toBe(300);
    expect(size.h).toBe(560);
  } finally {
    await ctx.close();
  }
});
```

`playwright.config.js`：

```js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
```

- [ ] **Step 8: 准备资源并验证图标生成**

Run: `npm run setup`
Expected: 输出 `haru: 下载 N 个, 跳过 0 个` / `natori: 下载 N 个, 跳过 0 个`；`assets/icons/tray.png` 与 `tray@2x.png` 生成；`ls assets/live2d/models/haru` 至少包含 `Haru.model3.json`、`Haru.moc3`、`Haru.2048/`、`expressions/`、`motions/`。

- [ ] **Step 9: 写托盘图标有效性单测**

`test/unit/icon.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readPng(path) {
  let buf;
  try {
    buf = await readFile(path);
  } catch {
    assert.fail(`缺少 ${path}，请先运行 npm run setup`);
  }
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${path} 不是合法 PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('托盘图标存在且尺寸正确', async () => {
  const small = await readPng(join(ROOT, 'assets', 'icons', 'tray.png'));
  assert.equal(small.width, 32);
  assert.equal(small.height, 32);
  const large = await readPng(join(ROOT, 'assets', 'icons', 'tray@2x.png'));
  assert.equal(large.width, 64);
  assert.equal(large.height, 64);
});
```

- [ ] **Step 10: 跑冒烟测试与单测**

Run: `npx playwright test test/e2e/smoke.spec.js && npm run test:unit`
Expected: 冒烟测试 PASS（1 passed）；单测 PASS（1 passed）。

- [ ] **Step 11: 提交**

```bash
git add package.json package-lock.json scripts/ assets/live2d/index.json assets/live2d/models/haru/pet.json assets/live2d/models/natori/pet.json assets/icons/ src/main/index.js test/ playwright.config.js
git commit -m "feat: 初始化 Electron 脚手架、模型资源脚本与托盘图标生成"
```

> 注意：`assets/live2d/models/{haru,natori}/` 下的官方样例资源约 9 MB，**不要提交**（保留在 .gitignore 中），由 `npm run setup` 获取。提交前先执行 `git add` 时只挑选 `pet.json`。

---

### Task 2: 主进程纯函数层（静态资源解析 / 设置校验 / 多显示器）

**Files:**
- Create: `src/main/staticFiles.js`
- Create: `src/main/settings.js`
- Create: `src/main/display.js`
- Create: `test/unit/staticFiles.test.js`
- Create: `test/unit/settings.test.js`
- Create: `test/unit/display.test.js`

**Interfaces:**
- Consumes: Task 1 的 `package.json`（`"type": "module"`，故单测可直接 `import` 源码）
- Produces:
  - `src/main/staticFiles.js` → `resolveStaticFile(rootDir: string, urlPath: string): { filePath: string } | null`
  - `src/main/settings.js` → `DEFAULT_SETTINGS: object`、`sanitizeSettings(raw: unknown): Settings`、`loadSettings(userDataDir: string): Promise<Settings>`、`saveSettings(userDataDir: string, settings: unknown): Promise<Settings>`
  - `src/main/display.js` → `clampToDisplays(x, y, width, height, displays): { x: number, y: number }`、`restorePosition(saved, width, height, displays): { x: number, y: number }`、`defaultPosition(width, height, displays): { x: number, y: number }`
  - `displays` 元素结构：`{ id: number|string, bounds: {x,y,width,height}, workArea: {x,y,width,height} }`

- [ ] **Step 1: 写 `test/unit/staticFiles.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticFile } from '../../src/main/staticFiles.js';

const ROOT = 'C:\\app';

test('解析正常路径', () => {
  const r = resolveStaticFile(ROOT, '/src/renderer/index.html');
  assert.ok(r);
  assert.equal(r.filePath, 'C:\\app\\src\\renderer\\index.html');
});

test('根路径映射到渲染层入口', () => {
  const r = resolveStaticFile(ROOT, '/');
  assert.ok(r);
  assert.equal(r.filePath, 'C:\\app\\src\\renderer\\index.html');
});

test('阻止目录穿越', () => {
  assert.equal(resolveStaticFile(ROOT, '/../../secret.txt'), null);
  assert.equal(resolveStaticFile(ROOT, '/..%2f..%2fsecret.txt'), null);
  assert.equal(resolveStaticFile(ROOT, '/src/../../secret.txt'), null);
});

test('阻止与根目录同前缀的兄弟目录', () => {
  // 关键用例：/../app-evil/secret.txt 解析到 C:\app-evil\secret.txt。
  // 只做 startsWith(root) 的朴素实现会错误地放行它；
  // 只有带路径分隔符边界的检查（root + sep）才会拒绝。
  assert.equal(resolveStaticFile(ROOT, '/../app-evil/secret.txt'), null);
});

test('允许 node_modules 下的路径', () => {
  const r = resolveStaticFile(ROOT, '/node_modules/pixi.js/dist/browser/pixi.js');
  assert.ok(r);
  assert.ok(r.filePath.includes('node_modules'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/staticFiles.test.js`
Expected: FAIL —— `Cannot find module .../src/main/staticFiles.js`

- [ ] **Step 3: 实现 `src/main/staticFiles.js`**

```js
import { join, resolve, sep } from 'node:path';

const ROOT_INDEX = '/src/renderer/index.html';

/**
 * 把 app:// 请求的 URL 路径解析为项目内的真实文件路径。
 * 任何越界（目录穿越）一律返回 null。
 */
export function resolveStaticFile(rootDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath || '/');
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = ROOT_INDEX;
  // 统一为 POSIX 风格分隔符后再处理
  const normalized = decoded.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) return null;

  const root = resolve(rootDir);
  const target = resolve(join(root, normalized));
  // 必须严格位于 root 之内（分隔符边界，避免 /app-evil 误判）
  if (target !== root && !target.startsWith(root + sep)) return null;
  return { filePath: target };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/staticFiles.test.js`
Expected: PASS（4 passed）。

- [ ] **Step 5: 写 `test/unit/settings.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeSettings, loadSettings, saveSettings, DEFAULT_SETTINGS } from '../../src/main/settings.js';

test('空输入返回默认设置', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings('nonsense'), DEFAULT_SETTINGS);
});

test('非法字段回退默认值', () => {
  const s = sanitizeSettings({ scale: 'abc', opacity: 99, modelId: 42, position: 'x,y' });
  assert.equal(s.scale, DEFAULT_SETTINGS.scale);
  assert.equal(s.opacity, DEFAULT_SETTINGS.opacity);
  assert.equal(s.modelId, DEFAULT_SETTINGS.modelId);
  assert.equal(s.position, null);
});

test('合法值被保留', () => {
  const s = sanitizeSettings({
    position: { x: 100, y: 200 },
    modelId: 'natori',
    scale: 1.5,
    opacity: 0.5,
    visible: false,
  });
  assert.deepEqual(s.position, { x: 100, y: 200 });
  assert.equal(s.modelId, 'natori');
  assert.equal(s.scale, 1.5);
  assert.equal(s.opacity, 0.5);
  assert.equal(s.visible, false);
});

test('未知字段被丢弃', () => {
  const s = sanitizeSettings({ scale: 1, evil: 'payload' });
  assert.equal(s.evil, undefined);
});

test('数值被夹紧到合法区间', () => {
  assert.equal(sanitizeSettings({ scale: 99 }).scale, 2);
  assert.equal(sanitizeSettings({ scale: 0.01 }).scale, 0.5);
  assert.equal(sanitizeSettings({ opacity: -1 }).opacity, 0.2);
});

test('配置文件缺失时回退默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  try {
    assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置文件损坏时回退默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  try {
    await writeFile(join(dir, 'settings.json'), '{ 这不是合法 JSON', 'utf8');
    assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存后能读回，且会创建不存在的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  const dir = join(root, 'nested', 'deeper');
  try {
    const saved = await saveSettings(dir, {
      modelId: 'natori',
      scale: 1.5,
      opacity: 0.8,
      position: { x: 10, y: 20 },
    });
    assert.equal(saved.modelId, 'natori');
    const loaded = await loadSettings(dir);
    assert.equal(loaded.modelId, 'natori');
    assert.equal(loaded.scale, 1.5);
    assert.equal(loaded.opacity, 0.8);
    assert.deepEqual(loaded.position, { x: 10, y: 20 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `node --test test/unit/settings.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 7: 实现 `src/main/settings.js`**

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  position: null,
  modelId: 'haru',
  scale: 1.0,
  opacity: 1.0,
  visible: true,
});

const SCALE_RANGE = { min: 0.5, max: 2.0 };
const OPACITY_RANGE = { min: 0.2, max: 1.0 };

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把任意输入规整为合法设置对象；非法值一律回退默认值，绝不抛错。 */
export function sanitizeSettings(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULT_SETTINGS };

  const out = { ...DEFAULT_SETTINGS };

  if (isPlainObject(raw.position)) {
    const { x, y } = raw.position;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      out.position = { x: Math.round(x), y: Math.round(y) };
    }
  }
  if (typeof raw.modelId === 'string' && raw.modelId.trim() !== '') {
    out.modelId = raw.modelId.trim();
  }
  out.scale = clampNumber(raw.scale, SCALE_RANGE.min, SCALE_RANGE.max, DEFAULT_SETTINGS.scale);
  out.opacity = clampNumber(raw.opacity, OPACITY_RANGE.min, OPACITY_RANGE.max, DEFAULT_SETTINGS.opacity);
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  if (typeof raw.version === 'number') out.version = raw.version;

  return out;
}

export async function loadSettings(userDataDir) {
  try {
    const text = await readFile(join(userDataDir, 'settings.json'), 'utf8');
    return sanitizeSettings(JSON.parse(text));
  } catch (err) {
    // 文件不存在是正常情况（首次启动），静默回退默认值即可。
    // 但读不了/解析失败说明配置已损坏——同样回退默认值，却必须留痕，
    // 否则用户会遇到「改了设置没生效」且无从排查。
    if (err?.code !== 'ENOENT') {
      console.warn('[desk-pet] settings.json 无法读取或解析，已回退默认值：', err?.message);
    }
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(userDataDir, settings) {
  const clean = sanitizeSettings(settings);
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, 'settings.json'), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test test/unit/settings.test.js`
Expected: PASS（5 passed）。

- [ ] **Step 9: 写 `test/unit/display.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToDisplays, defaultPosition, restorePosition } from '../../src/main/display.js';

const PRIMARY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const SECOND = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
};

test('位置完整落在某显示器工作区内时保持不变', () => {
  const r = clampToDisplays(100, 100, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 100, y: 100 });
});

test('副显示器上的位置同样被保留', () => {
  const r = clampToDisplays(3000, 200, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 3000, y: 200 });
});

test('位置超出所有显示器时回落到最近的显示器并夹紧', () => {
  const r = clampToDisplays(99999, 99999, 300, 560, [PRIMARY]);
  assert.ok(r.x >= 0 && r.x <= PRIMARY.workArea.width - 300);
  assert.ok(r.y >= 0 && r.y <= PRIMARY.workArea.height - 560);
});

test('显示器被拔掉后坐标回落到主显示器内', () => {
  const r = clampToDisplays(3000, 200, 300, 560, [PRIMARY]);
  assert.ok(r.x >= 0 && r.x <= PRIMARY.workArea.width - 300);
  assert.ok(r.y >= 0 && r.y <= PRIMARY.workArea.height - 560);
});

test('负坐标被夹紧回可见区域', () => {
  const r = clampToDisplays(-500, -500, 300, 560, [PRIMARY]);
  assert.ok(r.x >= 0 && r.y >= 0);
});

test('默认位置落在主显示器右下角', () => {
  const r = defaultPosition(300, 560, [PRIMARY, SECOND]);
  assert.equal(r.x, PRIMARY.workArea.width - 300);
  assert.equal(r.y, PRIMARY.workArea.height - 560);
});

test('没有显示器时返回原点', () => {
  assert.deepEqual(defaultPosition(300, 560, []), { x: 0, y: 0 });
});

test('恢复位置：位置可见时原样返回', () => {
  const r = restorePosition({ x: 100, y: 100 }, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 100, y: 100 });
});

test('恢复位置：副显示器上的位置同样原样返回', () => {
  const r = restorePosition({ x: 3000, y: 200 }, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 3000, y: 200 });
});

test('恢复位置：显示器被拔掉时回落到主显示器右下角', () => {
  const r = restorePosition({ x: 3000, y: 200 }, 300, 560, [PRIMARY]);
  assert.deepEqual(r, { x: PRIMARY.workArea.width - 300, y: PRIMARY.workArea.height - 560 });
});

test('恢复位置：没有保存位置时回落到主显示器右下角', () => {
  const r = restorePosition(null, 300, 560, [PRIMARY]);
  assert.deepEqual(r, { x: PRIMARY.workArea.width - 300, y: PRIMARY.workArea.height - 560 });
});

test('拖拽夹紧与启动恢复语义不同', () => {
  const saved = { x: 3000, y: 200 };
  // 副显示器被拔掉后
  const clamped = clampToDisplays(saved.x, saved.y, 300, 560, [PRIMARY]);
  const restored = restorePosition(saved, 300, 560, [PRIMARY]);
  // 拖拽：停在主显示器可见区域边缘，不跳回右下角
  assert.notDeepEqual(clamped, restored);
  assert.ok(clamped.x >= 0 && clamped.y >= 0);
  // 启动恢复：回到主显示器右下角
  assert.deepEqual(restored, { x: PRIMARY.workArea.width - 300, y: PRIMARY.workArea.height - 560 });
});
```

- [ ] **Step 10: 跑测试确认失败**

Run: `node --test test/unit/display.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 11: 实现 `src/main/display.js`**

```js
function rectContains(area, x, y, width, height) {
  return (
    x >= area.x &&
    y >= area.y &&
    x + width <= area.x + area.width &&
    y + height <= area.y + area.height
  );
}

function distanceToRect(area, x, y) {
  // 到矩形的距离（而非到中心的距离）：点在两块屏幕正下方时，
  // 中心距离会选中更远的那块，矩形距离才总是选最近的。
  const dx = Math.max(area.x - x, 0, x - (area.x + area.width));
  const dy = Math.max(area.y - y, 0, y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

/**
 * 把窗口位置夹紧到某个显示器的可见工作区内。
 * 用于**拖拽过程中的实时夹紧**——角色被拖到屏幕边缘时应停在最近的可见处，
 * 而不是跳回主显示器。
 * 若原位置已完整落在某显示器内则原样返回。
 */
export function clampToDisplays(x, y, width, height, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPosition(width, height, list);

  for (const d of list) {
    if (rectContains(d.workArea, x, y, width, height)) return { x, y };
  }

  // 选与该点距离最近的屏幕
  let best = list[0];
  let bestDist = Infinity;
  for (const d of list) {
    const dist = distanceToRect(d.workArea, x, y);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  const wa = best.workArea;
  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - height);
  return {
    x: Math.min(Math.max(x, wa.x), maxX),
    y: Math.min(Math.max(y, wa.y), maxY),
  };
}

/**
 * 启动时恢复上次保存的位置（spec §5.5）。
 * 位置完整落在某显示器可见区域内 → 原样恢复；
 * 否则（例如保存位置所在的显示器已被拔掉）→ 回落到**主显示器可见区域内的默认位置（右下角）**。
 *
 * 与 clampToDisplays 的分工：clampToDisplays 服务于拖拽（停在最近的可见处），
 * restorePosition 服务于启动恢复（回到主显示器默认位置）。两者语义不同，不能混用。
 */
export function restorePosition(saved, width, height, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    for (const d of list) {
      if (rectContains(d.workArea, saved.x, saved.y, width, height)) {
        return { x: saved.x, y: saved.y };
      }
    }
  }
  return defaultPosition(width, height, list);
}

/**
 * 主显示器可见区域右下角的位置。
 * **前置条件：`displays[0]` 必须是主显示器**——调用方（Task 3 的 currentDisplays）
 * 负责把主显示器排在数组第一位，Electron 的 `getAllDisplays()` 并不保证这一点。
 */
export function defaultPosition(width, height, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  const wa = list[0].workArea;
  return {
    x: wa.x + Math.max(0, wa.width - width),
    y: wa.y + Math.max(0, wa.height - height),
  };
}
```

- [ ] **Step 12: 跑全部单测**

Run: `npm run test:unit`
Expected: PASS（29 passed —— 本任务 26 个 + Task 1 遗留的 icon 3 个）。

- [ ] **Step 13: 提交**

```bash
git add src/main/staticFiles.js src/main/settings.js src/main/display.js test/unit/
git commit -m "feat: 主进程纯函数层（静态资源解析、设置校验、多显示器夹紧）"
```

---

### Task 3: app:// 协议、宠物窗口、托盘、右键菜单、IPC、preload

**Files:**
- Create: `src/main/protocol.js`
- Create: `src/main/window.js`
- Create: `src/main/tray.js`
- Create: `src/main/menuTemplate.js`
- Create: `src/main/menu.js`
- Create: `src/main/ipc.js`
- Create: `src/preload/index.cjs`
- Modify: `src/main/index.js`
- Create: `src/renderer/index.html`（占位，后续任务填充）
- Modify: `test/e2e/smoke.spec.js`
- Create: `test/unit/menuTemplate.test.js`

**Interfaces:**
- Consumes: Task 2 的 `resolveStaticFile`、`sanitizeSettings`/`loadSettings`/`saveSettings`、`clampToDisplays`/`defaultPosition`
- Produces:
  - `src/main/protocol.js` → `registerAppProtocol(rootDir: string): void`、`appUrl(pathname: string): string`
  - `src/main/window.js` → `createPetWindow(opts: { rootDir, settings, displays }): BrowserWindow`、`applySettingsToWindow(win, settings): void`
  - `src/main/menu.js` → `buildContextMenu(actions: object): Menu`、`buildTrayMenu(actions: object): Menu`
  - `src/main/tray.js` → `createTray(opts: { iconPath, onAction }): Tray`
  - `src/main/ipc.js` → `registerIpc(opts: object): void`
  - `src/preload/index.cjs` → 渲染层全局 `window.pet`，方法：`getSettings()`、`saveSettings(patch)`、`listModels()`、`switchModel(id)`、`showContextMenu()`、`openSettings()`、`onModelSwitchRequest(cb)`（Task 8 追加 `moveWindowBy`，Task 9 追加 `onSettingsChanged`）

- [ ] **Step 1: 实现 `src/main/protocol.js`**

```js
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolveStaticFile } from './staticFiles.js';

const SCHEME = 'app';
const HOST = 'bundle';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.ico': 'image/x-icon',
};

/** 必须在 app ready 之前调用。 */
export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** 必须在 app ready 之后调用。 */
export function registerAppProtocol(rootDir) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // 拒绝以点开头的路径段（.git / .env / .superpowers 等）。
    // app:// 的根是整个项目目录，渲染层不需要这些内容，
    // 一旦漏出去就能读到版本库配置与本地密钥文件。
    // 每个路径段都要**先解码再判断**：WHATWG URL 不会规范化 %2e，
    // 而 resolveStaticFile 会解码——不先解码的话 %2egit 能绕过这个检查，
    // 实测 app://bundle/%2egit/config 曾返回 200。
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .flatMap((seg) => {
        let decoded = seg;
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          decoded = seg;
        }
        // 反斜杠同样是分隔符：%5c 解码后是 "\"，不当作分隔符的话
        // "\.git" 不以 "." 开头，能绕过这个检查；而 resolveStaticFile 会把
        // "\" 归一化成 "/"，最终仍指向 <root>/.git/config。
        return decoded.replace(/\\/g, '/').split('/');
      })
      .filter(Boolean);
    if (segments.some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
      return new Response('Forbidden', { status: 403 });
    }
    const resolved = resolveStaticFile(rootDir, url.pathname);
    if (!resolved) return new Response('Not Found', { status: 404 });
    try {
      const data = await readFile(resolved.filePath);
      const type = MIME[extname(resolved.filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type } });
    } catch (err) {
      // 权限错误、EISDIR 等与「文件不存在」必须区分，否则无法排查。
      if (err?.code !== 'ENOENT') {
        console.warn('[desk-pet] 资源读取失败：', resolved.filePath, err?.message);
      }
      return new Response('Not Found', { status: 404 });
    }
  });
}

export function appUrl(pathname) {
  return `${SCHEME}://${HOST}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}
```

- [ ] **Step 2: 实现 `src/main/window.js`**

```js
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { appUrl } from './protocol.js';
import { restorePosition } from './display.js';

// 视口尺寸与 assets/live2d/models/*/pet.json 的 viewport 保持一致。
// settings 里的 viewport 会被 sanitizeSettings 丢弃，所以不能从那里取。
const PET_VIEWPORT = { width: 300, height: 560 };

export function createPetWindow({ rootDir, settings, displays }) {
  const vp = PET_VIEWPORT;
  // 用 restorePosition 而不是 clampToDisplays：启动恢复时若保存位置所在的显示器
  // 已被拔掉，应回落到主显示器右下角（spec §5.5），而不是停在原坐标的可见边缘。
  const pos = restorePosition(settings.position, vp.width, vp.height, displays);

  const win = new BrowserWindow({
    width: vp.width,
    height: vp.height,
    x: pos.x,
    y: pos.y,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(rootDir, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true);
  win.loadURL(appUrl('/src/renderer/index.html'));
  win.once('ready-to-show', () => {
    applySettingsToWindow(win, settings);
    if (settings.visible !== false) win.showInactive();
  });
  return win;
}

export function applySettingsToWindow(win, settings) {
  if (!win || win.isDestroyed()) return;
  if (typeof settings.opacity === 'number') {
    win.setOpacity(settings.opacity);
  }
}
```

- [ ] **Step 3: 实现 `src/main/menuTemplate.js`（纯数据，可单测）**

菜单模板刻意与 Electron 解耦：`electron` 包在 Node 下的 ESM 具名导入不可用，
把模板放在独立模块里才能在没有 Electron 运行时的情况下做单测。

```js
/** 角色右键菜单 / 托盘菜单共用的模板。返回普通数组，便于单测。 */
export function menuTemplate(actions) {
  return [
    { label: '显示 / 隐藏', click: () => actions.toggleVisible() },
    { type: 'separator' },
    { label: '设置…', click: () => actions.openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ];
}
```

- [ ] **Step 4: 实现 `src/main/menu.js`**

```js
import { Menu } from 'electron';
import { menuTemplate } from './menuTemplate.js';

export function buildContextMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}

export function buildTrayMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}
```

- [ ] **Step 5: 写菜单模板单测**

`test/unit/menuTemplate.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { menuTemplate } from '../../src/main/menuTemplate.js';

function makeActions() {
  const calls = [];
  return {
    calls,
    toggleVisible: () => calls.push('toggleVisible'),
    openSettings: () => calls.push('openSettings'),
    quit: () => calls.push('quit'),
  };
}

test('菜单包含显示隐藏、设置、退出三项', () => {
  const tpl = menuTemplate(makeActions());
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ['显示 / 隐藏', '设置…', '退出']);
});

test('点击各菜单项触发对应动作', () => {
  const actions = makeActions();
  const tpl = menuTemplate(actions);
  for (const item of tpl) item.click?.();
  assert.deepEqual(actions.calls, ['toggleVisible', 'openSettings', 'quit']);
});
```

- [ ] **Step 6: 跑单测确认通过**

Run: `node --test test/unit/menuTemplate.test.js`
Expected: PASS（2 passed）。

- [ ] **Step 7: 实现 `src/main/tray.js`**

```js
import { Tray, nativeImage } from 'electron';

export function createTray({ iconPath }) {
  const image = nativeImage.createFromPath(iconPath);
  const resized = image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
  const tray = new Tray(resized);
  tray.setToolTip('桌面宠物');
  // 刻意不注册 click 回调：Windows 上托盘带右键菜单时，左键点击可能
  // 既触发 click 又弹出菜单，导致「显示/隐藏」被连按两次。
  // 托盘的三个动作（显示/隐藏、设置、退出）都在右键菜单里。
  return tray;
}
```

- [ ] **Step 8: 实现 `src/preload/index.cjs`**

```js
const { contextBridge, ipcRenderer } = require('electron');

// 白名单 API：只暴露渲染层真正需要的能力，其余一律不开放。
// Task 8 会追加 moveWindowBy，Task 9 会追加 onSettingsChanged。
contextBridge.exposeInMainWorld('pet', {
  getSettings: () => ipcRenderer.invoke('pet:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('pet:saveSettings', patch),
  listModels: () => ipcRenderer.invoke('pet:listModels'),
  switchModel: (id) => ipcRenderer.invoke('pet:switchModel', id),
  showContextMenu: () => ipcRenderer.invoke('pet:showContextMenu'),
  openSettings: () => ipcRenderer.invoke('pet:openSettings'),
  onModelSwitchRequest: (cb) => {
    ipcRenderer.on('pet:modelSwitchRequest', (_e, modelId) => cb(modelId));
  },
});
```

- [ ] **Step 9: 实现 `src/main/ipc.js`**

「打开设置窗口」与「弹出右键菜单」是两个独立职责，必须是两个独立回调。

```js
import { ipcMain } from 'electron';

// 只注册渲染层实际用得到的通道；托盘/右键菜单的行为由主进程直接执行，不走 IPC。
export function registerIpc({
  getSettings,
  saveSettings,
  listModels,
  switchModel,
  onOpenSettings,
  onShowContextMenu,
}) {
  ipcMain.handle('pet:getSettings', () => getSettings());
  ipcMain.handle('pet:saveSettings', (_e, patch) => saveSettings(patch));
  ipcMain.handle('pet:listModels', () => listModels());
  ipcMain.handle('pet:switchModel', (_e, modelId) => switchModel(modelId));
  ipcMain.handle('pet:showContextMenu', () => onShowContextMenu());
  ipcMain.handle('pet:openSettings', () => onOpenSettings());
}
```

- [ ] **Step 10: 写占位渲染页 `src/renderer/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Desk Pet</title>
  <style>
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    #stage { position: absolute; inset: 0; }
  </style>
</head>
<body>
  <div id="stage"></div>
  <script type="module">
    window.__pet = { ready: true };
  </script>
</body>
</html>
```

- [ ] **Step 11: 重写 `src/main/index.js`**

```js
import { app, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { registerSchemePrivileges, registerAppProtocol } from './protocol.js';
import { createPetWindow } from './window.js';
import { createTray } from './tray.js';
import { buildContextMenu, buildTrayMenu } from './menu.js';
import { registerIpc } from './ipc.js';
import { loadSettings, saveSettings, sanitizeSettings } from './settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.env.DESK_PET_USER_DATA) {
  // setPath 要求目标目录已存在，否则会抛错（Task 1 的 E2E 用例依赖这一点）。
  mkdirSync(process.env.DESK_PET_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.DESK_PET_USER_DATA);
}
registerSchemePrivileges();

const IS_E2E = Boolean(process.env.DESK_PET_E2E);
if (!IS_E2E && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let settings = null;
let saveTimer = null;
// 正在进行的写入。防抖计时器触发后 saveTimer 会被置空，
// 但写入可能还没落盘完成——只盯 saveTimer 会漏掉这个窗口。
let pendingWrite = null;

function currentDisplays() {
  // 主显示器必须排在第一位：display.js 的 defaultPosition 依赖 displays[0] 是主显示器，
  // 而 Electron 的 getAllDisplays() 并不保证这一点。
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  return [primary, ...all.filter((d) => d.id !== primary.id)].map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
  }));
}

async function readModelRegistry() {
  try {
    const text = await readFile(join(ROOT, 'assets', 'live2d', 'index.json'), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch (err) {
    // 注册表损坏或读不到时静默返回空列表，会让「形象列表是空的」这件事无从排查——
    // 与 settings 损坏同理，必须留痕。
    console.warn('[desk-pet] 形象注册表读取失败：', err?.message);
    return [];
  }
}

function persist(patch) {
  // 必须过一遍 sanitizeSettings：否则渲染层传来的越界值（例如 opacity=1.5）
  // 会留在内存里，而落盘时被夹紧——内存与磁盘不一致，
  // getSettings 会把越界值发回渲染层，Task 9 还会拿它去调 win.setOpacity()。
  settings = sanitizeSettings({ ...settings, ...patch });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSettings();
  }, 300);
  return settings;
}

function writeSettings() {
  // 串行化：若上一次写入还没落盘，新的写入必须排在它后面。
  // 否则两次写入重叠时，先发的旧内容可能后落盘，把新设置覆盖掉。
  const p = (pendingWrite || Promise.resolve())
    .catch(() => {})
    .then(() => saveSettings(app.getPath('userData'), settings))
    .catch((err) => {
      // 写失败必须留痕：用户改了设置没生效，却既没有现象也没有日志，无从排查。
      console.warn('[desk-pet] settings 保存失败：', err?.message);
    })
    .finally(() => {
      if (pendingWrite === p) pendingWrite = null;
    });
  pendingWrite = p;
  return p;
}

// 退出前把待写入的设置落盘——否则用户在 300ms 防抖窗口内退出，改动就丢了。
function flushPendingSave(event) {
  // 要覆盖两种情况：还有防抖计时器没触发；或者写入已经在进行中。
  // 只看 saveTimer 不够——计时器触发后会把 saveTimer 置空，
  // 此刻退出的话 writeFile 已经把文件截断成 0 字节却还没写完。
  if (!saveTimer && !pendingWrite) return;
  event.preventDefault();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeSettings();
  }
  const wait = pendingWrite || Promise.resolve();
  wait.finally(() => app.quit());
}

function toggleVisible() {
  if (!win) return;
  const next = !win.isVisible();
  if (next) win.showInactive();
  else win.hide();
  persist({ visible: next });
}

function openSettings() {
  // Task 9 实现设置窗口；在此之前是空操作，保证不崩溃
}

function showContextMenu() {
  if (!win) return;
  buildContextMenu({
    toggleVisible,
    openSettings,
    quit: () => app.quit(),
  }).popup({ window: win });
}

app.whenReady().then(async () => {
  registerAppProtocol(ROOT);
  settings = await loadSettings(app.getPath('userData'));
  // 没有保存过位置时不需要在这里补默认值：createPetWindow 的 restorePosition
  // 会用真实视口尺寸算出主显示器右下角，避免这里写死 300×560 与清单脱节。
  // 必须先注册 IPC 再创建窗口：渲染层页面一加载就会调用 getSettings()，
  // 顺序反了会撞上 "No handler registered"。
  registerIpc({
    getSettings: () => settings,
    saveSettings: (patch) => persist(patch),
    listModels: readModelRegistry,
    switchModel: (modelId) => {
      persist({ modelId });
      if (win) win.webContents.send('pet:modelSwitchRequest', modelId);
    },
    onOpenSettings: openSettings,
    onShowContextMenu: showContextMenu,
  });

  win = createPetWindow({ rootDir: ROOT, settings, displays: currentDisplays() });

  tray = createTray({
    iconPath: join(ROOT, 'assets', 'icons', 'tray.png'),
  });
  tray.setContextMenu(
    buildTrayMenu({
      toggleVisible,
      openSettings,
      quit: () => app.quit(),
    })
  );

});

// 'activate' 是 macOS 专用事件，Windows 上永不触发——本项目只做 Windows，不留跨平台分支。
//
// 注意：before-quit 的处理器是同步的。若直接调用异步写入，进程会在写入完成前退出，
// writeFile 已经把文件截断成 0 字节——设置丢失，且下次启动读到空文件会重置全部设置。
// 正确做法是 preventDefault，等写入真正完成后再退出。
app.on('before-quit', flushPendingSave);

app.on('window-all-closed', () => {
  if (!IS_E2E) app.quit();
});
```

- [ ] **Step 12: 扩展冒烟测试验证协议与窗口**

在 `test/e2e/smoke.spec.js` 追加：

```js
test('渲染层经 app:// 协议加载且窗口透明置顶', async () => {
  const ctx = await launchApp();
  try {
    const info = await ctx.win.evaluate(() => ({
      url: location.href,
      ready: window.__pet?.ready === true,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }));
    expect(info.url).toContain('app://bundle/src/renderer/index.html');
    expect(info.ready).toBe(true);
    expect(info.bodyBg).toContain('rgba(0, 0, 0, 0)');

    // 置顶只能从主进程侧断言：渲染层拿不到 BrowserWindow
    const alwaysOnTop = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isAlwaysOnTop()
    );
    expect(alwaysOnTop).toBe(true);
  } finally {
    await ctx.close();
  }
});

test('app:// 拒绝点开头的路径段及其编码变体', async () => {
  const ctx = await launchApp();
  try {
    const results = await ctx.win.evaluate(async () => {
      const paths = [
        '/.git/config',
        '/%2egit/config',
        '/%2Egit/config',
        '/%5c.git/config',
        '/%5c%5c.git/config',
        '/.superpowers/sdd/plan-path',
      ];
      const out = [];
      for (const p of paths) {
        const res = await fetch('app://bundle' + p);
        const body = await res.text();
        out.push({
          path: p,
          status: res.status,
          leaked: body.includes('repositoryformatversion') || body.includes('[core]'),
        });
      }
      return out;
    });

    for (const r of results) {
      expect(r.status, r.path).not.toBe(200);
      expect(r.leaked, r.path).toBe(false);
    }
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 13: 跑测试确认失败**

Run: `npx playwright test test/e2e/smoke.spec.js`
Expected: FAIL —— 首个测试的标题不再是 `Desk Pet`（占位页无 `<title>`），或 url 断言失败。

- [ ] **Step 14: 修正占位页 `<title>` 并跑测试确认通过**

给 `src/renderer/index.html` 的 `<title>Desk Pet</title>` 保留即可（Step 7 已写）。若 url 断言失败，检查 `protocol.handle` 注册时机是否在 `whenReady` 之后。

Run: `npx playwright test test/e2e/smoke.spec.js`
Expected: PASS（2 passed）。

- [ ] **Step 15: 提交**

```bash
git add src/main/protocol.js src/main/window.js src/main/tray.js src/main/menu.js src/main/ipc.js src/main/index.js src/preload/index.cjs src/renderer/index.html test/e2e/smoke.spec.js
git commit -m "feat: app:// 协议、宠物窗口、托盘、菜单与 IPC 装配"
```

---

### Task 4: 渲染层骨架 —— stage、清单、模型加载

**Files:**
- Create: `src/renderer/pet/stage.js`
- Create: `src/renderer/pet/manifest.js`
- Create: `src/renderer/pet/model.js`
- Create: `src/renderer/main.js`
- Modify: `src/renderer/index.html`
- Create: `test/e2e/render.spec.js`

**Interfaces:**
- Consumes: Task 3 的 `app://` 协议（渲染层资源从 `/assets/...` 读取）、`window.pet` preload API
- Produces:
  - `src/renderer/pet/stage.js` → `createStage(container): { app, resize(), fitModel(model, manifest, userScale) }`
  - `src/renderer/pet/manifest.js` → `loadManifest(modelId): Promise<manifest>`、`deriveManifest(model3, opts): manifest`、`resolveExpressionName(manifest, semantic): string|null`、`resolveMotionSpec(manifest, key): {group,index}|null`
  - `src/renderer/pet/model.js` → `loadPetModel(manifest): Promise<model>`、`disposePetModel(model): void`
  - 渲染层全局 `window.__pet` 扩展为 `{ ready: boolean, modelId: string, modelLoaded: boolean, expressions: string[], hitAreas: string[], naturalSize: {w,h} }`

- [ ] **Step 1: 写 `src/renderer/pet/manifest.js`**

```js
function pickExpression(model3) {
  const list = model3?.FileReferences?.Expressions;
  if (!Array.isArray(list)) return [];
  return list.map((e) => e.Name).filter((n) => typeof n === 'string' && n !== '');
}

function pickMotionGroups(model3) {
  const groups = model3?.FileReferences?.Motions;
  if (!groups || typeof groups !== 'object') return {};
  const out = {};
  for (const [group, entries] of Object.entries(groups)) {
    if (Array.isArray(entries) && entries.length > 0) out[group] = entries.length;
  }
  return out;
}

/**
 * 从 model3.json 探测模型能力，生成兜底清单。
 * 缺失任何能力都只影响对应功能，不抛错。
 */
export function deriveManifest(model3, opts = {}) {
  const expressions = pickExpression(model3);
  const motionGroups = pickMotionGroups(model3);

  // 降级时**不**按序号猜语义。官方样例 Haru 的 expressions[1] 是 F02，
  // 而 pet.json 里 F02 是 angry——按序号猜会让「摸头」触发生气的表情。
  // 猜不准就不猜：留空，由 resolveExpressionName 回退到第一个可用表情。
  const derived = {};

  const groupNames = Object.keys(motionGroups);
  const motions = {};
  if (groupNames.length > 0) {
    motions.idle = { group: groupNames[0], index: 0 };
    const tapGroup = groupNames.find((g) => /tap|body|hit/i.test(g)) || groupNames[0];
    motions.tapHead = { group: tapGroup, index: 0 };
    motions.tapBody = { group: tapGroup, index: Math.min(1, motionGroups[tapGroup] - 1) };
    motions.drag = { group: tapGroup, index: Math.min(2, motionGroups[tapGroup] - 1) };
  }

  return {
    id: opts.id || 'unknown',
    name: opts.name || opts.id || 'unknown',
    model3: opts.model3 || '',
    viewport: opts.viewport || { width: 300, height: 560 },
    fit: opts.fit || { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
    expressions: Object.keys(derived).length > 0 ? derived : {},
    motions,
    derived: true,
    availableExpressions: expressions,
    motionGroups,
  };
}

/** 清单与探测结果合并：清单优先，缺失项用探测值补齐。 */
export function mergeManifest(base, derived) {
  const expressions = { ...(derived?.expressions || {}), ...(base?.expressions || {}) };
  const motions = { ...(derived?.motions || {}), ...(base?.motions || {}) };
  // 降级时**只**补 normal，且取 availableExpressions[0]——与 resolveExpressionName
  // 的回退是同一个值，行为一致。
  // 刻意不按序号补其它语义：Haru 的 expressions[1] 是 F02，而清单里 F02 是 angry，
  // 按序号猜会让「摸头」触发生气的表情。猜不准比不猜更糟。
  if (!expressions.normal) {
    const first = derived?.availableExpressions?.[0];
    if (first) expressions.normal = first;
  }
  return {
    ...derived,
    ...(base || {}),
    expressions,
    motions,
    // derived 为 true 表示「没有用户清单，全部来自探测」。
    derived: !base,
    availableExpressions: derived?.availableExpressions || [],
    motionGroups: derived?.motionGroups || {},
  };
}

export function resolveExpressionName(manifest, semantic) {
  const map = manifest?.expressions || {};
  if (map[semantic]) return map[semantic];
  const available = manifest?.availableExpressions || [];
  if (Array.isArray(available) && available.length > 0) return available[0] || null;
  return null;
}

export function resolveMotionSpec(manifest, key) {
  const spec = manifest?.motions?.[key];
  if (!spec || typeof spec.group !== 'string') return null;
  const groups = manifest?.motionGroups || {};
  const count = groups[spec.group];
  if (typeof count === 'number') {
    const index = Math.min(Math.max(0, spec.index | 0), Math.max(0, count - 1));
    return { group: spec.group, index };
  }
  return { group: spec.group, index: Math.max(0, spec.index | 0) };
}

/** 读取形象注册表与清单；清单缺失时回退到探测。 */
export async function loadManifest(modelId) {
  // 注册表读不出来时不能直接崩掉整个 boot——降级成空列表并让调用方拿到
  // 一个明确的错误，而不是一个未捕获的 fetch 异常。
  let registry = { models: [] };
  try {
    const registryRes = await fetch('/assets/live2d/index.json');
    if (!registryRes.ok) throw new Error(`HTTP ${registryRes.status}`);
    registry = await registryRes.json();
  } catch (err) {
    console.warn('[desk-pet] 形象注册表读取失败：', err?.message);
  }
  const models = Array.isArray(registry.models) ? registry.models : [];
  const entry = models.find((m) => m.id === modelId) || models[0];
  if (!entry) throw new Error(`未找到形象: ${modelId}`);

  const manifestUrl = `/assets/live2d/models/${entry.manifest}`;
  let base = null;
  try {
    const res = await fetch(manifestUrl);
    if (res.ok) base = await res.json();
  } catch {
    base = null;
  }

  const model3Name = base?.model3 || entry.model3 || `${entry.id}.model3.json`;
  const model3Url = `/assets/live2d/models/${entry.id}/${model3Name}`;
  let model3 = null;
  try {
    const res = await fetch(model3Url);
    if (res.ok) model3 = await res.json();
  } catch {
    model3 = null;
  }

  const derived = deriveManifest(model3, {
    id: entry.id,
    name: entry.name,
    model3: model3Name,
    viewport: base?.viewport,
    fit: base?.fit,
  });
  const merged = mergeManifest(base, derived);
  // 即使没有 pet.json，也要保证 model3 有值，否则模型无法加载
  merged.model3 = model3Name;
  // id 以注册表为准：pet.json 里的 id 若与注册表不一致，
  // 用它拼 URL 会 404，而且没有回退到已知可用的 entry.id。
  merged.id = entry.id;
  return merged;
}
```

- [ ] **Step 2: 实现 `src/renderer/pet/stage.js`**

```js
export function createStage(container) {
  const PIXI = window.PIXI;
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  container.appendChild(app.view);

  // 不再自己挂 resize 监听：pixi 的 resizeTo: window 已经处理画布尺寸，
  // 而窗口是固定尺寸不可缩放，重复处理只是白费力气。
  function resize() {
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }

  /**
   * 把模型缩放适配到视口：先按自然尺寸等比 contain，再乘清单与用户缩放。
   * 自然尺寸只在首次调用时测量并缓存——之后 getBounds() 返回的是**已缩放**的尺寸，
   * 重复用它计算适配比例会让模型越缩越小（Task 9 调整缩放时会再次调用本函数）。
   */
  function fitModel(model, manifest, userScale = 1) {
    const viewW = app.screen.width;
    const viewH = app.screen.height;
    if (!model.__naturalSize) {
      const natural = model.getBounds();
      model.__naturalSize = { w: natural.width || 1, h: natural.height || 1 };
    }
    const nw = model.__naturalSize.w;
    const nh = model.__naturalSize.h;
    const fitScale = Math.min((viewH * 0.96) / nh, (viewW * 0.98) / nw);
    const manifestScale = manifest?.fit?.scale ?? 1;
    model.scale.set(fitScale * manifestScale * userScale);
    const anchor = manifest?.fit?.anchor || [0.5, 1.0];
    model.anchor.set(anchor[0], anchor[1]);
    const offset = manifest?.fit?.offset || [0, 0];
    model.position.set(
      viewW / 2 + offset[0] * viewW,
      viewH * (anchor[1] === 1 ? 1 : 0.5) + offset[1] * viewH,
    );
    return { naturalWidth: nw, naturalHeight: nh, scale: model.scale.x };
  }

  return { app, resize, fitModel };
}
```

- [ ] **Step 3: 实现 `src/renderer/pet/model.js`**

```js
import { disposeTextures } from './texture.js';

export async function loadPetModel(manifest) {
  const PIXI = window.PIXI;
  const model3Url = `/assets/live2d/models/${manifest.id}/${manifest.model3}`;
  const model = await PIXI.live2d.Live2DModel.from(model3Url);
  return model;
}

/** 销毁模型并显式释放纹理，避免多次切换后显存持续增长。 */
export function disposePetModel(model) {
  if (!model) return 0;
  let released = 0;
  try {
    released = disposeTextures(model);
    if (released === 0) {
      console.warn('[desk-pet] 未释放任何模型纹理，显存可能持续增长');
    }
  } catch (err) {
    // 释放失败不应阻断切换，但必须留痕——否则显存泄漏完全不可见。
    console.warn('[desk-pet] 模型纹理释放失败：', err?.message);
  }
  // 注意：释放数量要等模型销毁完再返回。提前 return 会跳过下面的
  // removeChild/destroy，模型就永远留在 stage 上——那比重启更糟。
  try {
    if (model.parent) model.parent.removeChild(model);
    model.destroy({ children: true });
  } catch {
    /* ignore */
  }
  return released;
}
```

- [ ] **Step 4: 实现 `src/renderer/pet/texture.js`**

```js
/**
 * 释放 Live2D 模型占用的纹理。
 * pixi 的纹理缓存以**加载时用的相对路径**为键，模型销毁不会自动清理，必须显式移除。
 */
export function disposeTextures(model) {
  const PIXI = window.PIXI;

  // pixi v6 的全局纹理缓存挂在 PIXI.utils.TextureCache 上。
  // 浏览器构建里 PIXI.TextureCache 是 undefined——写错命名空间会让整个函数
  // 静默地什么都不释放。
  const cache = PIXI.TextureCache || PIXI.utils?.TextureCache;
  if (!cache) return 0;

  // 模型的 PIXI 纹理挂在 model.textures 上（Live2DModel 用 Texture.fromURL 加载，
  // 纹理以**加载时用的相对路径**为键缓存在 PIXI.utils.TextureCache 里）。
  //
  // 不要去碰 internalModel._textures——那是 CubismRenderer_WebGL 持有的原始
  // WebGLTexture 句柄数组，不可迭代；internalModel.textures 只是 model3.json 里的
  // 文件名数组。两者都拿不到我们要的键。
  const textures = model?.textures || [];
  const keys = [];
  for (const t of textures) {
    // 缓存键是**加载时用的那个 URL**（相对 app:// 根的路径，如
    // /assets/live2d/models/haru/Haru.2048/texture_00.png），
    // 不是 baseTexture.resource.url 里的绝对地址——用绝对地址查不到缓存。
    const key = t?.baseTexture?.cacheId || t?.baseTexture?.resource?.url;
    if (key) keys.push(key);
  }

  let released = 0;
  for (const key of keys) {
    const cached = cache[key];
    if (!cached) continue;
    try {
      PIXI.Texture.removeFromCache(key);
      cached.destroy(true);
      released++;
    } catch (err) {
      // 单个键失败不能中断整批：其余纹理仍要释放，
      // 而且「释放了几个」必须如实反映，否则 0 会被误读成泄漏。
      console.warn('[desk-pet] 纹理释放失败：', key, err?.message);
    }
  }

  // 刻意**不做**「把缓存里所有 URL 形状的键都清掉」这种兜底：
  // PIXI 的纹理缓存是全局命名空间，那样会把别的模型或未来任何资源的纹理
  // 一起销毁，表现为切换形象后渲染空白。
  return released;
}

/**
 * 按路径前缀清理缓存中的纹理。用于「模型加载到一半失败」——
 * 那时拿不到模型对象，但已经进缓存的纹理必须清掉，否则反复失败会堆积显存。
 * 前缀带结尾斜杠，不会误伤名字以此前缀开头的其它目录。
 */
export function disposeTexturesUnderPath(pathPrefix) {
  const PIXI = window.PIXI;
  const cache = PIXI.TextureCache || PIXI.utils?.TextureCache;
  if (!cache) return 0;
  let released = 0;
  for (const key of Object.keys(cache)) {
    if (!key.startsWith(pathPrefix)) continue;
    const cached = cache[key];
    try {
      PIXI.Texture.removeFromCache(key);
      cached.destroy(true);
      released++;
    } catch (err) {
      console.warn('[desk-pet] 纹理释放失败：', key, err?.message);
    }
  }
  return released;
}
```

- [ ] **Step 5: 实现 `src/renderer/main.js`**

```js
import { createStage } from './pet/stage.js';
import { loadManifest } from './pet/manifest.js';
import { loadPetModel } from './pet/model.js';

window.__pet = {
  ready: false,
  modelLoaded: false,
  modelId: null,
  expressions: [],
  hitAreas: [],
  naturalSize: null,
};

async function boot() {
  const container = document.getElementById('stage');
  const stage = createStage(container);
  window.__pet.stage = stage;

  const settings = await window.pet.getSettings();
  const modelId = settings?.modelId || 'haru';
  const manifest = await loadManifest(modelId);
  window.__pet.manifest = manifest;

  const model = await loadPetModel(manifest);
  stage.app.stage.addChild(model);
  const fit = stage.fitModel(model, manifest, settings?.scale ?? 1);

  window.__pet.modelId = manifest.id;
  window.__pet.modelLoaded = true;
  // window.__pet.expressions = 模型**原始**表情名列表（如 Haru 的 F01..F08）
  // 语义映射（happy/angry/...）在 window.__pet.manifest.expressions 里。
  // 两者不要混淆：交互层要语义，测试与诊断要原始名。
  window.__pet.expressions = manifest.availableExpressions || [];
  window.__pet.hitAreas = Object.keys(model.internalModel?.hitAreas || {});
  window.__pet.naturalSize = { w: fit.naturalWidth, h: fit.naturalHeight };
  window.__pet.model = model;
  window.__pet.ready = true;
}

boot().catch((err) => {
  window.__pet.error = String(err && err.stack ? err.stack : err);
  window.__pet.ready = true;
});
```

- [ ] **Step 6: 更新 `src/renderer/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Desk Pet</title>
  <style>
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    #stage { position: absolute; inset: 0; }
  </style>
</head>
<body>
  <div id="stage"></div>
  <script src="/node_modules/pixi.js/dist/browser/pixi.js"></script>
  <script src="/node_modules/live2dcubismcore/live2dcubismcore.min.js"></script>
  <script src="/node_modules/pixi-live2d-display/dist/cubism4.min.js"></script>
  <script type="module" src="/src/renderer/main.js"></script>
</body>
</html>
```

- [ ] **Step 7: 写 `test/e2e/render.spec.js`**

> 实现时补强（Task 4 修复轮次 2 的结论，已在提交 `b914596` 中落地）：
> 像素采样断言不只要证明「模型在动」，还要证明「取到的是目标区域」——
> 需同时断言 、（取错区域会掉到 0.06）、
>  与 （脸部比上半部亮）。
> 复审已独立复现：步长翻倍 → meanLum 88.6 < 阈值 137.8；区域翻倍 → opaqueRatio 0.062 < 0.5。

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('模型成功加载并具备能力', async () => {
  const ctx = await launchApp();
  try {
    const info = await ctx.win.evaluate(() => ({
      ready: window.__pet?.ready,
      error: window.__pet?.error || null,
      modelLoaded: window.__pet?.modelLoaded,
      modelId: window.__pet?.modelId,
      expressions: window.__pet?.expressions,
      hitAreas: window.__pet?.hitAreas,
      naturalSize: window.__pet?.naturalSize,
      hasPixi: typeof window.PIXI !== 'undefined',
      hasCore: typeof window.Live2DCubismCore !== 'undefined',
      hasLive2d: !!(window.PIXI && window.PIXI.live2d),
    }));
    expect(info.error).toBeNull();
    expect(info.ready).toBe(true);
    expect(info.modelLoaded).toBe(true);
    // 不写死 'haru'：注册表里第一个形象将来可能换人。
    // 从注册表推导期望值，这条断言才不会因为与渲染层无关的原因失败。
    const registry = await ctx.win.evaluate(() =>
      fetch('/assets/live2d/index.json').then((r) => r.json())
    );
    expect(info.modelId).toBe(registry.models[0].id);
    expect(info.hasPixi).toBe(true);
    expect(info.hasCore).toBe(true);
    expect(info.hasLive2d).toBe(true);
    expect(info.expressions.length).toBeGreaterThan(0);
    // 命中区名按名字归一化（head/body），具体叫法由模型作者决定，
    // 这里只断言存在头/身两类命中区，不断言字面拼写。
    expect(info.hitAreas.some((h) => /head/i.test(h))).toBe(true);
    expect(info.hitAreas.some((h) => /body/i.test(h))).toBe(true);
    expect(info.naturalSize.w).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test('模型在无输入时自动产生画面变化（呼吸/眨眼/物理生效）', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.bringToFront();
    const info = await ctx.win.evaluate(async () => {
      const app = window.__pet.stage.app;
      const internal = window.__pet.model.internalModel;
      // 注意：extract.pixels() 每次都会重新渲染；extract.canvas() 返回缓存画面，不可用于逐帧比较
      const extract = app.renderer.plugins.extract;
      const bounds = app.stage.getBounds();
      // extract.pixels() 返回的行宽是 round(frame.width * resolution)。
      // 渲染器的 resolution 取的是 devicePixelRatio，在 150% 缩放的 Windows 11 上
      // 真实步长是假设值的 1.5 倍——不乘 resolution 会取到完全错位的行，
      // 测试「通过」但证明不了它声称证明的事。
      // 行宽必须从实际像素数组里取，**不要**自己乘 renderer.resolution：
      // extract 对 DisplayObject 走 renderer.generateTexture()，
      // 它按 getLocalBounds 创建 RenderTexture 且不传 resolution，
      // 因此行宽恒等于 bounds 宽度（settings.RESOLUTION 默认为 1），
      // 与 renderer.resolution 无关。乘上 resolution 反而会在
      // 150% 缩放的 Windows 11 上取到完全错位的行。
      // _rawPixels 直接返回 {pixels, width, height}，是最不容易算错的取法。
      const raw = extract._rawPixels(app.stage);
      const W = raw.width;
      const H = raw.height;
      // 取眼部区域（上部中央）
      const ex = Math.round(W * 0.38);
      const ey = Math.round(H * 0.115);
      const ew = Math.round(W * 0.24);
      const eh = Math.round(H * 0.055);
      const regionHash = () => {
        // 每帧重新提取：_rawPixels 每次都会重新渲染 target。
        const r = extract._rawPixels(app.stage);
        let v = 0;
        for (let y = ey; y < ey + eh; y++) {
          for (let x = ex; x < ex + ew; x++) {
            const i = (y * r.width + x) * 4;
            v = (v * 31 + r.pixels[i] + r.pixels[i + 1] * 3) >>> 0;
          }
        }
        return v;
      };
      const hashes = new Set();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          hashes.add(regionHash());
          if (performance.now() - t0 > 6000) {
            clearInterval(iv);
            resolve();
          }
        }, 30);
      });
      return {
        distinctHashes: hashes.size,
        hasBreath: !!internal.breath,
        breathParams: internal.breath ? internal.breath.getParameters().map((p) => p.parameterId) : [],
        hasEyeBlink: !!internal.eyeBlink,
        eyeBlinkParamIds: internal.eyeBlink ? internal.eyeBlink.getParameterIds() : [],
      };
    });

    expect(info.hasBreath).toBe(true);
    expect(info.breathParams).toContain('ParamBreath');
    expect(info.hasEyeBlink).toBe(true);
    expect(info.eyeBlinkParamIds).toContain('ParamEyeLOpen');
    expect(info.distinctHashes).toBeGreaterThan(1);
  } finally {
    await ctx.close();
  }
});
```

> **已踩坑记录（务必照做）**
>
> 1. **不要用参数值判断呼吸/眨眼。** `model.internalModel.coreModel.getParameterValueByIndex(...)` 读的是 core 模型的基准参数，
>    不反映框架层的动画结果——实测 4 秒内 `ParamEyeLOpen` 恒为 1、`ParamBreath` 恒为 0，而画面明显在动。
>    判断「模型是否自己在动」只能用**像素比较**。
> 2. **`extract.pixels(target)` 每次都会重新渲染；`extract.canvas(target)` 返回缓存画面。** 逐帧比较必须用前者，
>    否则会得到「画面静止」的假结论。
> 3. **Playwright 中页面若处于后台标签会被节流到约 1 FPS**，测试前必须 `await win.bringToFront()`，
>    否则动画类断言会随机失败。
> 4. 呼吸/眨眼管理器的配置可直接断言：`internalModel.breath.getParameters()` 含 `ParamBreath`；
>    `internalModel.eyeBlink.getParameterIds()` 含 `ParamEyeLOpen` / `ParamEyeROpen`。

- [ ] **Step 8: 跑测试确认失败**

Run: `npx playwright test test/e2e/render.spec.js`
Expected: FAIL —— 渲染层尚未引入三个全局脚本，`window.PIXI` 为 undefined。

- [ ] **Step 9: 跑测试确认通过**

Run: `npx playwright test test/e2e/render.spec.js`
Expected: PASS（1 passed）。若失败且 `error` 字段有值，读取该字段定位；常见原因是 `app://` 下 XHR 加载 `model3.json` 被拒（此时 `modelLoaded` 为 false 且 error 提到网络错误）。

- [ ] **Step 10: 提交**

```bash
git add src/renderer/
git commit -m "feat: 渲染层骨架，pixi + Live2D 模型加载与视口适配"
```

---

### Task 5: 模型抽象层 —— 语义映射、能力探测与降级

**Files:**
- Create: `test/unit/manifest.test.js`
- Modify: `src/renderer/pet/manifest.js`
- Create: `test/e2e/manifest.spec.js`

**Interfaces:**
- Consumes: Task 4 的 `deriveManifest` / `mergeManifest` / `resolveExpressionName` / `resolveMotionSpec`
- Produces: 上述四个函数成为稳定接口，语义键固定为 `normal` / `happy` / `smile` / `shy` / `angry` / `surprised` / `sad`；动作键固定为 `idle` / `tapHead` / `tapBody` / `drag`

- [ ] **Step 1: 写 `test/unit/manifest.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveManifest,
  mergeManifest,
  resolveExpressionName,
  resolveMotionSpec,
} from '../../src/renderer/pet/manifest.js';

const MODEL3 = {
  FileReferences: {
    Expressions: [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }],
    Motions: {
      Idle: [{ File: 'i1' }, { File: 'i2' }],
      TapBody: [{ File: 't1' }, { File: 't2' }, { File: 't3' }],
    },
  },
};

test('探测出表情与动作组', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.deepEqual(m.availableExpressions, ['A', 'B', 'C']);
  assert.equal(m.motionGroups.Idle, 2);
  assert.equal(m.motionGroups.TapBody, 3);
});

test('清单优先于探测值', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const base = { id: 'x', name: 'X', expressions: { happy: 'B' }, motions: { tapHead: { group: 'TapBody', index: 2 } } };
  const merged = mergeManifest(base, derived);
  assert.equal(merged.expressions.happy, 'B');
  assert.equal(merged.motions.tapHead.group, 'TapBody');
  assert.equal(merged.motions.tapHead.index, 2);
  // 清单未覆盖的语义保留探测值
  assert.ok(merged.expressions.normal);
});

test('缺失语义时回退到第一个可用表情', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.equal(resolveExpressionName(m, 'happy'), 'A');
});

test('模型完全没有表情时返回 null', () => {
  const m = deriveManifest({ FileReferences: {} }, { id: 'x' });
  assert.equal(resolveExpressionName(m, 'happy'), null);
});

test('动作索引被夹紧到该组的有效范围', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  const spec = resolveMotionSpec(m, 'tapHead');
  assert.ok(spec);
  assert.ok(spec.index < m.motionGroups[spec.group]);
});

test('动作组名不存在时返回 null', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.equal(resolveMotionSpec(m, '不存在的键'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/manifest.test.js`
Expected: 至少「动作组名不存在时返回 null」FAIL（当前实现返回 `{group:'不存在的键', index:0}` 而非 null）。

- [ ] **Step 3: 修正 `src/renderer/pet/manifest.js` 的 `resolveMotionSpec`**

```js
export function resolveMotionSpec(manifest, key) {
  const spec = manifest?.motions?.[key];
  if (!spec || typeof spec.group !== 'string' || spec.group === '') return null;
  const groups = manifest?.motionGroups || {};
  const count = groups[spec.group];
  // 动作组不存在（模型里没有这一组）时返回 null：
  // 返回一个未经验证的 spec 只会把失败推迟到调用点，模型上「没有这个动作组」
  // 应当诚实地表现为 null，让调用方降级而不是在深处抛错。
  if (typeof count !== 'number' || count <= 0) return null;
  const index = Math.min(Math.max(0, spec.index | 0), count - 1);
  return { group: spec.group, index };
}
```

同时让 `deriveManifest` 在没有动作组时 `motions` 为空对象：

```js
  const motions = {};
  if (groupNames.length > 0) {
    motions.idle = { group: groupNames[0], index: 0 };
    const tapGroup = groupNames.find((g) => /tap|body|hit/i.test(g)) || groupNames[0];
    motions.tapHead = { group: tapGroup, index: 0 };
    motions.tapBody = { group: tapGroup, index: Math.min(1, motionGroups[tapGroup] - 1) };
    motions.drag = { group: tapGroup, index: Math.min(2, motionGroups[tapGroup] - 1) };
  }
```

（该段已是现实现状，无需改动；确认即可。）

- [ ] **Step 4: 跑单测确认通过**

Run: `node --test test/unit/manifest.test.js`
Expected: PASS（6 passed）。

- [ ] **Step 5: 写 `test/e2e/manifest.spec.js` 验证降级**

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('清单缺项时自动探测补齐，不影响渲染', async () => {
  const ctx = await launchApp();
  try {
    const info = await ctx.win.evaluate(async () => {
      const { deriveManifest, mergeManifest, resolveExpressionName, resolveMotionSpec } =
        await import('/src/renderer/pet/manifest.js');
      const model3 = await (await fetch('/assets/live2d/models/haru/Haru.model3.json')).json();
      const derived = deriveManifest(model3, { id: 'haru' });
      const merged = mergeManifest(null, derived);
      return {
        hasExpressions: Object.keys(merged.expressions).length > 0,
        hasMotions: Object.keys(merged.motions).length > 0,
        expr: resolveExpressionName(merged, 'happy'),
        motion: resolveMotionSpec(merged, 'tapHead'),
        modelStillLoaded: window.__pet?.modelLoaded === true,
      };
    });
    expect(info.hasExpressions).toBe(true);
    expect(info.hasMotions).toBe(true);
    expect(typeof info.expr).toBe('string');
    expect(info.motion).not.toBeNull();
    expect(info.modelStillLoaded).toBe(true);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx playwright test test/e2e/manifest.spec.js`
Expected: PASS（1 passed）。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/pet/manifest.js test/unit/manifest.test.js test/e2e/manifest.spec.js
git commit -m "feat: 模型语义映射与能力探测降级"
```

---

### Task 6: 形象切换与纹理释放

**Files:**
- Modify: `src/renderer/main.js`
- Modify: `src/renderer/pet/model.js`
- Create: `test/e2e/switch.spec.js`

**Interfaces:**
- Consumes: Task 4 的 `loadManifest` / `loadPetModel` / `disposePetModel`，Task 5 的 `mergeManifest`
- Produces: `window.__pet.switchModel(modelId): Promise<boolean>`；切换后 `window.__pet.modelId` 更新为新形象 id；主进程通过 `pet:modelSwitchRequest` 事件驱动切换

- [ ] **Step 1: 在 `src/renderer/main.js` 中加入切换能力**

把 `boot()` 改为同时注册切换处理器：

```js
import { createStage } from './pet/stage.js';
import { loadManifest } from './pet/manifest.js';
import { loadPetModel, disposePetModel } from './pet/model.js';
import { disposeTexturesUnderPath } from './pet/texture.js';

window.__pet = {
  ready: false,
  modelLoaded: false,
  modelId: null,
  expressions: [],
  hitAreas: [],
  naturalSize: null,
};

let stage = null;
let currentModel = null;
let currentManifest = null;
let userScale = 1;

// 切换请求序号：并发切换时只有最后一次请求允许提交到舞台，
// 否则「谁先加载完谁上屏」，屏幕上可能不是用户最后选的那个。
let switchSeq = 0;

// 切换串行化：同一时刻只允许一次加载在进行。
//
// pixi 的纹理缓存以 URL 为键，两次**并发**加载同一形象会拿到同一批
// Texture 实例（Texture.from 命中缓存就直接返回那个对象）。
// 先完成的那次一旦销毁自己的模型，就会把另一次正在用的纹理一起销毁——
// 胜出的模型变成「没有绑定纹理的空壳」，而 switchModel 仍然报告成功。
// 串行化之后任何时刻只有一个模型在被加载，不存在共享纹理。
let switchChain = Promise.resolve();

/**
 * 排队一次形象切换。
 *
 * 请求序号在**调用时**就取好：并发请求里只有最后取到序号的那个允许提交，
 * 先到的那些直接作废，连模型都不加载。
 */
function mountModel(modelId) {
  const token = ++switchSeq;
  const run = switchChain.then(
    () => doMountModel(modelId, token),
    () => doMountModel(modelId, token),
  );
  // 链条本身不能被拒绝打断：某一次切换失败不能卡死后面的切换。
  switchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 加载并挂载一个形象（串行化后的实际执行体）。
 *
 * 顺序很重要：**先加载新模型，再销毁旧模型**。反过来的话中间会出现
 * 一帧空舞台，而且一旦新模型加载失败，旧模型也已经被销毁了——
 * 用户的桌宠就彻底没了。
 */
async function doMountModel(modelId, token) {
  // 还没开始就已经被更新的请求顶掉了：什么都不用做。
  if (token !== switchSeq) return null;

  const manifest = await loadManifest(modelId);

  // 切换到**当前已挂载的同一个形象**时直接返回。
  // pixi 对已缓存的 URL 会返回同一个 Texture 实例，新旧模型因此共享同一批
  // 纹理对象；紧接着调用 disposeTextures 会把新模型自己的纹理销毁掉——
  // 桌宠变成「没有绑定纹理的空壳」，而 switchModel 仍然报告成功。
  if (currentModel && manifest.id === currentManifest?.id) {
    return currentModel;
  }

  let model;
  try {
    model = await loadPetModel(manifest);
  } catch (err) {
    // 加载失败时旧模型仍挂在舞台上，用户不会看到桌宠凭空消失。
    // 但失败的加载可能已经把纹理塞进了全局缓存，必须清掉，
    // 否则反复失败的切换会不断堆积显存。
    disposeTexturesUnderPath(`/assets/live2d/models/${manifest.id}/`);
    throw err;
  }

  // 加载期间可能又发起了新的切换——过期请求直接放弃，不要动舞台。
  if (token !== switchSeq) {
    disposePetModel(model);
    return null;
  }

  let released = 0;
  if (currentModel) {
    // 先把旧模型摘出舞台：它马上要被销毁，留在渲染列表里只会
    // 让渲染循环去访问已经释放的纹理。
    if (currentModel.parent) currentModel.parent.removeChild(currentModel);
    released = disposePetModel(currentModel);
    currentModel = null;
  }
  window.__pet.lastReleasedTextures = released;

  // 缩放每次挂载时重读：userScale 是启动时抓的，
  // 用户在设置里改过缩放后再切换形象，新模型必须用新缩放。
  //
  // 这一句必须放在**提交之前**：提交段（销毁旧模型 → 挂载新模型 → 更新状态）
  // 要保持整体同步，中途 await 会让并发请求插进来，导致舞台上同时挂着两个模型。
  const settings = await window.pet.getSettings();
  if (typeof settings?.scale === 'number') userScale = settings.scale;

  stage.app.stage.addChild(model);
  const fit = stage.fitModel(model, manifest, userScale);
  currentModel = model;
  currentManifest = manifest;

  window.__pet.modelId = manifest.id;
  window.__pet.modelLoaded = true;
  window.__pet.expressions = manifest.availableExpressions || [];
  window.__pet.hitAreas = Object.keys(model.internalModel?.hitAreas || {});
  window.__pet.naturalSize = { w: fit.naturalWidth, h: fit.naturalHeight };
  window.__pet.model = model;
  window.__pet.manifest = manifest;
  return model;
}

async function boot() {
  const container = document.getElementById('stage');
  stage = createStage(container);
  window.__pet.stage = stage;

  const settings = await window.pet.getSettings();
  userScale = settings?.scale ?? 1;
  // 不在这里写死任何形象 id：loadManifest 对未知/缺失的 id 会回退到注册表首个形象。
  await mountModel(settings?.modelId);

  // 主进程请求切换形象
  window.pet.onModelSwitchRequest(async (modelId) => {
    try {
      await mountModel(modelId);
      window.__pet.switchError = null;
    } catch (err) {
      window.__pet.switchError = String(err && err.message ? err.message : err);
    }
  });

  window.__pet.switchModel = async (modelId) => {
    try {
      await mountModel(modelId);
      window.__pet.switchError = null;
      return true;
    } catch (err) {
      window.__pet.switchError = String(err && err.message ? err.message : err);
      return false;
    }
  };

  window.__pet.ready = true;
}

boot().catch((err) => {
  window.__pet.error = String(err && err.stack ? err.stack : err);
  window.__pet.ready = true;
});
```

- [ ] **Step 2: 跑冒烟测试确认仍然通过**

Run: `npx playwright test test/e2e/render.spec.js`
Expected: PASS（1 passed）—— 重构未破坏既有行为。

- [ ] **Step 3: 写 `test/e2e/switch.spec.js`**

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('切换形象后模型、表情与命中区均更换', async () => {
  const ctx = await launchApp();
  try {
    const before = await ctx.win.evaluate(() => ({
      modelId: window.__pet.modelId,
      expressions: window.__pet.expressions.slice(),
      hitAreas: window.__pet.hitAreas.slice(),
    }));
    expect(before.modelId).toBe('haru');

    const after = await ctx.win.evaluate(async () => {
      const ok = await window.__pet.switchModel('natori');
      return {
        ok,
        switchError: window.__pet.switchError || null,
        modelId: window.__pet.modelId,
        expressions: window.__pet.expressions.slice(),
        hitAreas: window.__pet.hitAreas.slice(),
      };
    });

    expect(after.switchError).toBeNull();
    expect(after.ok).toBe(true);
    expect(after.modelId).toBe('natori');
    expect(after.expressions).not.toEqual(before.expressions);
    expect(after.expressions).toContain('Normal');
    expect(after.hitAreas).toContain('Head');
    expect(after.hitAreas).toContain('Body');
  } finally {
    await ctx.close();
  }
});

test('连续切换多次不报错', async () => {
  const ctx = await launchApp();
  try {
    const result = await ctx.win.evaluate(async () => {
      const ids = ['natori', 'haru', 'natori', 'haru', 'natori'];
      for (const id of ids) {
        const ok = await window.__pet.switchModel(id);
        if (!ok) return { failedAt: id, error: window.__pet.switchError };
      }
      return { failedAt: null, error: window.__pet.switchError || null, finalId: window.__pet.modelId };
    });
    expect(result.failedAt).toBeNull();
    expect(result.error).toBeNull();
    expect(result.finalId).toBe('natori');
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx playwright test test/e2e/switch.spec.js`
Expected: FAIL —— `window.__pet.switchModel` 尚未定义（`switchModel` 是 Task 6 Step 1 新增的，需确认该步骤已应用）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx playwright test test/e2e/switch.spec.js`
Expected: PASS（2 passed）。

若第二个用例报显存/纹理相关错误，检查 `disposeTextures` 是否成功从 `PIXI.TextureCache` 移除纹理。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/main.js src/renderer/pet/model.js src/renderer/pet/texture.js test/e2e/switch.spec.js
git commit -m "feat: 运行时切换形象并显式释放纹理"
```

---

### Task 7: 交互层 —— 命中区、视线跟随、点击反应

**Files:**
- Create: `src/renderer/pet/hitZone.js`
- Create: `src/renderer/pet/behavior.js`
- Create: `src/renderer/ui/drag.js`
- Create: `src/renderer/pet/interaction.js`
- Create: `test/unit/hitZone.test.js`
- Create: `test/unit/behavior.test.js`
- Create: `test/unit/drag.test.js`
- Create: `test/e2e/interaction.spec.js`

**Interfaces:**
- Consumes: Task 5 的 `resolveExpressionName` / `resolveMotionSpec`
- Produces:
  - `src/renderer/pet/hitZone.js` → `normalizeZone(name): 'head'|'body'|'other'`、`geometricZone(bounds, x, y): 'head'|'body'|'other'`、`hitZoneAt(model, x, y): 'head'|'body'|'other'`
  - `src/renderer/pet/behavior.js` → `ZONE_BEHAVIOR`、`reactionFor(manifest, zone): { expressionName: string|null, motionSpec: {group,index}|null }`
  - `src/renderer/ui/drag.js` → `createDragController(opts): { pointerDown, pointerMove, pointerUp, dragging }`、`DRAG_THRESHOLD`
  - 渲染层全局 `window.__pet.lastZone`、`window.__pet.lastExpression`、`window.__pet.lastMotion`、`window.__pet.focusPoint`

- [ ] **Step 1: 写 `test/unit/hitZone.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZone, geometricZone, hitZoneAt } from '../../src/renderer/pet/hitZone.js';

const BOUNDS = { x: 0, y: 0, width: 300, height: 560 };

/** 造一个命中区行为可控的假模型。 */
function stubModel({ hit = [], areas = { Head: {}, Body: {} }, bounds = BOUNDS } = {}) {
  return {
    internalModel: { hitAreas: areas },
    hitTest: () => hit,
    getBounds: () => bounds,
  };
}

test('命中区名归一化', () => {
  assert.equal(normalizeZone('Head'), 'head');
  assert.equal(normalizeZone('head'), 'head');
  assert.equal(normalizeZone('Body'), 'body');
  assert.equal(normalizeZone('BODY'), 'body');
  assert.equal(normalizeZone('ribon'), 'other');
  assert.equal(normalizeZone(''), 'other');
  assert.equal(normalizeZone(undefined), 'other');
});

test('几何兜底：上 35% 判为头部', () => {
  assert.equal(geometricZone(BOUNDS, 150, 50), 'head');
  assert.equal(geometricZone(BOUNDS, 150, 190), 'head');
  assert.equal(geometricZone(BOUNDS, 150, 250), 'body');
  assert.equal(geometricZone(BOUNDS, 150, 500), 'body');
});

test('几何兜底：包围盒之外的点返回 other', () => {
  // 桌宠周围的空白处点击不应该触发反应——用户点了桌子，桌宠不该摸头。
  assert.equal(geometricZone(BOUNDS, 150, -20), 'other');
  assert.equal(geometricZone(BOUNDS, -10, 150), 'other');
  assert.equal(geometricZone(BOUNDS, 400, 150), 'other');
  assert.equal(geometricZone(BOUNDS, 150, 700), 'other');
});

test('包围盒无效时返回 other', () => {
  assert.equal(geometricZone(null, 10, 10), 'other');
  assert.equal(geometricZone({ x: 0, y: 0, width: 0, height: 0 }, 10, 10), 'other');
});

test('hitZoneAt 优先使用模型原生命中区', () => {
  // 关键用例：y=150 在几何判定下是 body（rel=0.27 <= 0.35 → head，实际 head），
  // 这里选一个几何判定会答 body、原生会答 head 的点，证明原生优先。
  const model = stubModel({ hit: ['Head'] });
  assert.equal(hitZoneAt(model, 150, 400), 'head');
  const model2 = stubModel({ hit: ['Body'] });
  assert.equal(hitZoneAt(model2, 150, 60), 'body');
});

test('hitZoneAt 在原生命中区未命中时退回几何判定', () => {
  const model = stubModel({ hit: [] });
  assert.equal(hitZoneAt(model, 150, 50), 'head');
  assert.equal(hitZoneAt(model, 150, 400), 'body');
});

test('hitZoneAt 在模型之外返回 other', () => {
  const model = stubModel({ hit: [] });
  assert.equal(hitZoneAt(model, 150, -20), 'other');
  assert.equal(hitZoneAt(model, -10, 150), 'other');
  assert.equal(hitZoneAt(model, 150, 700), 'other');
});

test('hitZoneAt 在模型没有命中区时退回几何判定', () => {
  const model = stubModel({ hit: [], areas: {} });
  assert.equal(hitZoneAt(model, 150, 50), 'head');
  assert.equal(hitZoneAt(model, 150, 400), 'body');
});
```

- [ ] **Step 2: 写 `test/unit/behavior.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reactionFor, idleReaction } from '../../src/renderer/pet/behavior.js';
import { deriveManifest, mergeManifest } from '../../src/renderer/pet/manifest.js';

const manifest = mergeManifest(
  {
    id: 'x',
    name: 'X',
    expressions: { normal: 'N', happy: 'H', smile: 'S' },
    motions: { tapHead: { group: 'TapBody', index: 0 }, tapBody: { group: 'TapBody', index: 1 } },
  },
  deriveManifest(
    {
      FileReferences: {
        Expressions: [{ Name: 'N' }, { Name: 'H' }, { Name: 'S' }],
        Motions: { Idle: [{ File: 'i' }], TapBody: [{ File: 't1' }, { File: 't2' }] },
      },
    },
    { id: 'x' }
  )
);

test('摸头触发 happy 表情与 tapHead 动作', () => {
  const r = reactionFor(manifest, 'head');
  assert.equal(r.expressionName, 'H');
  assert.equal(r.motionSpec.group, 'TapBody');
  assert.equal(r.motionSpec.index, 0);
});

test('点击身体触发 smile 表情与 tapBody 动作', () => {
  const r = reactionFor(manifest, 'body');
  assert.equal(r.expressionName, 'S');
  assert.equal(r.motionSpec.index, 1);
});

test('未知区域没有反应', () => {
  const r = reactionFor(manifest, 'other');
  assert.equal(r.expressionName, null);
  assert.equal(r.motionSpec, null);
});

test('语义缺失时降级为可用表情而不是崩溃', () => {
  const bare = mergeManifest(null, deriveManifest({ FileReferences: { Expressions: [{ Name: 'Only' }] } }, { id: 'y' }));
  const r = reactionFor(bare, 'head');
  assert.equal(r.expressionName, 'Only');
});

test('空闲反应回到 normal 表情并播放 idle 动作', () => {
  const r = idleReaction(manifest);
  assert.equal(r.expressionName, 'N');
  assert.equal(r.motionSpec.group, 'Idle');
});

test('模型没有动作组时空闲反应不报错', () => {
  const bare = mergeManifest(null, deriveManifest({ FileReferences: { Expressions: [{ Name: 'Only' }] } }, { id: 'z' }));
  const r = idleReaction(bare);
  assert.equal(r.expressionName, 'Only');
  assert.equal(r.motionSpec, null);
});
```

- [ ] **Step 3: 写 `test/unit/drag.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDragController, DRAG_THRESHOLD } from '../../src/renderer/ui/drag.js';

function ev(x, y, pointerId = 1, button = 0) {
  return { clientX: x, clientY: y, pointerId, button };
}

test('位移未超过阈值判定为点击', () => {
  let tapped = null;
  let dragged = false;
  const c = createDragController({ onTap: (x, y) => { tapped = [x, y]; }, onDragStart: () => { dragged = true; } });
  c.pointerDown(ev(100, 100));
  c.pointerMove(ev(100 + DRAG_THRESHOLD, 100));
  c.pointerUp(ev(100 + DRAG_THRESHOLD, 100));
  assert.equal(dragged, false);
  assert.deepEqual(tapped, [100 + DRAG_THRESHOLD, 100]);
});

test('位移超过阈值判定为拖拽', () => {
  let tapped = null;
  const moves = [];
  const c = createDragController({
    onTap: () => { tapped = true; },
    onDragMove: (m) => { moves.push(m); },
  });
  c.pointerDown(ev(100, 100));
  c.pointerMove(ev(140, 100));
  assert.equal(c.dragging, true);
  c.pointerMove(ev(150, 100));
  c.pointerUp(ev(150, 100));
  assert.equal(tapped, null);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0], { clientX: 140, clientY: 100, deltaX: 40, deltaY: 0 });
  assert.deepEqual(moves[1], { clientX: 150, clientY: 100, deltaX: 10, deltaY: 0 });
});

test('拖拽增量是可累加的，不会重复计入起点位移', () => {
  const moves = [];
  const c = createDragController({ onDragMove: (m) => { moves.push(m); } });
  c.pointerDown(ev(100, 100));
  c.pointerMove(ev(120, 100));
  c.pointerMove(ev(130, 100));
  const total = moves.reduce((sum, m) => sum + m.deltaX, 0);
  assert.equal(total, 30);
});

test('非左键不触发拖拽', () => {
  const c = createDragController({});
  c.pointerDown(ev(100, 100, 1, 2));
  c.pointerMove(ev(300, 300));
  assert.equal(c.dragging, false);
});

test('多指情况下忽略非触发指针的事件', () => {
  const c = createDragController({});
  c.pointerDown(ev(100, 100, 1));
  c.pointerMove(ev(300, 300, 2));
  assert.equal(c.dragging, false);
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node --test test/unit/hitZone.test.js test/unit/behavior.test.js test/unit/drag.test.js`
Expected: FAIL —— 三个模块均不存在。

- [ ] **Step 5: 实现 `src/renderer/pet/hitZone.js`**

```js
/** 把 Live2D 命中区名归一化。只认名字，不认模型内部的 Id。 */
export function normalizeZone(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return 'other';
  if (n.includes('head')) return 'head';
  if (n.includes('body') || n.includes('torso')) return 'body';
  return 'other';
}

/**
 * 模型没有命中区时的几何兜底：包围盒上 35% 视为头部。
 *
 * 点必须落在包围盒**内**才返回 head/body，否则一律 other：
 * 桌宠周围的空白处点击也会触发反应是很糟的体验——
 * 用户点了桌子，结果桌宠摸头卖萌。
 */
export function geometricZone(bounds, x, y) {
  if (!bounds) return 'other';
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return 'other';
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return 'other';
  if (bounds.height <= 0) return 'other';
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'other';
  if (x < bounds.x || x > bounds.x + bounds.width) return 'other';
  const rel = (y - bounds.y) / bounds.height;
  // NaN 的比较结果全是 false，会一路落到 rel <= 0.35 → 返回 'body'，
  // 对任何 x 都成立——所以这里必须显式挡掉非有限值。
  if (!Number.isFinite(rel)) return 'other';
  if (rel < 0 || rel > 1) return 'other';
  return rel <= 0.35 ? 'head' : 'body';
}

/** 优先使用模型原生命中区，失败或无结果时退回几何判定。 */
export function hitZoneAt(model, x, y) {
  const areas = model?.internalModel?.hitAreas || {};
  const hasAreas = Object.keys(areas).length > 0;
  if (hasAreas) {
    try {
      const hit = model.hitTest(x, y);
      const list = Array.isArray(hit) ? hit : hit ? [hit] : [];
      for (const h of list) {
        const zone = normalizeZone(h);
        if (zone !== 'other') return zone;
      }
    } catch {
      /* 落到几何判定 */
    }
  }
  try {
    return geometricZone(model.getBounds(), x, y);
  } catch {
    return 'other';
  }
}
```

- [ ] **Step 6: 实现 `src/renderer/pet/behavior.js`**

```js
import { resolveExpressionName, resolveMotionSpec } from './manifest.js';

/** 语义化的反应表：这里只有语义，不含任何模型专属名字。 */
export const ZONE_BEHAVIOR = {
  head: { expression: 'happy', motion: 'tapHead' },
  body: { expression: 'smile', motion: 'tapBody' },
};

export function reactionFor(manifest, zone) {
  const b = ZONE_BEHAVIOR[zone];
  if (!b) return { expressionName: null, motionSpec: null };
  return {
    expressionName: resolveExpressionName(manifest, b.expression),
    motionSpec: resolveMotionSpec(manifest, b.motion),
  };
}

/** 空闲时的默认反应：回到 normal 表情并播放 idle 动作。 */
export function idleReaction(manifest) {
  return {
    expressionName: resolveExpressionName(manifest, 'normal'),
    motionSpec: resolveMotionSpec(manifest, 'idle'),
  };
}
```

- [ ] **Step 7: 实现 `src/renderer/ui/drag.js`**

```js
export const DRAG_THRESHOLD = 6;

/**
 * 拖拽状态机：区分「点击」与「拖拽」。
 * 位移未超过阈值视为点击，超过阈值进入拖拽态。
 * onDragMove 回调给出的是**增量**位移（deltaX/deltaY），
 * 便于直接累加到窗口位置，避免重复累加造成漂移。
 */
export function createDragController({ threshold = DRAG_THRESHOLD, onTap, onDragStart, onDragMove, onDragEnd } = {}) {
  let down = null;
  let last = null;
  let dragging = false;

  return {
    get dragging() {
      return dragging;
    },
    pointerDown(e) {
      if (e.button !== 0) return;
      // 已有拖拽在进行时，第二根手指的 pointerdown 不能打断它：
      // 无条件覆盖 down/last 会把锚点跳到第二根手指上，窗口会突然位移。
      if (down && e.pointerId !== down.pointerId) return;
      down = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      last = { x: e.clientX, y: e.clientY };
      dragging = false;
    },
    pointerMove(e) {
      if (!down || e.pointerId !== down.pointerId) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!dragging && Math.hypot(dx, dy) > threshold) {
        dragging = true;
        onDragStart?.(down.x, down.y);
      }
      if (dragging) {
        const deltaX = e.clientX - last.x;
        const deltaY = e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        onDragMove?.({ clientX: e.clientX, clientY: e.clientY, deltaX, deltaY });
      }
    },
    pointerUp(e) {
      if (!down || e.pointerId !== down.pointerId) return;
      const wasDragging = dragging;
      down = null;
      last = null;
      dragging = false;
      if (wasDragging) onDragEnd?.({ clientX: e.clientX, clientY: e.clientY });
      else onTap?.(e.clientX, e.clientY);
    },
    pointerCancel() {
      down = null;
      last = null;
      dragging = false;
    },
  };
}
```

- [ ] **Step 8: 实现 `src/renderer/pet/interaction.js`**

**本模块是画布上唯一的指针事件入口**——拖拽、点击、悬停、右键全部由此统一分发。
不要再为拖拽单独挂监听器，否则同一批指针事件会被处理两次（点击会同时触发「摸头」和「拖拽」）。

```js
import { createDragController } from '../ui/drag.js';
import { hitZoneAt } from './hitZone.js';
import { reactionFor } from './behavior.js';

export function attachInteraction({
  canvas,
  getModel,
  getManifest,
  onTap,
  onHover,
  onDragStart,
  onDragMove,
  onDragEnd,
  onContextMenu,
  onInteract,
}) {
  const local = (clientX, clientY) => {
    // hitTest / focus 的入参是**世界坐标**（库内部用 worldTransform.applyInverse 换算）。
    // 这里画布铺满窗口且 stage 在原点，世界坐标与画布坐标数值相同；
    // 但一旦画布内缩或 stage 被平移，两者就不一样了——所以别把注释写成「以画布为原点」。
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const drag = createDragController({
    onTap: (clientX, clientY) => {
      const model = getModel();
      const manifest = getManifest();
      if (!model || !manifest) return;
      const { x, y } = local(clientX, clientY);
      const zone = hitZoneAt(model, x, y);
      const reaction = reactionFor(manifest, zone);
      onInteract?.();
      onTap?.({ zone, x, y, reaction });
    },
    onDragStart: (clientX, clientY) => {
      onInteract?.();
      onDragStart?.(local(clientX, clientY));
    },
    onDragMove: ({ clientX, clientY, deltaX, deltaY }) => {
      onDragMove?.({ ...local(clientX, clientY), clientX, clientY, deltaX, deltaY });
    },
    onDragEnd: ({ clientX, clientY }) => {
      onDragEnd?.({ ...local(clientX, clientY), clientX, clientY });
    },
  });

  const handleMove = (e) => {
    const { x, y } = local(e.clientX, e.clientY);
    // 悬停也算交互：空闲动画是给「用户走开了」的场景准备的，
    // 鼠标还在桌宠身上动的时候，桌宠正被看着，不该自说自话。
    onInteract?.();
    onHover?.(x, y);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    onInteract?.();
    onContextMenu?.();
  };

  const handleDown = (e) => {
    // 指针捕获：没有它，光标一旦移出画布，pointermove/pointerup 就不再送达——
    // 拖拽会丢失增量、onDragEnd 永不触发。
    // 桌宠窗口是跟着光标走的（差一个 IPC 往返），快速移动时光标会跑出窗口。
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 个别环境不支持捕获，忽略即可 */
    }
    drag.pointerDown(e);
  };

  canvas.addEventListener('pointerdown', handleDown);
  canvas.addEventListener('pointermove', (e) => {
    drag.pointerMove(e);
    handleMove(e);
  });
  canvas.addEventListener('pointerup', (e) => drag.pointerUp(e));
  canvas.addEventListener('pointercancel', () => drag.pointerCancel());
  canvas.addEventListener('contextmenu', handleContextMenu);

  return {
    dispose() {
      canvas.removeEventListener('contextmenu', handleContextMenu);
    },
    get dragging() {
      return drag.dragging;
    },
  };
}
```

- [ ] **Step 9: 跑单测确认通过**

Run: `node --test test/unit/hitZone.test.js test/unit/behavior.test.js test/unit/drag.test.js`
Expected: PASS（10 passed）。

- [ ] **Step 10: 在 `src/renderer/main.js` 中接上交互**

在 `boot()` 中，`await mountModel(...)` 之后加入：

```js
  const canvas = stage.app.view;

  // 空闲计时：20 秒无交互则播一次 idle 动作（spec §5.1）
  const DEFAULT_IDLE_MS = 20000;
  let idleMs = DEFAULT_IDLE_MS;
  let idleTimer = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!currentModel || !currentManifest) {
        resetIdleTimer();
        return;
      }
      const r = idleReaction(currentManifest);
      // 「随机待机动作」：motion 只给组名、不给索引，库会随机挑该组里的一个动作。
      // 给固定索引就不是随机的了。
      if (r.motionSpec && currentModel?.motion) {
        try {
          currentModel.motion(r.motionSpec.group)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
      // 同时回到 normal 表情——idleReaction 的语义键就是 normal。
      if (r.expressionName && currentModel?.expression) {
        try {
          currentModel.expression(r.expressionName)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
      // 重新武装：独处一会的桌宠不该只动一次就再也不动了。
      resetIdleTimer();
    }, idleMs);
  }
  resetIdleTimer();
  // 暴露出来，测试不必真的等 20 秒。
  window.__pet.idleMs = idleMs;
  // 测试缝：允许把空闲间隔调短以验证「重新武装」——
  // 没有它，重新武装只能靠代码审读确认。
  window.__pet.setIdleMs = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return idleMs;
    idleMs = ms;
    resetIdleTimer();
    return idleMs;
  };

  attachInteraction({
    canvas,
    getModel: () => currentModel,
    getManifest: () => currentManifest,
    onInteract: resetIdleTimer,
    onTap: ({ zone, reaction }) => {
      window.__pet.lastZone = zone;
      window.__pet.lastExpression = reaction.expressionName;
      window.__pet.lastMotion = reaction.motionSpec;
      // expression() / motion() 返回 promise，try/catch 抓不到异步拒绝——
      // 被拒绝的 promise 会变成未处理拒绝，违反「渲染进程不得产生未捕获错误」。
      if (reaction.expressionName && currentModel?.expression) {
        try {
          currentModel.expression(reaction.expressionName)?.catch?.(() => {});
        } catch {
          /* 表情缺失时静默跳过 */
        }
      }
      if (reaction.motionSpec && currentModel?.motion) {
        try {
          currentModel.motion(reaction.motionSpec.group, reaction.motionSpec.index)?.catch?.(() => {});
        } catch {
          /* 动作缺失时静默跳过 */
        }
      }
    },
    onHover: (x, y) => {
      window.__pet.focusPoint = { x, y };
      if (currentModel?.focus) {
        try {
          currentModel.focus(x, y);
        } catch {
          /* ignore */
        }
      }
    },
    onDragStart: () => {
      const r = currentManifest ? resolveMotionSpec(currentManifest, 'drag') : null;
      if (r && currentModel?.motion) {
        try {
          currentModel.motion(r.group, r.index);
        } catch {
          /* ignore */
        }
      }
    },
    onDragMove: ({ deltaX, deltaY }) => {
      // Task 8 会补上 moveWindowBy 的 IPC；此处的可选链保证在补上之前不报错
      window.pet.moveWindowBy?.(deltaX, deltaY);
    },
    onContextMenu: () => {
      window.pet.showContextMenu();
    },
  });
```

并在文件顶部补上 import：

```js
import { attachInteraction } from './pet/interaction.js';
import { idleReaction } from './pet/behavior.js';
import { resolveMotionSpec } from './pet/manifest.js';
```

- [ ] **Step 11: 写 `test/e2e/interaction.spec.js`**

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('点击头部与身体触发不同反应', async () => {
  const ctx = await launchApp();
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const rect = canvas.getBoundingClientRect();
      const b = model.getBounds();

      const clickAt = async (x, y) => {
        const opts = { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointermove', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
        await new Promise((r) => setTimeout(r, 60));
        return { zone: window.__pet.lastZone, expr: window.__pet.lastExpression };
      };

      const head = await clickAt(b.x + b.width / 2, b.y + b.height * 0.15);
      const body = await clickAt(b.x + b.width / 2, b.y + b.height * 0.75);
      return { head, body, rect: { w: rect.width, h: rect.height } };
    });

    expect(result.head.zone).toBe('head');
    expect(result.body.zone).toBe('body');
    expect(result.head.expr).not.toBe(result.body.expr);
    expect(result.head.expr).toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test('指针移动触发视线跟随', async () => {
  const ctx = await launchApp();
  try {
    const focus = await ctx.win.evaluate(async () => {
      const canvas = window.__pet.stage.app.view;
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 250, clientY: 40, pointerId: 1, bubbles: true })
      );
      await new Promise((r) => setTimeout(r, 60));
      return window.__pet.focusPoint;
    });
    expect(focus).not.toBeNull();
    expect(focus.x).toBeGreaterThan(200);
    expect(focus.y).toBeLessThan(100);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 12: 跑测试确认失败**

Run: `npx playwright test test/e2e/interaction.spec.js`
Expected: FAIL —— `window.__pet.lastZone` 未定义（交互尚未接上）。

- [ ] **Step 13: 跑测试确认通过**

Run: `npx playwright test test/e2e/interaction.spec.js`
Expected: PASS（2 passed）。若 `head.zone` 不是 `head`，读取 `result` 里的 `zone` 值判断是命中区未生效还是几何兜底未生效。

- [ ] **Step 14: 提交**

```bash
git add src/renderer/pet/hitZone.js src/renderer/pet/behavior.js src/renderer/pet/interaction.js src/renderer/ui/drag.js src/renderer/main.js test/unit/ test/e2e/interaction.spec.js
git commit -m "feat: 命中区判定、视线跟随与点击反应"
```

---

### Task 8: 拖拽移动、位置记忆与多屏夹紧

**Files:**
- Modify: `src/preload/index.cjs`
- Modify: `src/main/ipc.js`
- Modify: `src/main/index.js`
- Modify: `src/renderer/main.js`
- Create: `test/e2e/drag.spec.js`

**Interfaces:**
- Consumes: Task 7 的 `attachInteraction`（拖拽回调已接好）；Task 2 的 `clampToDisplays`
- Produces:
  - `window.pet.moveWindowBy(dx: number, dy: number)` —— 增量移动窗口
  - 主进程 `pet:moveWindowBy` 处理器：夹紧到可见区域后 `setPosition`，并持久化位置
  - 位置恢复：启动时读 `settings.position`，经 `clampToDisplays` 校验

- [ ] **Step 1: 打通增量移动窗口的 IPC 通路**

拖拽位移以**增量**形式传给主进程，避免绝对坐标在多显示器 / DPI 下产生漂移。

在 `src/preload/index.cjs` 中新增：

```js
  moveWindowBy: (dx, dy) => ipcRenderer.invoke('pet:moveWindowBy', { dx, dy }),
```

在 `src/main/ipc.js` 的 `registerIpc` 中新增处理器：

```js
  ipcMain.handle('pet:moveWindowBy', (_e, delta) => {
    if (!delta) return;
    onMoveBy(Number(delta.dx) || 0, Number(delta.dy) || 0);
  });
```

并在 `registerIpc` 的参数解构中加入 `onMoveBy`。

在 `src/main/index.js` 的 `registerIpc` 调用中补上：

```js
    onMoveBy: (dx, dy) => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const next = clampToDisplays(x + dx, y + dy, w, h, currentDisplays());
      win.setPosition(next.x, next.y);
      persist({ position: next });
    },
```

并把 import 改为：`import { clampToDisplays, defaultPosition } from './display.js';`

- [ ] **Step 2: 渲染层把拖拽增量转发给主进程**

Task 7 的 `attachInteraction` 已接上 `onDragMove`。本步骤把转发逻辑补全并留一个可断言的记录：

```js
    onDragMove: ({ deltaX, deltaY }) => {
      window.__pet.lastDragDelta = { deltaX, deltaY };
      window.pet.moveWindowBy?.(deltaX, deltaY);
    },
    onDragEnd: () => {
      // 主进程已在每次 moveWindowBy 时持久化位置，这里无需额外处理
    },
```

> **不要**为拖拽再单独挂一套指针监听器。Task 7 的 `attachInteraction` 是画布上唯一的指针事件入口；
> 重复挂载会导致一次拖拽被处理两次——窗口位移翻倍，且松手时同时触发「摸头」反应。
- [ ] **Step 3: 写 `test/e2e/drag.spec.js`**

```js
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers.js';

const dragBy = async (win, dx, dy, steps = 5) => {
  await win.evaluate(
    async ({ dx, dy, steps }) => {
      const canvas = window.__pet.stage.app.view;
      const opts = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true });
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(150, 300)));
      for (let i = 1; i <= steps; i++) {
        canvas.dispatchEvent(new PointerEvent('pointermove', opts(150 + (dx * i) / steps, 300 + (dy * i) / steps)));
        await new Promise((r) => setTimeout(r, 30));
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(150 + dx, 300 + dy)));
      await new Promise((r) => setTimeout(r, 400));
    },
    { dx, dy, steps }
  );
};

const windowPos = (ctx) =>
  ctx.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [x, y] = w.getPosition();
    return { x, y };
  });

const readSettings = (ctx) =>
  ctx.app.evaluate(async ({ app }) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const text = await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
    return JSON.parse(text);
  });

`test('拖拽角色会移动窗口并记住位置'`, async () => {
  const ctx = await launchApp();
  try {
    const before = await windowPos(ctx);
    await dragBy(ctx.win, 120, 60);
    const after = await windowPos(ctx);

    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);

    const saved = await readSettings(ctx);
    expect(saved.position).not.toBeNull();
    expect(typeof saved.position.x).toBe('number');
    expect(typeof saved.position.y).toBe('number');
  } finally {
    await ctx.close();
  }
});

`test('重启后角色回到上次位置'`, async () => {
  // 显式指定并复用同一个 userData 目录，模拟重启
  const userDataDir = await mkdtemp(join(tmpdir(), 'desk-pet-persist-'));
  const first = await launchApp({ userDataDir });
  let savedPosition;
  try {
    await dragBy(first.win, 120, 60);
    savedPosition = (await readSettings(first)).position;
  } finally {
    await first.close();
  }

  const second = await launchApp({ userDataDir });
  try {
    const pos = await windowPos(second);
    // 位置应与保存值一致（浮点取整后相等）
    expect(pos.x).toBe(savedPosition.x);
    expect(pos.y).toBe(savedPosition.y);
  } finally {
    await second.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
```

> 上例中「重启」需复用同一个 userData 目录。`helpers.js` 的 `launchApp` 每次生成新的临时目录，因此第二个用例改为直接复用 `first.userDataDir`：`launchApp({ userDataDir: first.userDataDir })`。实际实现时按此调整，并确保 `first.close()` 不删除该目录（`helpers.js` 中 `userDataDir` 由调用方传入时不删除）。

- [ ] **Step 4: 跑测试确认失败**

Run: `npx playwright test test/e2e/drag.spec.js`
Expected: FAIL —— 窗口位置未变化。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx playwright test test/e2e/drag.spec.js`
Expected: PASS（2 passed）。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/main.js src/main/index.js src/main/ipc.js src/preload/index.cjs test/e2e/drag.spec.js
git commit -m "feat: 拖拽移动窗口与位置记忆"
```

---

### Task 9: 设置窗口（形象 / 缩放 / 透明度）

**Files:**
- Create: `src/settings/index.html`
- Create: `src/settings/main.js`
- Modify: `src/main/index.js`
- Create: `test/e2e/settings.spec.js`

**Interfaces:**
- Consumes: Task 3 的 `window.pet` API（设置窗口同样挂同一个 preload）；Task 6 的 `pet:modelSwitchRequest`
- Produces:
  - `openSettingsWindow()` 打开设置窗口（标准边框，非透明）
  - 设置窗口可修改 `modelId` / `scale` / `opacity`，并广播给宠物窗口
  - 缩放与透明度变化后立即在宠物窗口生效

- [ ] **Step 1: 创建 `src/settings/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>桌面宠物 · 设置</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; padding: 20px 24px;
      font: 14px/1.6 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      background: #f6f7fb; color: #232733;
      min-width: 320px;
    }
    h1 { font-size: 16px; margin: 0 0 16px; }
    .row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .row label { width: 76px; flex: none; }
    select, input[type="range"] { flex: 1; }
    select {
      padding: 5px 8px; border: 1px solid #ccd2e0; border-radius: 6px;
      background: #fff; font: inherit;
    }
    .val { width: 46px; text-align: right; color: #5b647a; font-variant-numeric: tabular-nums; }
    .hint { color: #6b7488; font-size: 12px; margin-top: 4px; }
    #status { min-height: 18px; color: #2f7d4f; font-size: 12px; }
  </style>
</head>
<body>
  <h1>桌面宠物设置</h1>

  <div class="row">
    <label for="model">形象</label>
    <select id="model"></select>
  </div>

  <div class="row">
    <label for="scale">缩放</label>
    <input type="range" id="scale" min="0.5" max="2" step="0.05">
    <span class="val" id="scaleVal"></span>
  </div>

  <div class="row">
    <label for="opacity">透明度</label>
    <input type="range" id="opacity" min="0.2" max="1" step="0.05">
    <span class="val" id="opacityVal"></span>
  </div>

  <div id="status"></div>
  <div class="hint">设置即时生效并自动保存。</div>

  <script type="module" src="/src/settings/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 `src/settings/main.js`**

```js
const modelSelect = document.getElementById('model');
const scaleInput = document.getElementById('scale');
const opacityInput = document.getElementById('opacity');
const scaleVal = document.getElementById('scaleVal');
const opacityVal = document.getElementById('opacityVal');
const status = document.getElementById('status');

function show(msg) {
  status.textContent = msg;
  if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2000);
}

async function init() {
  const [settings, models] = await Promise.all([window.pet.getSettings(), window.pet.listModels()]);
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = settings.modelId;
  scaleInput.value = String(settings.scale);
  opacityInput.value = String(settings.opacity);
  scaleVal.textContent = `${Number(settings.scale).toFixed(2)}x`;
  opacityVal.textContent = `${Math.round(settings.opacity * 100)}%`;
}

modelSelect.addEventListener('change', async () => {
  await window.pet.switchModel(modelSelect.value);
  show(`已切换到 ${modelSelect.options[modelSelect.selectedIndex].text}`);
});

scaleInput.addEventListener('input', async () => {
  const v = Number(scaleInput.value);
  scaleVal.textContent = `${v.toFixed(2)}x`;
  await window.pet.saveSettings({ scale: v });
});

opacityInput.addEventListener('input', async () => {
  const v = Number(opacityInput.value);
  opacityVal.textContent = `${Math.round(v * 100)}%`;
  await window.pet.saveSettings({ opacity: v });
});

init().catch((e) => show(`加载失败：${e.message}`));
```

- [ ] **Step 3: 在 `src/main/index.js` 中实现设置窗口**

```js
import { appUrl } from './protocol.js';

let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '桌面宠物 · 设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadURL(appUrl('/src/settings/index.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}
```

把 Task 3 中的占位 `openSettings` 替换为此实现，并保留 `showContextMenu` 调用 `openSettings` 的行为。

> 注意：Task 3 的 `src/main/index.js` **没有** import `appUrl` 与 `applySettingsToWindow`（那时还没用到）。
> 本步需要在 `src/main/index.js` 顶部补上：
> `import { appUrl } from './protocol.js';`
> `import { applySettingsToWindow } from './window.js';`

同时，`pet:saveSettings` 需要把缩放/透明度变化广播给宠物窗口：

```js
    saveSettings: (patch) => {
      const next = persist(patch);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pet:settingsChanged', next);
      }
      return next;
    },
```

在 `src/preload/index.cjs` 中新增：

```js
  onSettingsChanged: (cb) => {
    ipcRenderer.on('pet:settingsChanged', (_e, s) => cb(s));
  },
```

在 `src/renderer/main.js` 的 `boot()` 中：

```js
  window.pet.onSettingsChanged(async (s) => {
    if (typeof s.scale === 'number') {
      userScale = s.scale;
      if (currentModel) stage.fitModel(currentModel, currentManifest, userScale);
    }
    if (typeof s.opacity === 'number') {
      window.__pet.opacity = s.opacity;
    }
  });
```

> 透明度由主进程 `win.setOpacity()` 施加，因此 `persist` 之后要调用 `applySettingsToWindow(win, settings)`。
> **注意：Task 3 的 `persist` 已经是下面这个形态**（内部过 `sanitizeSettings`、写失败有日志、
> 退出前有 `flushPendingSave`）——本步只加一行 `applySettingsToWindow`，**不要整段替换 persist**：

```js
function persist(patch) {
  settings = sanitizeSettings({ ...settings, ...patch });
  if (win && !win.isDestroyed()) applySettingsToWindow(win, settings);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSettings();
  }, 300);
  return settings;
}
```

- [ ] **Step 4: 写 `test/e2e/settings.spec.js`**

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('设置窗口可打开并列出全部形象', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.openSettings());
    const settingsWin = await ctx.app.waitForEvent('window');
    await settingsWin.waitForLoadState('domcontentloaded');
    const labels = await settingsWin.locator('#model option').allTextContents();
    expect(labels).toEqual(['Haru', 'Natori']);

    // 选中 Natori 后宠物窗口应切换形象
    await settingsWin.locator('#model').selectOption('natori');
    await settingsWin.waitForTimeout(600);
    const modelId = await ctx.win.evaluate(() => window.__pet.modelId);
    expect(modelId).toBe('natori');
  } finally {
    await ctx.close();
  }
});

test('切换形象与调整缩放生效并被持久化', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(async () => {
      await window.pet.switchModel('natori');
    });
    await ctx.win.evaluate(async () => {
      await window.pet.saveSettings({ scale: 1.4, opacity: 0.8 });
    });
    await new Promise((r) => setTimeout(r, 500));

    const saved = await ctx.app.evaluate(async ({ app }) => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      return JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    });
    expect(saved.modelId).toBe('natori');
    expect(saved.scale).toBe(1.4);
    expect(saved.opacity).toBe(0.8);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx playwright test test/e2e/settings.spec.js`
Expected: PASS（2 passed）。

- [ ] **Step 6: 提交**

```bash
git add src/settings/ src/main/index.js src/preload/index.cjs src/renderer/main.js test/e2e/settings.spec.js
git commit -m "feat: 设置窗口支持形象切换、缩放与透明度"
```

---

### Task 10: 文档、许可说明与全量验收

**Files:**
- Create: `README.md`
- Create: `NOTICE`
- Modify: `.gitignore`
- Create: `test/e2e/acceptance.spec.js`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可交付的项目文档与一套端到端验收用例

- [ ] **Step 1: 确认 `.gitignore` 的模型忽略规则**

模型二进制的忽略规则 **Task 1 已加入并验证**，本步只需确认，不要重复添加：

```
assets/live2d/models/haru/*
!assets/live2d/models/haru/pet.json
assets/live2d/models/natori/*
!assets/live2d/models/natori/pet.json
```

> 不要写成 `assets/live2d/models/*` 或 `assets/live2d/models/haru/**`：
> git 不会进入被排除的目录，反向规则也就无法重新包含 `pet.json`，结果是清单反而没被提交。
> 逐目录 `/*` + 同级反向 `!` 才是有效写法。

验证：`git ls-files assets/live2d/` 应列出 `index.json` 与两个 `pet.json`；
`git check-ignore -v assets/live2d/models/haru/Haru.moc3` 应有命中。

- [ ] **Step 2: 写 `NOTICE`**

```markdown
# 第三方素材与许可说明

本项目包含以下第三方内容，均非本项目原创。

## Live2D Cubism Core

- 来源：npm 包 `live2dcubismcore@1.0.2`（内含 Live2D Cubism Core for Web）
- 版权：© Live2D Inc.
- 许可：Live2D Proprietary Software License Agreement
  <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- 说明：Cubism Core 为专有许可代码，**不是** MIT 许可。个人使用与内部分发无碍；
  若要公开分发本项目或其编译产物，必须先阅读并履行上述许可条款。

## Live2D 官方样例模型（Haru、Natori）

- 来源：<https://github.com/Live2D/CubismWebSamples> 的 `Samples/Resources/` 目录
- 版权：© Live2D Inc.
- 许可：Live2D 官方样例素材条款，**限非商业用途**
- 说明：本仓库不提交这些二进制资源，由 `npm run setup` 自动获取。
  若要用于商业场景，请改用你拥有授权的模型。

## pixi.js

- npm 包 `pixi.js@6.5.10`，MIT 许可，© PixiJS

## pixi-live2d-display

- npm 包 `pixi-live2d-display@0.4.0`，MIT 许可
```

- [ ] **Step 3: 写 `README.md`**

````markdown
# 桌面宠物（Live2D）

Windows 桌面上的 Live2D 桌宠。默认形象为 Live2D 官方样例角色 Haru。

## 功能

- 透明无边框、置顶的桌宠窗口
- Live2D 待机动画、呼吸、眨眼、物理效果
- 视线跟随鼠标
- 摸头 / 点击身体触发不同表情与动作
- 按住拖拽移动，位置自动记忆
- 系统托盘菜单（显示隐藏 / 设置 / 退出）
- 角色右键菜单
- 多显示器与 DPI 适配
- 运行时切换形象

## 环境要求

- Windows 11
- Node.js ≥ 20

## 快速开始

```bash
npm install     # 安装依赖（含 Electron 自动下载）
npm run setup   # 下载 Live2D 官方样例模型 + 生成托盘图标
npm start       # 启动桌宠
```

`npm run setup` 需要联网（从 GitHub 拉取官方样例资源）。执行一次后资源会缓存在
`assets/live2d/models/` 下，之后可离线重复运行。

## 测试

```bash
npm run test:unit   # 主进程纯函数单测（node:test）
npm run test:e2e    # 端到端测试（Playwright + Electron）
npm test            # 全部
```

## 目录结构

```
src/main/       主进程：窗口、托盘、菜单、设置持久化、多显示器
src/preload/    contextBridge 白名单 API
src/renderer/   渲染层：pixi + Live2D 模型与交互
src/settings/   设置窗口
assets/live2d/  模型资源与 pet.json 清单
```

## 添加自己的形象

1. 把模型目录放到 `assets/live2d/models/<id>/`（需含 `.model3.json`、`.moc3`、纹理等）
2. 在 `assets/live2d/index.json` 注册该形象
3. 可选：写一份 `pet.json` 清单，把表情/动作映射到语义键

清单缺失时应用会自动从 `model3.json` 探测能力并降级运行，因此**只放目录也能加载**。

清单格式见 `assets/live2d/models/haru/pet.json`。

## 许可

见 [NOTICE](./NOTICE)。Cubism Core 为 Live2D 专有许可代码，官方样例模型限非商业用途。
````

- [ ] **Step 4: 写 `test/e2e/acceptance.spec.js`（对照 spec 第 11 节验收标准）**

```js
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('验收：模型渲染、表情、命中区、设置持久化齐备', async () => {
  const ctx = await launchApp();
  try {
    const state = await ctx.win.evaluate(() => ({
      ready: window.__pet?.ready === true,
      modelLoaded: window.__pet?.modelLoaded === true,
      modelId: window.__pet?.modelId,
      expressions: window.__pet?.expressions?.length ?? 0,
      hitAreas: window.__pet?.hitAreas ?? [],
      hasCanvas: !!window.__pet?.stage?.app?.view,
      error: window.__pet?.error ?? null,
    }));

    expect(state.error).toBeNull();
    expect(state.ready).toBe(true);
    expect(state.modelLoaded).toBe(true);
    expect(state.modelId).toBe('haru');
    expect(state.expressions).toBeGreaterThan(0);
    expect(state.hitAreas).toContain('Head');
    expect(state.hitAreas).toContain('Body');
    expect(state.hasCanvas).toBe(true);
  } finally {
    await ctx.close();
  }
});

test('验收：主进程与渲染进程均无未捕获错误', async () => {
  const ctx = await launchApp();
  const errors = [];
  ctx.win.on('pageerror', (e) => errors.push(String(e)));
  try {
    await new Promise((r) => setTimeout(r, 1500));
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: 单测与 E2E 全部 PASS。

- [ ] **Step 6: 手动验收（需人工确认）**

Run: `npm start`

逐条核对 spec 第 11 节：
1. 桌面出现透明背景的 Haru，持续做待机动画、呼吸与眨眼
2. 鼠标靠近时视线跟随；点击头部与身体分别触发不同表情与动作
3. 可拖拽角色到任意位置，跨显示器拖动正常
4. 托盘可隐藏/显示角色、打开设置、退出应用
5. 在角色身上右键弹出菜单
6. 关闭并重启应用，角色回到上次位置
7. 设置窗口可切换形象（Haru ↔ Natori）、调整缩放与透明度，切换后功能仍完整
8. `npm test` 全部通过

- [ ] **Step 7: 提交**

```bash
git add README.md NOTICE .gitignore test/e2e/acceptance.spec.js
git commit -m "docs: 项目说明、第三方许可说明与验收用例"
```
