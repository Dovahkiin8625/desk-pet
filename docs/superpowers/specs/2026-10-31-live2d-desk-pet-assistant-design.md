# Live2D 桌面宠物 第二、三部分 — 交互与动作系统 / 桌面助理 — 设计规格

> 本文档是 `2026-10-29-live2d-desk-pet-mvp-design.md`（下称「MVP 规格」）的续篇。
> MVP 规格 §1 把「语音/Lip Sync、天气、待办」明确列为范围外，
> 本文覆盖的正是 `idea.md` 的**第二部分（交互与动作系统）**与
> **第三部分（桌面助理功能）**。
>
> 编号沿用 MVP 规格的章节风格，但**自成体系**：MVP 规格的 §4.3/§4.4/§5.x 约束
> 在本文中继续有效，且本文不修改它们（除了 §4.3 增加一个语义键）。
>
> ⚠️ **2026-11-01 更新**：本文 §6.1 写的「功能入口在桌宠右键菜单的『小工具』子菜单里」
> 已经被**第四部分**推翻——那条路换成了**插件面板**
> （左键点桌宠 → 搜索框 → 模糊搜索 → 回车打开插件界面）。
> 见 `2026-11-01-live2d-desk-pet-plugin-panel-design.md` 与
> `docs/decisions.md` #52。文中与它冲突的句子已就地标注。
>
> ⚠️ **2026-11-02 更新**：§6.6 的「快捷启动」不再是**插件**，而是
> **插件面板搜索框里的程序搜索**（扫开始菜单、PATH 与程序目录，回车启动，
> 见 `src/main/apps.js` 与 decisions.md #78~#85）；
> §8 状态文件里的 `launcher` 字段随之删除。

## 1. 目标与范围

### 1.1 要补的缺口

MVP 做完之后，`idea.md` 第二、三部分里**真正没做**的是：

| idea.md 条目 | MVP 状态 |
| --- | --- |
| 动作触发（点击头/身体） | 已有 |
| 表情切换（开心/害羞/困倦…） | 语义键在清单里，但**应用从不触发** shy/angry/surprised/sad |
| 视线跟随 | 已有，但只在指针**经过桌宠窗口**时生效 |
| 物理效果 | 已有（Live2D 自带） |
| 拖拽反馈 | 只播 `drag` 动作，无表情、无「悬空」感 |
| 随机待机动作 | 已有 |
| 语音口型同步 / 触摸反馈音效 | 未做 |
| 时间日期播报 / 提醒闹钟 / 番茄钟 / 待办 / 天气 / 系统状态 / 剪贴板 / 快捷启动 / 文件拖放 | 未做 |

### 1.2 范围外

- `idea.md` 第四部分（AI 对话）、第五部分（养成系统）、第六部分（系统与工程化）。
- 任何联网的**翻译/总结**能力：文件拖放与剪贴板只做「提示」，不做内容加工。
- 电量百分比：Electron 45 的 `powerMonitor` 没有这个 API（见 §6.3）。

## 2. 总体架构

```
主进程 (src/main/)
├── assistant/        助理总控 + 纯函数状态机 + 外部服务
├── bubble.js         说话气泡（独立窗口）
├── credentials.js    API Key 存取
└── protocol.js       拒绝清单（挡住密钥）
渲染层 (src/renderer/)
├── pet/emotion.js    情绪系统
├── pet/lipSync.js    口型驱动
├── pet/audio.js      提示音 + 语音播放
└── bubble/           气泡页面
```

**主进程是唯一的时间与状态来源。** 定时器、剪贴板、屏幕 API 都在那边；
渲染层只负责「表演」（表情、动作、口型、视线）。
这样桌宠窗口被隐藏时，提醒照样会响。

### 2.1 关键决策

| 决策 | 理由 |
| --- | --- |
| ⚠️ 小工具的入口在**桌宠右键菜单**里，不做工具面板窗口 | 用户拍板（2026-11-01 已被第四部分推翻：换成了插件面板） |
| 工具的**结果显示在气泡**里 | 桌宠窗口 300×560 被角色占满，画不进去 |
| 气泡是**独立窗口** | 同上：盖住角色的脸是最糟的结果 |
| 气泡**懒创建** | E2E 的 `app.firstWindow()` 认「第一个窗口」，气泡若先于桌宠出现，整个套件超时 |
| 剪贴板内容**绝不落盘** | 剪贴板里可能有密码管理器复制出来的密码 |
| 天气与剪贴板助手**默认关闭** | 前者要联网，后者要读用户的剪贴板 |

## 3. 情绪系统（第二部分）

### 3.1 心情值与语义情绪

心情值 `-100..100` → 语义情绪 → 清单里的表情名。

> 情绪**标签**（`neutral`/`happy`/`tired`…）与清单里的**语义键**
> （`normal`/`happy`/`tired`…）不是一回事：`neutral` 是「中性的状态」，
> `normal` 是模型自己的表情名映射。两者由 `EMOTION_EXPRESSION` 翻译。

| 情绪 | 语义键 | 触发来源 |
| --- | --- | --- |
| neutral | `normal` | 默认 |
| happy | `happy` | 摸头、待办完成、提醒送达 |
| shy | `shy` | 被夸奖、说话 |
| surprised | `surprised` | 被拖拽、提醒突然弹出 |
| sad | `sad` | 长时间没人理、系统过热 |
| angry | `angry` | 2 秒内被连续点 3 次以上 |
| tired | `tired` | 3 分钟没有任何互动 |

心情随时间自然回落（每分钟 6 点，只朝 0 回落）。

### 3.2 与既有行为的关系

情绪系统**叠加**在 MVP 规格 §5.1 的交互反应之上，**不替换**它：

- 摸头仍然是「表情 `happy` + 动作 `tapHead`」（MVP §5.1）；
- 点击身体仍然是「表情 `smile` + 动作 `tapBody`」；
- 点击**只改心情值**，不换表情——否则会覆盖 §5.1 指定的表情。

事件表里 `express` 标志决定「现在是否换表情」。
只有没有区域反应的事件（拖拽、超时、助理事件）才由情绪系统接管表情。

### 3.3 降级规则不变

语义键一律走清单解析。**未映射的语义键不套表情**（沿用 MVP §4.4）：
`resolveExpressionName` 返回 null 时只播动作。
`deriveManifest` / `mergeManifest` **不自动补 `tired`**
（那里只按名字补 `normal`，见 MVP §4.6）。

### 3.4 新语义键 `tired`

Haru 的 `F04` 是唯一没被用到的表情。`F04.exp3.json` 的参数是
`ParamEyeLOpen/ROpen=0.8`（半闭眼）、`ParamEyeForm=1`（眼型下垂）、
`ParamMouthForm=-1.76`（嘴角平）、`ParamBrowLY/RY=-0.56`、`ParamBrowLForm/RForm=-0.74`。

**目视确认**（渲染截图比对）：F01 是睁眼平嘴的普通脸，F02 是瞪眼怒容，
F03 是垂眉低头，F04 是**半闭下垂的眼 + 平嘴**——三者明显不同，
F04 的观感是「慵懒/困倦」。因此 `tired → F04`。

> 这是**按参数值推断并目视确认**，不是按序号猜（MVP §4.4 禁止的是后者）。
> Natori 没有可对应的表情（它的 `exp_01`..`exp_05` 全是口型变体），
> **Natori 不映射 `tired`** → 降级为只播动作。

## 4. 视线跟随（升级）

MVP 的视线跟随只由渲染层的 `pointermove` 驱动——指针不在桌宠身上时，
桌宠就「眼神空洞」地看着正前方。

改为：主进程以 10Hz 轮询 `screen.getCursorScreenPoint()`，
把**窗口内坐标**发给渲染层；渲染层在光标**不在画布内**时调 `model.focus`。

- **换算在主进程做**：`cursor - win.getPosition()`。
  `getCursorScreenPoint()` 与 `getPosition()` 都是 DIP，同一套坐标系；
  渲染层的 `window.screenX` 是 Chromium 的另一套 DIP，两套是否等价从未被验证过
  （拖拽路径是刻意只传增量的，见 `docs/decisions.md`）。
- 光标在画布内时**不**驱动视线：那正是 `pointermove` 在管的事，
  两边同时驱动会让视线在两个目标之间来回跳。
- `FocusController` 自己会做平滑，10Hz 足够。

## 5. 气泡窗口

### 5.1 三条硬约束

1. **懒创建**：第一次有消息时才建窗口。
2. **就绪握手**：气泡页回 `pet:bubbleReady`，在那之前的消息排队等着。
   `webContents.send` 对尚未注册监听器的页面是**丢弃**而不是排队。
3. **点击穿透**：默认 `setIgnoreMouseEvents(true, { forward: true })`。

### 5.2 三种形态

> ⚠️ **已被第四部分修订**（2026-11-01）：气泡现在**只有 `say` 一种形态**。
> `list` 与 `prompt` 两种形态随「小工具」菜单一起下线了——
> 清单与输入都搬进了插件面板（见 `2026-11-01-live2d-desk-pet-plugin-panel-design.md`）。
> 气泡因此**永远**是点击穿透的。

| 形态 | 用途 | 可交互 | 存活 |
| --- | --- | --- | --- |
| `say` | 一句话 | 否 | 6 秒 |
| ~~`list`~~ | ~~清单（待办、系统状态）~~ | 否 | 6 秒 |
| ~~`prompt`~~ | ~~输入框（加待办、设城市、说句话）~~ | 是 | 120 秒 |

原生菜单没有输入框，所以「添加待办…」这类动作只能走 `prompt`。

### 5.3 位置

优先头顶 → 脚下 → 左侧 → 右侧，取第一个**完整落在工作区内**的位置。
桌宠通常站在屏幕右下角，那里恰恰是头顶与脚下都放不下的。

### 5.4 层级

气泡用 `setAlwaysOnTop(true, 'screen-saver')`：桌宠用的是普通 `alwaysOnTop`
（`'floating'` 级），两个同级置顶窗口的相对顺序是未定义的——气泡会被桌宠盖住。

### 5.5 后台节流

气泡窗口必须 `backgroundThrottling: false`。
隐藏的窗口会被 Chromium **冻结**，气泡自动消失后渲染进程就冻住了，
下一条消息要等它「醒过来」才画得出来，表现得像气泡失灵。

## 6. 桌面助理（第三部分）

### 6.1 功能与入口

> ⚠️ **已被第四部分推翻**（2026-11-01）：这 8 个功能现在是**插件**，
> 入口是**插件面板**（左键点桌宠 → 搜索 → 打开插件界面），
> 不再是右键菜单的子菜单。下面的描述保留了当时的设计，
> 现状见 `2026-11-01-live2d-desk-pet-plugin-panel-design.md`。

全部在桌宠右键菜单的「小工具」子菜单里：

```
说句话… / 番茄钟 / 待办 / 提醒 / 天气 / 系统状态 / 剪贴板 / 快捷启动
```

菜单**每次弹出时重建** → 待办与提醒列表永远是当下的。
托盘菜单**保持三项不变**（托盘菜单只在启动时构建一次，列表会永远是旧的）。

### 6.2 时间表达

提醒支持三种写法：

- 相对时长：`30分钟后`、`2小时`、`1小时30分钟`、`45m`
- 绝对时刻：`14:30`
- 绝对时刻 + 明天：`明天 9:00`

解析不出时刻时**明确告诉用户**（而不是默默按默认时间提醒）。

### 6.3 系统状态

| 指标 | 来源 | 备注 |
| --- | --- | --- |
| CPU | `os.cpus()` 的累计 tick 差值 | Windows 上 `os.loadavg()` 恒为 [0,0,0]，不可用 |
| 内存 | `os.totalmem()` / `os.freemem()` | |
| 热状态 | `powerMonitor.getCurrentThermalState()` | `nominal`/`fair`/`serious`/`critical` |
| 电源 | `powerMonitor.isOnBatteryPower()` | |

**没有电量百分比**：Electron 45 的 `powerMonitor` 没有 `getSystemPowerState()`。
热状态正好对应 idea.md 举的例子「我好热」。

### 6.4 剪贴板

- 默认关闭；开启后每 2 秒轮询 `clipboard.readText()`。
- **Electron 45 的 `clipboard.readText()` 是异步的**（返回 `Promise<string>`，
  与 W3C 的 `navigator.clipboard` 一致）。把它当同步用会拿到 `undefined`，
  于是「读到的永远是 undefined」，助手永远不会报告任何内容。
- 内容**只在内存里**，绝不落盘。
- 启动时先记下当前内容作基准：否则应用一启动就会把用户之前复制的东西报一遍。

### 6.5 天气

open-meteo（免密钥）：地理编码 → 当前天气 → WMO 码映射成中文。
默认关闭；填好城市名并开启后才联网。断网时安静降级为「天气暂时查不到」。

### 6.6 快捷启动

`shell.openPath` 打开文件/目录（**它不抛异常**，失败时 resolve 一个错误字符串，
忽略返回值的话「路径不存在」会变成一次毫无动静的失败）；
`spawn` 启动 exe（detached）。浏览器没有可靠路径，走 URL 协议交给系统默认浏览器。

> ⚠️ **2026-11-02**：这一节整个换掉了。「快捷启动」不再是插件，也不再有手动维护的清单——
> 现在的做法是**扫**出本机的程序（开始菜单、PATH、程序目录），
> 在插件面板的搜索框里与插件混排，回车启动。见 `src/main/apps.js`。

### 6.7 文件拖放

渲染层 `dragover`（**必须** `preventDefault`）+ `drop`；
路径用 `webUtils.getPathForFile(file)` 取——**Electron 32 起 `File.path` 已被移除**，
而 `webUtils` 只能在 preload 里调。

只报文件名与大小：**路径不落盘、不外传**。

## 7. 语音播报与口型同步

### 7.1 MiniMax TTS

```
POST {host}/v1/t2a_v2
Authorization: Bearer <API_KEY>
{ model, text, stream:false, voice_setting:{voice_id,speed,vol,pitch},
  language_boost, audio_setting:{sample_rate,bitrate,format,channel}, output_format:"hex" }
```

三个坑：

1. **HTTP 200 ≠ 成功**：状态码在 `base_resp.status_code` 里。
   `1004` = 鉴权失败，`2054` = 音色 id 不存在。
2. **音频是 hex 字符串**：`data.audio` 要 `Buffer.from(hex,'hex')` 才是 MP3 字节。
   直接当 base64 解会得到垃圾。
3. **域名要探测**：`minimaxi` = 中国大陆、`minimax` = 国际。
   实测 `https://api.minimaxi.com` 可用，**只需要 Bearer、不需要 GroupId**。

错误分类决定要不要换域名再试：

| 错误 | 换域名？ |
| --- | --- |
| 网络错误 / HTTP 错误 | 换（这个域名不通） |
| `1004` 鉴权失败 | 换（key 是分区域的） |
| 其它 `base_resp` 错误（如 `2054`） | **不换**（接口已答复，换了也一样） |

### 7.2 API Key 的存放

| 位置 | 用途 |
| --- | --- |
| `userData/credentials.json` | 正本（设置窗口里填的） |
| 环境变量 `MINIMAX_API_KEY` | 覆盖 |
| 项目根目录 `minimax-api-key` | 开发期引导来源 |

**key 永远不进渲染层**：不写进 `settings.json`、不随 `pet:settingsChanged` 广播，
设置窗口只能读到 `****abcd` 这样的掩码。

根目录那个文件必须被 `.gitignore` 排除，也必须被 `app://` 的拒绝清单挡住——
`app://` 服务的是整个项目目录（README 已记为已知限制），
渲染层一句 `fetch('/minimax-api-key')` 就能把密钥读走。

### 7.3 口型怎么驱动

`pixi-live2d-display` 每帧的顺序是：

```
动作 → saveParameters → 表情 → 眨眼 → 视线 → 呼吸 → 物理 → 姿势
→ emit('beforeModelUpdate') → model.update()（core 的 UpdateParameters+SaveParameters）
→ loadParameters
```

值必须写进 core 的参数数组才能活到画出来的那一帧，
而 `model.update()` 才是「core → 渲染用 model」的最终拷贝点。
库在它之前 emit 了 `beforeModelUpdate`——**那正是「画之前最后一句话」**。

所以：监听 `internalModel.on('beforeModelUpdate')`，在里面写口型参数。

**不能**去打补丁 `saveParameters`：

- 它在表情**之前**，而 Haru 的表情文件本身就会写 `ParamMouthOpenY`
  （`F02`/`F03.exp3.json`），表情会把口型盖掉；
- 它是帧末 `loadParameters()` 用来恢复基准的那份快照，
  在它之前写值会让下一帧的动作混合对着你上帧的口型插值——嘴会卡在张开。

参数名不写死：从 `internalModel.settings.getLipSyncParameters()` 取
（Haru 返回 `['ParamMouthOpenY']`）。模型没有这个参数时整个功能静默关闭。

幅度来自音频：渲染层 `decodeAudioData` 解出音频 → 算 20ms 一帧的 RMS 包络 →
按播放时间查表驱动。

## 8. 数据格式

### 8.1 `assistant.json`

```jsonc
{
  "version": 1,
  "todos": [{ "id": "t-…", "text": "买菜", "done": false, "createdAt": 1730000000000 }],
  "reminders": [{ "id": "r-…", "text": "喝水", "at": 1730000000000, "fired": false }],
  "pomodoro": { "phase": "idle", "endsAt": null, "remainingMs": 1500000, "durationMs": 1500000 },
  "weather": { "enabled": false, "city": "", "last": null },
  "clipboard": { "enabled": false },
  "chime": { "enabled": true },
  "greeting": { "enabled": true },
  "sound": { "enabled": true },
  "hotAlert": { "enabled": true },
  "tts": { "enabled": false, "voiceId": "female-shaonv", "model": "speech-02-hd", "speed": 1, "host": "" }
}
```

> ⚠️ **2026-11-02**：`launcher` 字段已删除（快捷启动不再有手动维护的清单）。

原子写（写临时文件 → `rename`），与 `settings.json` 共用一份实现。

**退出的 flush 链必须一起带上它**：待办/提醒也是防抖写的，
只 flush settings 的话，用户在 300ms 内退出就会丢掉刚加的待办——
这正是仓库已经为 settings 修过一次的那类 bug。

### 8.2 `credentials.json`

```jsonc
{ "minimaxApiKey": "sk-cp-…" }
```

只存 API Key，不随任何广播下发。

## 9. 目录结构（新增部分）

```
src/main/assistant/index.js          助理总控
src/main/assistant/state.js          assistant.json 的 schema 与读写
src/main/assistant/clock.js          报时与问候语
src/main/assistant/todos.js          待办
src/main/assistant/reminders.js      提醒（含时间解析）
src/main/assistant/pomodoro.js       番茄钟
src/main/assistant/clipboard.js      剪贴板监听
src/main/assistant/systemStatus.js   CPU/内存/热状态/电源
src/main/assistant/weather.js        open-meteo
src/main/assistant/tts/minimax.js    MiniMax 客户端
src/main/assistant/tts/voices.js     音色建议表
src/main/bubble.js                   气泡窗口
src/main/credentials.js              API Key
src/main/store.js                    原子写（settings 与 assistant 共用）
src/preload/bubble.cjs               气泡专用 preload
src/renderer/bubble/{index.html,main.js}
src/renderer/pet/{emotion,lipSync,audio}.js
src/shared/assistant.js              消息形状与共享常量
```

## 10. 测试策略

| 层 | 覆盖 |
| --- | --- |
| 单元 | 情绪状态机、待办/提醒/番茄钟/报时的纯函数、助理状态规整、MiniMax 客户端（stub fetch）、天气（WMO 映射）、`app://` 拒绝清单、菜单模板 |
| 端到端 | 气泡的懒创建/穿透/位置、待办增删与落盘、剪贴板助手、到点的提醒、番茄钟、语音全链路（**本地桩服务**，不打真实接口）、设置界面的小工具与语音配置 |

端到端里 TTS 走本地桩服务：把 `DESK_PET_TTS_HOSTS` 指向 `127.0.0.1`。
真实接口只在人工验证时用一次。

## 11. 验收标准

> ⚠️ 第 1、2、5 条的入口已被第四部分改写（2026-11-01）：
> 「小工具」菜单换成了**插件面板**，气泡的输入框形态下线了。
> 下面就地标注了新的对应形态；现状见
> `2026-11-01-live2d-desk-pet-plugin-panel-design.md` 的 §8。

1. ~~右键桌宠 → 「小工具」里每一项都能打开~~ → **左键点桌宠 → 插件面板 →
   搜索到每一项都能打开**，面板出现在桌宠旁边且**不挡住角色**。
2. ~~气泡的输入框能真的收字~~ → **插件界面的输入框能真的收字**
   （打开待办插件 → 输入 → 回车 → 待办出现在插件界面与 assistant.json 里）。
3. 待办、提醒、番茄钟的状态在**退出后仍然保留**（assistant.json）。
4. 拖文件到桌宠上 → 气泡报出文件名与大小。
5. 配好 API Key → **说句话插件**里输入一句 → 有声音 + 嘴在动。
   > ⚠️ 2026-11-02：「说句话插件」已退役，**聊天**取而代之——
   > 在插件面板的输入框里说一句话，回复会念出来（嘴同样在动）。
6. 整点时气泡报时；剪贴板助手开启后复制文字 → 气泡提示。
7. 渲染层里 `fetch('/minimax-api-key')` 必须是 403。
8. `npm test` 全通过。
