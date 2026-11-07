# 桌面宠物（desk-pet）

Electron 桌面宠物。Live2D 形象 + 一套可插拔的插件系统。

## 跑起来

```bash
npm start            # 起应用
npm run test:unit    # node --test，秒级
npm run test:e2e     # playwright，要起真的 Electron，慢
npm test             # 两个都跑
```

E2E 用临时 userData（`DESK_PET_USER_DATA`、`DESK_PET_E2E=1`），不会碰你真实的配置。
但它**会真的开窗口**——别在别人开会时跑。

## 目录地图

```
src/main/            主进程
  plugins/           插件宿主
    plugin.js 契约 → loader.js 发现 → host.js 注册与生命周期 → window.js 窗口 → surface.js 界面路由
  panel.js           插件面板的主进程侧
src/preload/         渲染层的桥
  plugin.cjs         插件窗口专用（window.plugin）
  panel.cjs          面板专用（window.panel）
src/renderer/        界面
  panel/             插件面板：搜索视图 + 插件工作台
  plugin-window/     独立窗口的「壳」（壳里再装插件自己的页面）
  ui/                theme.css 设计系统、blocks.js 积木渲染、pluginPage.js 插件页面助手
src/shared/          主进程与渲染层共用的契约（定义只有一份，两边都从这里取）
  plugin.js          插件清单与窗口规格
  panel.js           界面积木
plugins/             内置插件，一个插件一个子目录
test/unit/           node --test
test/e2e/            playwright
docs/开发说明/        插件系统文档
  插件开发指南.md   写插件的人看这份
  插件系统架构.md   改宿主的人看这份
```

## 写代码的约定

- **注释与文档用中文。**
- 每个文件开头一段块注释，说明「这是什么」和**「为什么这么写」**。反直觉的设计尤其要写——
  写清楚不这么写会怎样，下一个改这里的人就不会把它「修」回去。
- 提交信息用中文 + 约定式前缀：`feat(录屏): …` / `fix(插件): …` / `docs(插件): …` / `test(插件): …`
- 能被测到的改动，先写测试。

## 插件

完整指南在 **`docs/开发说明/插件开发指南.md`**。几条最容易忘的：

- 插件 = `plugins/<id>/` 一个子目录，里面有 `plugin.json` 与 `main.js`。
- **目录名必须等于清单里的 `id`**，否则这个插件被静默跳过（只留一行日志）。
- 插件跑在**主进程**里，是个普通 Node 模块——**没有沙箱**，想 import 什么就 import 什么。
- 清单与窗口规格的**唯一定义**在 `src/shared/plugin.js`。宿主与插件作者对「一个插件长什么样」
  的理解必须一致，所以只有一份定义——改它要想到两边。

## 容易踩的坑

- **Edit 的 `file_path` 必须是绝对路径。** 漏了会报 `InputValidationError`。
- **`win.webContents.id` 要在窗口销毁前存下来。** 窗口关掉之后再读 `win.webContents.id`
  会把主进程整个冻住（表现为「点了退出，程序却不退」）。见 `src/main/plugins/window.js`。
- 插件自带页面在**独立窗口**里走「壳 + iframe」（用 `bindSurface()`）；
  在**小部件**里是原样加载、用裸 `window.plugin`。**两套 API 不一样。**
- 清单里写了 `page` 但文件不在磁盘上 → 宿主自动退回积木界面，不会白屏。
- `toggle` 积木回传的动作值是**字符串** `'true'` / `'false'`，不是布尔。

## 读文档要挑着读

`docs/开发说明/` 下是插件系统的两份文档。**先看那份短的**：
要写插件就看《插件开发指南》，要改宿主就看《插件系统架构》。

早先的实施计划与设计文档（`docs/superpowers/plans/`、`docs/superpowers/specs/`）已经删掉了，
需要时从 git 历史里翻——它们**很长**（录屏那份 3500+ 行、117KB，
整读一次 ≈ 34k tokens），按行号读你需要的那一段 Task，不要整份读进上下文。
