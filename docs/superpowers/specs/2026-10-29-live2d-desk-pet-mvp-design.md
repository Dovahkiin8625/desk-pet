# Live2D 桌面宠物 MVP — 设计规格

- 日期：2026-10-29
- 状态：待评审
- 目标平台：Windows 11
- 交付形态：开发模式跑通（`npm start`），不做安装包打包

---

## 1. 目标与范围

实现 idea.md「一、核心基础（MVP 必做）」的 8 项能力：

| # | 需求 | 验收表现 |
|---|---|---|
| 1 | 透明无边框窗口 | 桌面上悬浮一个无边框、背景透明的窗口，只有角色可见 |
| 2 | Live2D 模型渲染 | 角色常驻渲染，具备待机动画、呼吸、眨眼 |
| 3 | 鼠标交互 | 点击头部/身体触发不同动作与表情；鼠标移动时视线跟随 |
| 4 | 窗口拖拽移动 | 按住角色拖动，角色跟随移动 |
| 5 | 系统托盘图标 | 托盘可「显示/隐藏」「设置」「退出」 |
| 6 | 右键菜单 | 在角色身上右键弹出菜单 |
| 7 | 位置记忆 | 退出后重启，角色回到上次所在位置 |
| 8 | 多屏适配 | 支持多显示器，跨屏拖动后位置正确，DPI 缩放不失真 |

**明确的范围外**（属 idea.md 第二～六节，留待后续阶段）：语音/Lip Sync、AI 对话、天气/待办等助理功能、养成系统、模型导入的操作入口、开机自启、全局热键、鼠标穿透、贴边隐藏、自动更新、正式安装包。

MVP 中仅额外包含两处「入口级」内容，因为 idea.md 明确要求托盘提供设置入口：
- 托盘菜单的「设置」项 → 打开一个最小设置窗口
- 设置窗口提供三项：**形象选择**、**缩放**、**透明度**

---

## 2. 技术选型

### 2.1 选定方案

**Electron + pixi.js v6 + pixi-live2d-display + Live2D Cubism Core（Web）**

| 层 | 技术 | 版本 |
|---|---|---|
| 宿主 | Electron | ^45 |
| 渲染 | pixi.js（WebGL） | 6.5.10 |
| Live2D 渲染适配 | pixi-live2d-display | 0.4.0（`dist/cubism4.min.js`） |
| Live2D 运行时 | Cubism Core for Web | 来自 npm `live2dcubismcore@1.0.2` |
| 模型 | Live2D 官方样例 **Haru**（默认）+ **Natori**（第二形象） | Cubism 3 格式（moc3） |
| 语言 | JavaScript（ESM），无 TypeScript、无打包器 | — |

### 2.2 选型理由与被否决方案

| 方案 | 结论 | 理由 |
|---|---|---|
| **Electron** | ✅ 选定 | 8 项 MVP 需求全部有现成 API（透明窗/托盘/多屏/DPI/菜单）。Live2D Web SDK 原生适配。开发最快。 |
| .NET 10 WPF + WebView2 | ❌ | Live2D 渲染层与本方案完全相同，但 WebView2 的透明背景与局部点击穿透需跨进程坐标回传，复杂度更高；仅当内存占用成为实际瓶颈时再考虑。 |
| Tauri v2 | ❌ | 需额外安装 Rust 工具链；Windows 透明窗/穿透支持弱；Live2D 层不变，收益仅在安装包体积。 |
| 原生 C++/Qt + Cubism Native SDK | ❌ | 需 VS C++ 工具链 + 注册下载 Native SDK + 大量胶水代码，MVP 性价比最低。 |

**已知代价（接受）**：常驻内存约 150–250 MB，安装后体积约 180 MB（开发模式下仅 Electron 二进制体积）。

### 2.3 已验证的技术事实

以下结论均由一次一次性原型（spike）在本机实测得出，非推测：

1. **pixi v6 的 UMD 全局 `PIXI` 已包含 `PIXI.utils` 及全部 `@pixi/*` 导出**，正好补齐 `pixi-live2d-display` UMD 全局分支的 externals 映射（`(PIXI, PIXI.utils, PIXI, PIXI, PIXI)`）。因此**无需 esbuild/vite 打包器**。
2. **Cubism Core 须作为全局 `Live2DCubismCore` 在模型实例化前加载**。
3. Haru 与 Natori 的 `model3.json` 均声明 `HitAreas`，且**名称统一为 `"Head"` / `"Body"`**（内部 `Id` 各不相同，故按 `Name` 归一化）。
4. 已实测可用 API：`model.motion(group, index)`、`model.expression(name)`、`model.focus(x, y)`、`model.hitTest(x, y)`。
5. `internalModel` 内建 `eyeBlink` / `breath` / `physics` / `lipSync` / `hitAreas`。
6. 渲染无 console 错误；Haru 原始尺寸 2400×4500，Natori 4000×7000。

---

## 3. 架构

```
┌─ Electron 主进程 ──────────────────────────────────────┐
│  src/main/                                              │
│    index.js       应用生命周期 + 单实例锁               │
│    protocol.js    app:// 自定义协议（静态资源）          │
│    window.js      宠物窗口创建/显隐/位置                 │
│    tray.js        系统托盘                               │
│    menu.js        托盘菜单 + 右键原生菜单               │
│    settings.js    settings.json 读写                    │
│    display.js     多显示器可见区域计算（纯函数）          │
│    ipc.js         IPC 处理器装配                         │
└────────────┬────────────────────────────────────────────┘
             │ contextBridge（白名单，禁用 nodeIntegration）
┌────────────▼────────────────────────────────────────────┐
│ 渲染进程（无构建步骤，原生 ES module）                    │
│  src/renderer/                                          │
│    main.js         引导：装配 stage + model + interaction│
│    pet/stage.js    pixi Application、透明画布、缩放适配   │
│    pet/manifest.js 模型清单加载 + 能力探测               │
│    pet/model.js    模型生命周期：加载/切换/释放           │
│    pet/hitZone.js  命中归一化 + 几何兜底                 │
│    pet/interaction.js 指针事件 → 点击/拖拽/视线/右键菜单    │
│    pet/behavior.js 反应表：交互 → 表情 + 动作            │
│    ui/drag.js      拖拽状态机（点击 vs 拖拽判定）          │
└──────────────────────────────────────────────────────────┘
```

### 3.1 关键决策

| 决策 | 原因 | 被否决的做法 |
|---|---|---|
| **自建 `app://` 协议**加载渲染层资源 | `file://` 下 Chromium 拦截 fetch，`model3.json` 与纹理必然 CORS 失败 | `win.loadFile()` |
| **不引入打包器** | 见 2.3 第 1 条 | esbuild / vite |
| **按 `HitArea.Name` 归一化**命中区 | Haru 与 Natori 的 `Id` 不同但 `Name` 一致 | 按 `Id` 匹配（换模型即失效） |
| **模型清单（manifest）外置为数据** | 换形象是改数据，不是改代码 | 把表情名硬编码在交互逻辑里 |

---

## 4. 模型抽象层（形象更换）

这是本设计的核心。**任何模型相关的具体名字都不允许出现在交互逻辑代码中。**

### 4.1 目录结构

```
assets/live2d/
├── index.json                    全局形象注册表
├── haru/
│   ├── Haru.model3.json          （官方样例原文件）
│   ├── Haru.moc3
│   ├── Haru.2048/*.png
│   ├── Haru.physics3.json
│   ├── Haru.pose3.json
│   ├── Haru.userdata3.json
│   ├── Haru.cdi3.json
│   ├── expressions/F01..F08.exp3.json
│   ├── motions/haru_g_*.motion3.json
│   └── pet.json                  ← 我方清单（模型适配层）
└── natori/
    ├── Natori.model3.json ...
    └── pet.json
```

### 4.2 `pet.json` 清单格式

```json
{
  "id": "haru",
  "name": "Haru",
  "model3": "Haru.model3.json",
  "viewport": { "width": 300, "height": 560 },
  "fit": { "scale": 1.0, "anchor": [0.5, 1.0], "offset": [0, 0] },
  "expressions": {
    "normal": "F01", "happy": "F05", "smile": "F08",
    "shy": "F07", "angry": "F02", "surprised": "F06", "sad": "F03"
  },
  "motions": {
    "idle":    { "group": "Idle",    "index": 0 },
    "tapHead": { "group": "TapBody", "index": 0 },
    "tapBody": { "group": "TapBody", "index": 1 },
    "drag":    { "group": "TapBody", "index": 3 }
  }
}
```

### 4.3 语义映射

交互逻辑只使用**语义意图**（`happy` / `angry` / `tapHead` …），由清单映射到模型实际名字。

Haru 的表情是通用名 `F01–F08`，语义由其参数反推（依据 `ParamMouthForm` 符号、`ParamEyeOpen`、`ParamEyeSmile`、`ParamBrowLY/RY`、`ParamTere` 脸红参数），并经渲染比对确认：

| 语义 | Haru | Natori |
|---|---|---|
| normal | F01（平静） | Normal |
| happy | F05（闭眼笑 ^^） | Smile |
| smile | F08（微笑） | — |
| shy | F07（含 `ParamTere` 脸红） | Blushing |
| angry | F02（皱眉 + 张嘴） | Angry |
| surprised | F06（睁大眼） | Surprised |
| sad | F03（皱眉） | Sad |

> Haru 的 `smile`/`sad` 为近似归类，属可接受误差；换模型只需改清单，不改代码。

### 4.4 能力探测与降级

模型加载时探测实际能力，缺失项自动降级，**不报错、不崩溃**：

| 能力 | 探测方式 | 缺失时降级 |
|---|---|---|
| 命中区 | `internalModel.hitAreas` | 按模型包围盒几何分区：上 35% 视为头部，其余为身体 |
| 表情 | 清单 `expressions` / `model3.json` 的 `Expressions` | 语义缺失 → 退化为播放对应动作；仍缺失 → 仅播动作 |
| 动作组 | `motionManager.definitions` | 组名不匹配 → 退化为播放第一个可用动作 |
| 物理 / 眨眼 / 呼吸 | `internalModel` 上的对应对象 | 缺失则该效果不生效，不影响其余功能 |

### 4.5 运行时切换形象

设置窗口切换形象时：

1. 主进程广播 `model-switch-request`
2. 渲染进程 `model.destroy()` 旧模型 → **显式释放纹理**（`PIXI.Texture` 缓存按 URL 键入，需手动 `removeFromCache` + `destroy(true)`），否则显存持续增长
3. 加载新 `pet.json` → 重新应用 fit/anchor → 重新装配交互
4. 失败则回滚到原形象并提示

### 4.6 模型能力探测（为 idea.md 第五节「模型导入」预留）

**MVP 范围内**：4.4 的能力探测逻辑已实现并生效——任何缺失 `pet.json` 的模型目录，渲染进程会自动从 `model3.json` 探测出表情名列表、动作组、命中区，并计算包围盒以生成 fit 参数。因此**放入一个模型目录即可被加载**，不需要手写清单。

探测阶段**不猜语义**：语义一律保持未映射——未映射的表情语义只播对应动作、不套表情（见 4.4 的降级表）。唯一的例外是「普通表情（normal）」：它**按名字**匹配模型里叫 `Normal` 的表情（Natori 有，见 4.3；Haru 的表情名是 F01–F08，没有），匹配不到就留空——空闲时只播动作、不套任何表情。绝不按序号猜：Natori 的表情表第一项是 Angry，按序号兜底会让「摸头」触发生气的脸，也会让没写清单的 Natori 在空闲时永远挂着那张脸。

**MVP 范围外**：设置窗口里「从本地导入模型目录」的操作入口（复制目录到 `assets/live2d/models/<id>/` 并生成 `pet.json`）属 idea.md 第五节，留待后续阶段。

---

## 5. MVP 行为规格

### 5.1 交互反应表

| 交互 | 判定 | 反应 |
|---|---|---|
| 视线跟随 | 指针移动且未按下 | `model.focus(x, y)`，眼睛/头部跟随鼠标 |
| 摸头 | `hitTest()` 返回 `Head` | 表情 `happy` + 动作 `tapHead` |
| 点击身体 | `hitTest()` 返回 `Body` | 表情 `smile` + 动作 `tapBody` |
| 拖拽 | 按下后位移 > 6 px | 动作 `drag`；窗口跟随指针；松手后回到 `idle` |
| 空闲 | 无交互 20 s | 随机播放 `idle` 动作 |

### 5.2 拖拽判定

- `pointerdown` 记录起点，**不立即移动窗口**（避免误触）
- 位移超过阈值（6 px）判定为拖拽，进入 `drag` 状态并开始移动窗口
- 未超阈值且 `pointerup` → 判定为点击 → 走命中区逻辑
- 拖拽中窗口跟随指针相对偏移移动，松手时位置持久化

### 5.3 右键菜单

角色窗口内 `contextmenu` 事件 → IPC → 主进程 `Menu.popup()` 弹出原生菜单：

```
显示 / 隐藏     (切换)
─────────────
设置…
─────────────
退出
```

菜单项选中后通过 IPC 通道回传动作给渲染进程（表情/动作类）或直接由主进程执行（窗口/退出类）。

### 5.4 托盘菜单

```
显示 / 隐藏
─────────────
设置…
─────────────
退出
```

### 5.5 位置记忆

- 位置存于 `app.getPath('userData')/settings.json`
- 拖拽结束、窗口移动、退出时写入
- 启动时恢复，并经 `clampToDisplays()` 校验：若保存位置不在任何显示器的 `workArea` 内（显示器被拔掉），则回落到主显示器可见区域内的默认位置（右下角）

### 5.6 多屏与 DPI

- `screen.getAllDisplays()` 获取全部显示器及其 `workArea`（已排除任务栏区域）
- Electron 窗口坐标使用 DIP（device-independent pixel），per-monitor DPI 缩放由 Chromium 自动处理
- 跨屏拖动时，窗口位置基于全局坐标计算，不做 DPI 手工换算

---

## 6. 数据格式

### 6.1 `settings.json`

```json
{
  "version": 1,
  "position": { "x": 1700, "y": 820 },
  "modelId": "haru",
  "scale": 1.0,
  "opacity": 1.0,
  "visible": true
}
```

字段语义：

- `position` —— 宠物窗口左上角的**全局 DIP 坐标**
- `modelId` —— 对应 `assets/live2d/index.json` 中的形象 id
- `scale` —— **用户缩放倍率**，取值 0.5–2.0，作用于清单 `fit.scale` 之上（最终缩放 = 视口自适应缩放 × `fit.scale` × 用户 `scale`）
- `opacity` —— **窗口整体不透明度**，取值 0.2–1.0，由主进程 `BrowserWindow.setOpacity()` 施加（作用于窗口整体，非仅角色像素）
- `visible` —— 退出时是否处于显示状态，用于下次启动是否直接显示

`settings.js` 提供 `sanitizeSettings(raw)`：逐字段校验类型与范围，非法值回退默认（防止手改 JSON 或旧版本字段导致崩溃）。

### 6.2 `assets/live2d/index.json`

```json
{
  "models": [
    { "id": "haru",   "name": "Haru",   "manifest": "haru/pet.json" },
    { "id": "natori", "name": "Natori", "manifest": "natori/pet.json" }
  ]
}
```

---

## 7. 目录结构（最终）

```
desk-pet/
├── idea.md
├── package.json
├── README.md
├── NOTICE                        Live2D 许可与素材来源说明
├── .gitignore
├── docs/superpowers/specs/2026-10-29-live2d-desk-pet-mvp-design.md
├── assets/
│   ├── live2d/
│   │   ├── index.json
│   │   ├── haru/{...官方样例资源..., pet.json}
│   │   └── natori/{...官方样例资源..., pet.json}
│   └── icons/tray.png, tray@2x.png
├── src/
│   ├── main/{index,protocol,window,tray,menu,settings,display,ipc}.js
│   ├── preload/index.js
│   ├── renderer/{index.html,main.js,pet/*,ui/*}
│   └── settings/{index.html,main.js}
└── test/
    ├── display.test.js           纯函数单测（node:test）
    ├── settings.test.js
    └── e2e/renderer.spec.js      Playwright 端到端
```

---

## 8. 关键实现细节（已踩坑确认）

1. **脚本加载顺序**：`pixi.js` → `live2dcubismcore.min.js` → `cubism4.min.js` → 应用模块。Core 必须在模型实例化前就位。
2. **禁止使用 `-webkit-app-region: drag`**：会吞掉全部指针事件，导致 `hitTest` 与摸头失效。拖拽一律走 renderer 指针事件 + IPC。
3. **`model.hitTest()` 接受全局坐标**，内部会换算到模型局部坐标。
4. **窗口尺寸固定**，用 `resizable: false` + 模型缩放适配，而非缩放窗口。
5. **`transparent: true` 需配 `hasShadow: false`** 才不会出现黑色边框阴影。
6. **`skipTaskbar: true`**：桌宠不应出现在任务栏。
7. **`alwaysOnTop: true`** 即可，普通置顶级别不抢焦点；不设 `focusable: false`（否则点击交互失效）。
8. **切换模型必须显式销毁纹理**，否则多次切换后显存持续增长。
9. **`contextIsolation: true` + `nodeIntegration: false`**，渲染进程仅通过 preload 暴露的白名单 API 与主进程通信。

---

## 9. 测试策略

| 层 | 方式 | 覆盖 |
|---|---|---|
| 主进程纯逻辑 | `node:test` | `clampToDisplays`（显示器拔除/负坐标/多屏）、`sanitizeSettings`（非法值/缺字段/旧版本） |
| 渲染层 | Playwright 端到端 | 模型加载成功、命中区返回 `Head`/`Body`、表情切换生效、拖拽后窗口坐标变化、切换形象后新模型生效 |
| 手动验收 | 实际启动 | 透明背景、置顶、托盘菜单、右键菜单、重启后位置恢复、拔掉副屏后位置回落 |

---

## 10. 许可与合规

- **Live2D Cubism Core** 为 Live2D Inc. 专有许可代码（Live2D Proprietary Software License Agreement），非 MIT。个人使用与内部分发无碍。
- **官方样例模型（Haru / Natori）** 依 Live2D 样例素材条款，限非商业用途。
- 本项目定位为个人自用桌面宠物。**若将来公开分发二进制或用于商业用途，必须先确认并履行上述条款。**
- 上述内容写入 `NOTICE` 与 `README`。

---

## 11. 验收标准

MVP 完成需同时满足：

1. `npm start` 启动后，桌面出现透明背景的 Haru，持续做待机动画、呼吸与眨眼
2. 鼠标靠近时视线跟随；点击头部与身体分别触发不同表情与动作
3. 可拖拽角色到任意位置，跨显示器拖动正常
4. 托盘可隐藏/显示角色、打开设置、退出应用
5. 在角色身上右键弹出菜单
6. 关闭并重启应用，角色回到上次位置；若该位置所在显示器已不存在，回落到主显示器可见区域
7. 设置窗口可切换形象（Haru ↔ Natori）、调整缩放与透明度，切换后功能仍完整
8. `npm test` 全部通过
