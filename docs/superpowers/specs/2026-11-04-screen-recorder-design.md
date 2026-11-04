# 录屏插件（screen-recorder）设计

日期：2026-11-04
状态：已确认，待实现

## 一、要解决什么

给桌宠加一个**录屏插件**：全屏 / 选区 / 窗口三种录制方式，声音可录麦克风与扬声器
（可同时录），输出视频或 GIF，文件存放位置可配（默认「视频」文件夹）。

插件是**磁盘上的一个目录**（`plugins/screen-recorder/`），宿主照旧扫目录加载，
**宿主代码一行不改**。

## 二、已实测的技术事实

这一节的每一条都在本机（Windows 11 / Electron 45.1.0）跑过，不是查文档推的。

| 能力 | 做法 | 实测结果 |
| --- | --- | --- |
| 全屏 / 窗口采集 | `desktopCapturer.getSources()` + `session.setDisplayMediaRequestHandler()` + `getDisplayMedia()` | 2560×1440@30fps 正常 |
| 选区 | 整屏流 → canvas 裁剪 → `canvas.captureStream()` → MediaRecorder | 输出正好是选区尺寸（实测 800×450） |
| 扬声器（系统声音） | handler 里回调 `{ video, audio: 'loopback' }` | 录出的 mp4 里有 AAC 音轨（ffprobe 验证） |
| 麦克风 | `getUserMedia({ audio: true })` | **本机没有音频输入设备**，只有 3 个输出设备 → 这条路径本机无法验证 |
| 音频混流 | `AudioContext.createMediaStreamDestination()` | 可行 |
| 视频容器 | MediaRecorder | MP4(H.264+AAC) 与 WebM 都支持；mp4 已用 ffprobe 验证 |
| GIF | MediaRecorder 产不出 GIF | 需要自己写编码器 |
| 会话隔离 | `session.fromPartition('persist:screen-recorder')` | 独立分区能正常捕获 + loopback 音频，不影响 defaultSession |

**页面来源**：插件的页面用 `file://` 加载（`BrowserWindow.loadFile`）。
`file://` 在 Chromium 里是 secure context，`navigator.mediaDevices` 可用（已验证）。
不能用 ES module 的 `import`——`file://` 下的模块脚本会被 CORS 拦掉，
所以插件页面里的脚本一律是**经典脚本**（`<script src>`，挂到 `window` 上）。

## 三、用户拍板的决定

| 决定 | 选择 | 备注 |
| --- | --- | --- |
| 控制界面 | 面板 + 悬浮控制条 + 快捷键 | 设置按钮放在插件界面里 |
| 选区取景 | 全屏遮罩拉框（所见即所得） | 不是预览窗口按比例换算 |
| 声音 | 麦克风与扬声器可同时录 | 自动混音成一个音轨 |
| 快捷键 | 需要，可配置 | **工作台窗口开着时才生效** |
| 快捷键生效时机 | 工作台窗口开着时注册，窗口关掉就注销 | 不常驻抢键 |

## 四、模块与文件

```
plugins/screen-recorder/
  plugin.json          清单：id=screen-recorder，名字「录屏」，关键词
  main.js              插件入口（主进程）：面板页面、动作分发
  config.js            配置读写（原子写 JSON）
  capture.js           录制会话：起停、状态、文件落盘
  windows.js           插件自建的四个窗口
  gif.js               GIF 编码器（经典脚本，给捕获页用）
  pages/
    workbench.html/js  工作台：快捷键、输出目录、帧率、录制状态
    control.html/js    悬浮控制条：计时 + 停止
    picker.html/js     全屏遮罩：拖框选区
    recorder.html/js   隐藏捕获页：真正干活的
  preload/
    rec.cjs            这些页面的桥：只暴露几个 IPC 通道
```

插件跑在主进程里，`import { BrowserWindow, desktopCapturer, app, globalShortcut } from 'electron'`
直接可用——插件系统本来就没有沙箱（见 README「插件能拿到什么」）。

**四个窗口**：

| 窗口 | 何时出现 | 干什么 |
| --- | --- | --- |
| 捕获页（隐藏） | 录制期间 | 取流、编码、落盘前的字节收集 |
| 遮罩（全屏透明置顶） | 选区模式 | 整屏截图变暗，拖框 |
| 控制条（小浮窗置顶可拖） | 录制期间 | 计时 + 停止 |
| 工作台（普通小窗） | 用户点「设置」 | 设置与快捷键 |

工作台与控制条**要能同时开着**。所以没用宿主现成的 widget 机制——
宿主一个插件只有一个窗口、window 与 widget 两种形态互斥（见 `src/main/plugins/window.js`
的 `switchMode`：切形态是销毁重建）。代价是自己实现拖拽、置顶与透明（约 150 行）。

## 五、录制管线

```text
面板页 / 工作台
   │  action（宿主的面板动作机制）
   ▼
capture.js
   ├ 选目标：全屏/选区 → 显示器列表；窗口 → 窗口列表（打开面板时抓一次）
   ├ 选区模式：先开遮罩 → 用户拖框 → 遮罩关闭 → 拿到矩形 → 才开始录
   ├ 建隐藏捕获窗（session 分区 screen-recorder）
   └ 捕获页 recorder.html：
        视频轨 ← getDisplayMedia（主进程 handler 按选好的源回调）
        系统音 ← handler 里 audio: 'loopback'
        麦克风 ← getUserMedia({ audio: true })
        混音   ← AudioContext.createMediaStreamDestination()
        选区   ← canvas 裁剪 → canvas.captureStream(fps)
        视频   ← MediaRecorder('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
        GIF    ← canvas 逐帧 → 量化 → LZW → 累积字节（无音频）
   │
停止 → 字节经 IPC 回主进程 → 写盘 → 控制条消失 → 面板显示「已保存：路径」
```

### 视频与 GIF 是两条不同的路

- **视频**：MediaRecorder 直接吃流。选区时先把整屏流画进 canvas 裁剪，再
  `canvas.captureStream()`。音频轨与视频轨合成一个 MediaStream 交给 MediaRecorder。
- **GIF**：MediaRecorder 产不出 GIF，所以完全绕开它——canvas 逐帧取 ImageData，
  量化 + LZW，累积成字节流。**GIF 没有音频**（格式本身不支持），界面上要写明。

### 混音

```js
const ac = new AudioContext();
const dest = ac.createMediaStreamDestination();
if (speakerTrack) ac.createMediaStreamSource(new MediaStream([speakerTrack])).connect(dest);
if (micTrack) ac.createMediaStreamSource(micTrack).connect(dest);
const out = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);
```

## 六、三个容易翻车的点

### 1. DPI 坐标换算

遮罩窗口按 **DIP** 摆放（`screen.getAllDisplays()` 的 bounds），背景是**物理像素**的
整屏截图，捕获轨又有自己的 `videoWidth/videoHeight`。用户在遮罩上拖出的矩形要经过
两级换算才能变成 canvas 的裁剪矩形：

```text
遮罩上的 CSS 坐标 → 截图的物理像素坐标 → 捕获轨的像素坐标
```

Windows 缩放不是 100% 时漏掉这步，录出来就是歪的。这段换算是**纯函数**，
单独放一个模块，单元测试直接喂它各种缩放比（DIP↔物理↔轨道尺寸）。

### 2. 会话隔离

`session.setDisplayMediaRequestHandler` 是**按 session** 设的，默认挂在 defaultSession 上，
会连桌宠本体一起影响。所以捕获窗用 `session.fromPartition('persist:screen-recorder')`，
handler 只装在这个分区上（已实测隔离分区能正常捕获）。

**清单里不写 `window` / `widget` 段**：宿主那套「一个插件一个窗口、两种形态互斥」
的机制用不上（工作台与控制条要同时开着），写了反而让面板多出两个用不上的按钮。
面板里的「设置」按钮开的是插件**自建**的工作台窗口。

### 3. GIF 编码器自己写

纯 JS，不引新依赖：`GIF89a` 头 + 逻辑屏幕描述 + Netscape 循环扩展 + 每帧
图形控制扩展 + 图像描述 + LZW 数据 + 结尾 `0x3B`。

- 量化用 median cut，每帧一张独立调色板（GIF 允许局部颜色表）。
- 像素映射**必须带颜色缓存**（RGB565 → 索引的 Map）：否则每帧 23 万像素 ×
  256 色线性查找，单帧要 200ms 以上，逐帧编码直接卡死。
- 默认宽 480（保持比例）、12fps。

## 七、配置

存 `userData/screen-recorder.json`（原子写：先写临时文件再 rename）。

```json
{
  "mode": "screen",
  "format": "video",
  "mic": false,
  "speaker": true,
  "outputDir": "C:\\Users\\Felix\\Videos",
  "hotkey": "Control+Shift+R",
  "fps": 30,
  "gifWidth": 480,
  "gifFps": 12
}
```

- `outputDir` 默认 `app.getPath('videos')`——Windows 里显示为「视频」。
- 文件名 `录屏_YYYYMMDD_HHMMSS.mp4` / `.gif`；重名自动加 `_2`。

## 八、快捷键

- 默认 `Control+Shift+R`，在**工作台窗口开着时**注册，窗口一关就注销。
- 工作台里能重新录制别的组合（页面里捕获按键 → 发给主进程 → 主进程校验并注册）。
- `globalShortcut.register` 失败（被别的程序占用）要明确提示，别静默。

## 九、面板页面长什么样

声明式积木（`makePage` / `buttonsBlock` / `listBlock` / `toggleBlock` / `inputBlock`）：

```text
录屏
状态：正在录制 00:12（或：已保存到 …\录屏_20261104_231530.mp4）
[全屏] [选区] [窗口]          ← 当前模式标出来
目标：显示器 1 / 显示器 2 …    ← listBlock，随模式变
[✓] 录制麦克风
[✓] 录制扬声器
格式：视频 / GIF
输出目录：[C:\Users\Felix\Videos] [浏览…]
[开始录制]  [设置…]
```

## 十、错误处理

| 情况 | 表现 |
| --- | --- |
| 没有麦克风 / 没给权限 | 明确文案（「没有找到麦克风」/「没有拿到麦克风权限」），不静默 |
| 目标窗口录制途中被关 | track ended → 自动停止，保存已有内容并提示 |
| 输出目录不存在 | 自动创建 |
| 写盘失败 | 报错，并删掉写了一半的文件 |
| 遮罩被取消 | 回到空闲状态，什么都不发生 |
| 快捷键被占用 | 工作台里提示注册失败 |
| 已在录制中又点开始 | 提示「已经在录了」 |

## 十一、测试

**单元**（`node --test`，不碰 Electron）：
- GIF 编码器：给定已知像素 → 校验 GIF 结构（`GIF89a` 头、帧数、结尾 `0x3B`）、LZW 编解码往返
- DPI 坐标换算：各种缩放比（100% / 150% / 200%）
- 配置读写、文件命名与重名处理

**端到端**（Playwright，本机有屏幕，能跑）：
- 面板里能搜到「录屏」并打开
- 切模式 / 开关声音 / 改输出目录，状态正确
- 走一次真实录制：全屏 → 录 2 秒 → 停 → 产出 mp4 且文件头合法（`ftyp` box）

## 十二、不做的事（YAGNI）

- 暂停 / 继续录制
- 录制中切模式或切窗口
- 定时录制
- 视频里叠加时间戳/摄像头小窗
- 录制历史列表（面板只显示最近一次结果）

## 十三、已知限制

- **本机没有音频输入设备**，麦克风这条路径没法在这里端到端验证（只能验证
  「没有设备时的提示」）。代码按「设备可能不存在」写。
- 系统声音（loopback）**只有 Windows 支持**（Electron 的限制）。别的平台上
  「扬声器」这一项要置灰并说明原因。
- 选区遮罩覆盖的是**一个显示器**（用户选定的那个），不是所有屏幕。
