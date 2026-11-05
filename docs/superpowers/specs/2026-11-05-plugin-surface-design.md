# 插件界面（surface）与录屏插件优化 —— 设计

日期：2026-11-05
状态：已确认，待实现
前一版：[2026-11-04-screen-recorder-design.md](./2026-11-04-screen-recorder-design.md)

## 一、要解决什么

三个问题：

1. **录屏插件没法在新窗口打开。** 面板上的「↗ 在新窗口打开」按钮由清单里有没有
   `window` 段决定（`src/shared/plugin.js` 的 `canDetach()`），录屏的清单没写，
   所以按钮整个藏掉。用户要的是：**每个插件都能在新窗口打开，这是桌宠本身的
   特性，不是插件的特性。**
2. **录屏卡。** 切模式卡、开始录制卡。卡的原因在代码里写着：
   `plugins/screen-recorder/lib/capture.js:49-51` 自己记着「列一次窗口要 5.5 秒」，
   而切模式每次都列一遍；`lib/windows.js` 的捕获窗口录完就销毁，下次录制又要
   重新建窗口、等页面加载（`capture.js:186` 最多等 15 秒）。
3. **界面丑。** 插件自己的页面用的是冷色（`#f3f3f3`、`#4f9dff`），
   桌宠用的是暖色（`#fffdf8`、`#d9c9a3`）——两套设计，像两个产品。

顺带把插件开发变简单：现在插件页面只能走 `file://` + 经典脚本
（`file://` 下 ES module 被 CORS 拦掉），共用不了宿主的样式与模块。

## 二、用户拍板的决定

| 决定 | 选择 | 备注 |
| --- | --- | --- |
| 新窗口的语义 | 类似 uTools：工作台与新窗口**都有**，界面**一套**，响应式 | 工作台窄、新窗口可拉伸变宽 |
| 新窗口归属 | **桌宠插件系统的特性**，与插件无关 | 所有插件都有 ↗ |
| 界面由谁画 | **混合**：默认声明式积木，插件也可自带页面 | 自带页面的插件，两处都用同一份 |
| 视觉风格 | **沿用桌宠的暖色卡片风** | 米白底、圆角、淡金强调 |
| 插件页面加载方式 | **走 `app://`** | 已是 secure context，能用 ES module 与共享样式 |
| 响应式由谁做 | 插件自己实现（容器查询） | 宿主提供容器与共享主题 |

## 三、已实测的技术事实

这一节的每一条都在本机（Windows 11 / Electron 45.1.0）或本仓库代码里核对过。

| 事实 | 依据 |
| --- | --- |
| `app://` 是 secure context | `src/main/protocol.js:48-53` 注册了 `secure: true`、`standard: true` |
| `app://` 能取到项目内任意文件 | `src/main/staticFiles.js:48-82` 只挡越界与密钥文件 |
| `/src/renderer/ui/theme.css`、`/plugins/<id>/pages/x.html` 都能取到 | 同上；`host.baseUrl()` 见 `src/main/plugins/host.js:246-251` |
| 用户插件走虚拟根 `/__plugins__/<id>` | `src/main/index.js:908-911` 注册的 virtualRoots |
| 面板是普通 `sandbox` + `contextIsolation` 窗口，同源 iframe 可用 | `src/main/panel.js:160-180`；iframe 不需要 `webviewTag` |
| iframe 与父页面同源（`app://bundle`） | 自定义 scheme 以 `standard: true` 注册，origin 就是 `app://bundle` |
| 面板窗口高度由内容撑开 | `src/renderer/panel/main.js:96` `reportHeight()` → `panel:size` → `src/main/panel.js:376-381` `setBounds` |
| 面板窗口失焦就隐藏 | `src/main/panel.js` `win.on('blur')` |
| 独立窗口与小部件是同一个窗口的两种形态 | `src/main/plugins/window.js:197-208` `switchMode` 是销毁重建 |
| 桌面小部件（`widget`）仍然要插件自愿 | 用户没要求改；保留 `manifest.widget` |
| 内置功能（设置、聊天记录）不是插件 | `src/main/builtins.js:36-44`，`canDetach: false` |
| 录屏的捕获窗口跑在独立分区 | `lib/capture.js:6` `persist:screen-recorder` |

## 四、核心抽象：界面（surface）

插件的界面有**两处落点**：面板工作台、独立窗口。两处显示的是**同一个插件界面**，
用同一份数据、同一套动作。所以宿主把「插件界面」抽象成一等概念：

```text
一个插件 = 一份界面契约（data / tick / act）
                    ↓ ┌───────────┴───────────┐
   面板工作台（窄容器）      独立窗口（宽容器，可拉伸）
```

**界面契约**（插件实例上的方法，已有 + 新增）：

| 方法 | 作用 | 状态 |
| --- | --- | --- |
| `page(ctx)` | 声明式页面描述（积木） | 已有 |
| `action(ctx, actionId, value)` | 声明式页面的动作 → 新的页面 | 已有 |
| `data(ctx)` | 界面打开时的第一份数据 | 已有 |
| `tick(ctx)` | 界面的周期数据 | 已有 |
| `act(ctx, actionId, payload)` | 自带页面的动作 | 已有 |
| `meta(ctx)` | 标题/副标题/状态（自带页面时，宿主只取这三个） | **新增，可选** |

`meta(ctx)` 是可选的：不写就退回用 `page(ctx)` 的 `title`/`subtitle`/`status`。
**约定**：自带页面的插件，`page(ctx)` 里不要做重活（不要列目标、不要查磁盘）——
面板头部只需要 `meta`，重活留给页面自己通过 `act` 去要。

## 五、宿主改动

### 5.1 新窗口是默认能力

`src/shared/plugin.js`：

- 新增 `defaultWindowSpec(manifest)`：标题取插件名，宽高取
  `PLUGIN_WINDOW_LIMITS` 的默认值（360×420），`refreshMs: 0`，`alwaysOnTop: false`。
- 新增 `resolveWindowSpec(manifest, mode)`：`mode === 'widget'` 时取 `manifest.widget`
  （**没有就是没有**，小部件仍然自愿）；`mode === 'window'` 时取
  `manifest.window ?? defaultWindowSpec(manifest)`。
  声明出来的那一段**在函数内部再走一次 `normalizeWindowSpec`**，
  这样这个导出函数的返回形状不依赖调用方有没有先跑过 `validateManifest`
  ——同一个函数不该有两种返回形状。
  **但「合成」的那一份不归一化**：`normalizeWindowSpec` 的 `alwaysOnTop` 默认是 `true`，
  归一化会把合成规格的 `alwaysOnTop` 从 `false` 翻成 `true`，
  弄丢「没声明过 `window` 段的插件不压在别人窗口上」这条规则。
- `canDetach(manifest)` 改为恒 `true`（插件恒真）。内置功能不走这条路，
  它们在 `src/main/builtins.js` 里自己写 `canDetach: false`。

**置顶的差别**：清单里**写了** `window` 段的插件，沿用老规矩——
`normalizeWindowSpec` 没写 `alwaysOnTop` 就当 `true`（`system` 插件现在就是这样）。
**合成**出来的默认窗口用 `alwaysOnTop: false`：没声明过的插件不该一上来就
压在别人窗口上，用户想置顶可以点 📌。

`src/main/plugins/window.js`：所有读 `record.manifest.window` 的地方
（第 66、79、157、242、270 行）改读 `resolveWindowSpec(record.manifest, mode)`。

**效果**：待办、提醒、番茄钟、天气、剪贴板、系统状态——全部在面板上有 ↗。

### 5.2 插件自带页面：两处都用它

清单里的 `window.page` 现在**同时**用于两处：

| 落点 | 装法 | 容器宽度 |
| --- | --- | --- |
| 面板工作台 | `<iframe src="app://bundle/plugins/<id>/<page>">` | 面板内容宽（约 320~420） |
| 独立窗口 | `<iframe src="…">`（壳里） | 窗口内容宽（可拉伸，最大 1200） |

独立窗口的壳（`src/renderer/plugin-window/index.html`）**不再「换成插件的页面」**，
而是**壳 + iframe**：标题栏、📌 置顶、▣ 小部件、✕ 关闭是宿主的，
内容是 iframe。于是**面板工作台与独立窗口结构完全相同**，只有容器宽度不同。

没有 `window.page` 的插件走原路径：积木直接画在壳/面板里（行为不变）。

**`widget` 形态这一轮不动**：小部件继续把插件的页面**原样加载**（带 preload），
不套 iframe、不换壳。理由：小部件是另一种形态（桌面常驻的小卡片），
不是「工作台的可拉伸版本」；而且 `plugins/system/widget.js` 现在用的
`window.plugin.window.setMode('window')` 在原样加载下照常可用，
改了反而要动系统插件与它那条 e2e 断言。

**副作用**：同一个页面在 widget 形态下**有** preload（`window.plugin` 直接可用），
在 window 形态下**没有**（它在 iframe 里，只能用 `parent.plugin`）。
`bindSurface()` 把这两种都认出来（§5.4），所以插件页面不用自己分辨。

### 5.3 共享设计系统

新增 `src/renderer/ui/theme.css`：

- CSS 变量：底色 `#fffdf8`、卡片 `#f6f2e7`、描边 `#c9c1b0`、强调 `#bda87c`、
  主字 `#2b2a26`、次字 `#8a8272`、圆角 8/10/14px、字号阶梯。
- 组件：`.dp-button`（含 `.primary`）、`.dp-segmented`、`.dp-switch`、
  `.dp-list`、`.dp-field`、`.dp-footer`、`.dp-section`。
- 面板（`src/renderer/panel/index.html`）、插件壳
  （`src/renderer/plugin-window/index.html`）、积木样式
  （`src/renderer/ui/blocks.css`）统一链它 → **所有插件同一个样**。

**容器查询**：宿主给内容区套一层

```html
<div class="surface">…</div>
```

```css
.surface { container-type: inline-size; container-name: surface; }
```

插件页面用 `@container surface (min-width: 520px) { … }` 自己决定怎么排。
容器只看**宽度**，所以面板高度变化不会反过来影响布局，没有死循环。

### 5.4 插件页面开发简化

新增 `src/renderer/ui/pluginPage.js`：

```js
import { bindSurface } from '/src/renderer/ui/pluginPage.js';

const surface = bindSurface();
surface.data();                 // Promise<data>
surface.onData((d) => {});      // 首份数据
surface.onTick((d) => {});      // 周期数据
surface.act('start', { … });    // 动作
surface.action('mode:screen');  // 声明式动作（兼容旧的积木页）
surface.setStatus('正在录制');   // 面板/窗口底部那行字
surface.setHeight(h);           // 报告内容高度（**只有面板用得上**）
```

`setHeight` 只对面板有意义：面板窗口高度由内容撑开，插件页面得告诉它有多高。
独立窗口的高度是用户拖出来的，插件说了也没用——在独立窗口里 `setHeight` 是空操作。

`bindSurface()` 自动认出自己身处何处：

| 处境 | 用的通道 |
| --- | --- |
| 独立窗口的 iframe 里 | `parent.plugin`（壳的 preload 提供的 `window.plugin`） |
| 面板工作台的 iframe 里 | `parent.panel.surface` |
| 直接被顶层加载（没有壳） | `window.plugin` |

**同源假设**：iframe 与父页面同源（`app://bundle`），所以可以直接读
`parent.plugin` / `parent.panel.surface`。插件页面**不持有** preload 能力
（iframe 没有 preload），能力全在父页面上——插件页面只能调父页面已经有的接口。

### 5.5 界面路由：抽出 `plugins/surface.js`

现在「喂数据 / 转发动作 / tick 定时器」长在 `src/main/plugins/window.js` 里，
只服务独立窗口。面板要用同一套，于是抽成
**`src/main/plugins/surface.js`**：

```js
createSurfaceController({ host, getPanelWindow })
```

职责：

- `attach(pluginId, surface)` / `detach(pluginId, surface)`
  —— 一个 surface 就是一个界面落点（面板的 iframe / 独立窗口的 iframe /
  声明式积木视图）。
- 每个插件**一个** tick 定时器：第一个 surface 挂上来时起，最后一个摘掉时停。
  （现在小部件关了，定时器还在跑；这是白烧的 CPU。）
- 定时器只在该插件**确实声明了刷新间隔**时才有。合成出来的默认窗口
  `refreshMs: 0` → 不刷。
- 数据推送：宿主 → 所有挂着的 surface。

`src/main/plugins/window.js` 变成「独立窗口这个 surface 的实现」；
面板是另一个 surface 实现。

### 5.6 面板：工作台装 iframe

- 面板 preload（`src/preload/panel.cjs`）新增 `window.panel.surface`：
  `data()` / `onData()` / `onTick()` / `act()` / `action()` / `setSize(h)`。
- 面板渲染层（`src/renderer/panel/main.js`）：
  插件**有** `window.page` → 面板插件视图里放 `<iframe>`，不画积木；
  插件**没有** → 照旧画积木。
- 高度：插件页面用 `ResizeObserver` 报告内容高度 → 面板设 iframe 高度 →
  `reportHeight()` 撑开窗口。宽度不变，所以容器查询的结果不变，没有回环。
- 面板头部的标题/副标题/状态来自 `meta(ctx)`（见 §四）。

## 六、录屏插件改动

### 6.1 一个响应式页面，两处用

新增 `plugins/screen-recorder/pages/recorder.html` + `recorder.css` + `recorder.js`，
链 `/src/renderer/ui/theme.css`，用容器查询做窄宽自适应：

- 窄（面板工作台）：单列。
- 宽（独立窗口）：目标列表与声音开关并排。

取代：

- `pages/workbench.html` / `workbench.js`（旧的设置窗口，删掉）
- `lib/page.js` 里的积木页面（降级为**兜底**：小部件形态或积木路径用）

界面内容（用户已确认的稿子）：

```text
录制方式   [全屏] [选区] [窗口]        ← 分段控件
录哪一块   显示器 1 / 显示器 2 …        ← 列表，选中的打勾
声音       ☑ 录制扬声器   ☐ 录制麦克风
格式       (●) 视频  ( ) GIF
────────── 底部条 ──────────
存储到 C:\Users\Felix\Videos    00:12  [■ 停止]
```

快捷键、输出目录、视频帧率、GIF 宽度与帧率收进页面里的「设置」区
（不再单独开一个工作台窗口）。

清单改为：

```json
{
  "id": "screen-recorder",
  "name": "录屏",
  "icon": "🎥",
  "keywords": ["录屏", "屏幕", "录像", "录制", "luping", "screen", "record", "gif"],
  "entry": "main.js",
  "window": {
    "page": "pages/recorder.html",
    "title": "录屏",
    "width": 460,
    "height": 640,
    "refreshMs": 250,
    "alwaysOnTop": false
  }
}
```

`alwaysOnTop: false`：录屏的窗口不小，老压在别人窗口上会碍事——
想置顶点标题栏的 📌 就行。

### 6.2 保留的插件自建窗口

这三个是**录屏业务**，不是插件界面，插件继续自己管：

| 窗口 | 何时出现 | 说明 |
| --- | --- | --- |
| 捕获页（隐藏） | 常驻 | 见 §七.2 |
| 遮罩（全屏透明置顶） | 选区模式 | 用户拉框 |
| 控制条（小浮窗置顶可拖） | 录制期间 | 计时 + 停止 |

### 6.3 快捷键语义

原来是「**工作台**窗口开着时才生效」。现在工作台是面板里的一块区域，
面板失焦就隐藏——快捷键会跟着失效，没法用。

**新语义：录屏界面开着时生效**，即以下任一：

- 录屏的独立窗口开着；
- 面板正显示录屏（此时应用有焦点）。

设置区里写明这一点。

### 6.4 控制条

保持深色浮条（它压在别人的窗口上，深色更清楚），但按新设计系统重画：
圆角、柔和阴影、等宽数字计时器、停止按钮用暖色系的强调红。

## 七、性能改动

### 7.1 目标列表缓存

`lib/capture.js` 的 `listTargets(mode)` 每次都 `desktopCapturer.getSources()`。
改成：

- **一次取全**：`getSources({ types: ['screen','window'], thumbnailSize: {0,0} })`
  拿一次，拆成「屏幕」与「窗口」两组缓存。
- 切模式**只切缓存**，不再调系统。
- 缓存有保质期（默认 10 秒）；过期后在**后台**刷新，不挡界面。
- 页面给一个「刷新」按钮（窗口列表会变：用户开关应用）。

**连带要求**：`tick(ctx)` 必须**便宜**。录屏的清单声明了 `refreshMs: 250`
（每 250ms 推一次状态），所以 `tick` 里只能读内存里的缓存，
**不许**在里面调 `getSources()` 或读磁盘。

### 7.2 捕获窗口常驻

现在 `save()`/`fail()`/`cancel()` 都调 `windows.destroyCapture()`，
下次录制要重新建窗口、重新等页面加载（`waitReady()` 最多 15 秒）。

改成：

- 捕获窗口**建一次就用着**，录完只停轨道（`track.stop()`），不关窗口。
- 插件加载时**预热**（建好隐藏窗口、等它报「准备好了」），
  用户第一次点「开始录制」就不用等。
- 窗口留着的代价：一个隐藏的渲染进程。可以接受。

### 7.3 选区截图走二进制

`capture.js:151` 用 `source.thumbnail.toDataURL()` → base64 字符串，
2560×1440 的截图是几 MB 的 base64，跨 IPC 结构化克隆一遍。

改成传 PNG 字节（`source.thumbnail.toPNG()` → `Uint8Array`），
picker 里 `createImageBitmap(new Blob([bytes]))` 解。

### 7.4 录制字节流式写盘

现在整段录制攒在渲染进程的 `state.chunks` 里 → 拼成一个 `ArrayBuffer`
→ 整体过 IPC → 主进程 `Buffer.from(bytes)` → 写盘。两三份完整拷贝。

改成：MediaRecorder 的 `dataavailable` 每 200 ms 一块，主进程用
`fs.createWriteStream` **追加**写。渲染进程不再攒全量。

失败时删掉写了一半的文件（沿用现在的 `.part` 约定）。

### 7.5 GIF 编码

`web/gif.js` 的 `mapIndices()` 把颜色缓存建在函数内部 → **每帧重建**。
`web/gif.js:113-114` 的注释自己写着「单帧要 200ms 以上，逐帧编码直接卡死」。

改成：

- 颜色缓存**跨帧复用**（缓存挂在编码器实例上）。
- 量化 + LZW 搬进 **Web Worker**（`web/gif.worker.js`），
  主线程只负责抓帧与丢进去。
- 帧数据增量拼接，不再全部留在内存里等最后 `bytes()` 一次性分配。

### 7.6 其他

- 选区裁剪：`setInterval(draw, 1000/fps)` → `video.requestVideoFrameCallback`
  （只在真有新帧时重画）。`pages/recorder.js:84-92`。
- 控制条计时：不再每 500 ms 走一次 IPC（`capture.js:203`），
  控制条自己用 `setInterval` 走秒。

## 八、错误处理

| 情况 | 表现 |
| --- | --- |
| 插件没有 `window` 段 | **不再是错误**：宿主合成默认窗口 |
| 插件自带页面加载失败 | 独立窗口与面板都退回积木界面（能干活），并在日志留痕 |
| 目标列表拿不到 | 界面显示「拿不到可录的目标」+ 「刷新」按钮，不静默 |
| 快捷键被占用 | 设置区里明确提示注册失败 |
| 写盘失败 | 报错，并删掉写了一半的 `.part` 文件 |
| 遮罩被取消 | 回到空闲状态，什么都不发生 |
| 已在录制中又点开始 | 提示「已经在录了」 |
| 面板里 iframe 高度异常 | 面板插件视图的内容高度上限 **640px**（超出就滚动），防止面板被撑成巨无霸 |

## 九、测试

**单元**（`node --test`）：

- `defaultWindowSpec` / `resolveWindowSpec`：没写 `window` 段时合成出默认规格；
  写了就以清单为准；`widget` 段没写时**不**合成。
- 界面路由：surface 的 attach/detach 与 tick 定时器的起停。

**端到端**（Playwright）：

- 每个插件的面板里都有 ↗（含录屏）；点开确实是独立窗口。
- 录屏的面板工作台是 iframe，且与独立窗口加载的是**同一个页面**。
- 录屏的界面在窄面板与宽窗口下都能用（两种宽度各断言一次关键控件可见）。
- 切模式**不重新枚举**：计数 `getSources` 的调用次数，切换三次仍是 1 次。
- 录完再录一次，**不需要**等页面加载（第二次的「开始」明显更快 / 断言捕获窗口没重建）。
- GIF 编码器跨帧复用颜色缓存（单测：同一帧编两次，第二次耗时不涨 / 缓存命中）。

## 十、不做的事（YAGNI）

- 不做插件商店、不做在线安装。
- 不改小部件（`widget`）的语义：仍然是插件自愿、仍然是桌面常驻。
- 不给内置功能（设置、聊天记录）加 ↗：它们本来就不是插件。
- 不做录屏的暂停/继续、定时录制、画面叠加。
- 不把 GIF 编码搬到独立进程：Worker 够了。
- 不做插件页面的多语言。

## 十一、已知限制与风险

- **插件自带页面在 iframe 里跑**：拿不到 preload 能力，只能用
  `parent.plugin` / `parent.panel.surface`。这是有意的隔离，但也意味着
  插件页面不能自己开窗、不能自己读文件。
- **同源假设**：iframe 直接读父页面的全局对象。父页面与 iframe 必须同源
  （都是 `app://bundle`）。将来若插件页面来自别的源，这条要改成 postMessage。
- **捕获窗口常驻**：多一个隐藏渲染进程常驻。退出前必须拆干净
  （`destroyAll()` 已有）。
- **流式写盘**：MediaRecorder 的 mp4 首块含 `ftyp`，顺序写没问题；
  但中途失败的文件不完整——沿用现在的做法，删掉重来。
- **面板窗口不可拖动**（`resizable: false`），高度由内容撑开。
  录屏页面内容多时面板会变高——用高度上限兜住。

## 十二、实施分期

分两期落地：**第一期只动宿主**，录屏插件一行不改就已经解决「新窗口打不开」；
第二期才重写录屏的界面与性能。这样每一期都能独立验收，出问题也好定位。

### 第一期：宿主（插件界面成为宿主的能力）

| # | 改什么 | 文件 |
| --- | --- | --- |
| 1 | 默认窗口规格 + `resolveWindowSpec` + `canDetach` 恒真 | `src/shared/plugin.js` |
| 2 | 窗口控制器改读 `resolveWindowSpec` | `src/main/plugins/window.js` |
| 3 | 抽出界面路由（surface）：attach/detach + tick 定时器 | **新** `src/main/plugins/surface.js` |
| 4 | 共享主题 | **新** `src/renderer/ui/theme.css` |
| 5 | 插件页面助手 | **新** `src/renderer/ui/pluginPage.js` |
| 6 | 壳改成「壳 + iframe」；面板工作台也能装 iframe | `src/renderer/plugin-window/index.html`、`src/renderer/panel/main.js`、`src/renderer/panel/index.html` |
| 7 | 面板 preload 暴露 `panel.surface` | `src/preload/panel.cjs` |

**第一期的验收**：所有插件（含录屏）面板上都有 ↗，点开是独立窗口；
录屏在新窗口里显示的还是老的积木界面（能干活）；面板与新窗口长得一样。

### 第二期：录屏插件

| # | 改什么 | 文件 |
| --- | --- | --- |
| 1 | 目标列表缓存 + 后台刷新 | `plugins/screen-recorder/lib/capture.js` |
| 2 | 捕获窗口常驻 + 预热 | `lib/capture.js`、`lib/windows.js` |
| 3 | 选区截图走二进制 | `lib/capture.js`、`pages/picker.js` |
| 4 | 录制字节流式写盘 | `lib/capture.js`、`pages/recorder.js` |
| 5 | GIF：缓存跨帧复用 + 搬进 Worker | `web/gif.js`、**新** `web/gif.worker.js`、`pages/recorder.js` |
| 6 | 选区裁剪改 `requestVideoFrameCallback` | `pages/recorder.js` |
| 7 | 新的响应式页面，取代 workbench + 积木页 | **新** `pages/recorder.{html,css,js}`，删 `pages/workbench.*` |
| 8 | 清单加 `window.page`；`meta(ctx)`；快捷键语义 | `plugin.json`、`main.js`、`lib/page.js` |
| 9 | 控制条按新设计系统重画 | `pages/control.html` |

**第二期的验收**：录屏的界面在面板（窄）与独立窗口（宽）下都是那一套；
切模式不重新枚举；第二次录制不等页面加载；GIF 逐帧不再卡。

