# 开发说明

桌宠的内部开发文档。写代码前先看这里，别去猜。

## 这里有什么

| 文档 | 给谁看 | 什么时候看 |
|---|---|---|
| [插件开发指南](./插件开发指南.md) | **插件作者** | 你要写一个新插件，或者改一个已有插件 |
| [插件系统架构](./插件系统架构.md) | **改宿主的人** | 你要动 `src/main/plugins/` 或 `src/shared/` 里的东西 |
| [Agent 能力架构](./Agent能力架构.md) | **改宿主的人** | 你要加 agent（调工具、操作本机、后台任务） |
| [添加自己的形象](./添加自己的形象.md) | **换模型的人** | 你要把 Live2D 模型放进项目里，或写 `pet.json` 清单 |

## 一页速查：写个插件

```
plugins/my-plugin/
  plugin.json
  main.js
```

**plugin.json**

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "icon": "🎯",
  "description": "一句话说明",
  "keywords": ["mine", "wode", "我的"],
  "window": { "page": "page.html", "title": "我的插件" }
}
```

- `id` 只能是小写字母、数字、连字符，**且必须等于目录名**——不等会被静默跳过。
- `window.page` 指的是插件自己的 HTML；不写就用声明式积木界面。
- 完整字段表见[指南第 2 节](./插件开发指南.md#2-清单-pluginjson)。

**main.js**

```js
export default function createMyPlugin(ctx) {
  const page = (ctx) =>
    ctx.ui.makePage({
      pluginId: 'my-plugin',
      title: '我的插件',
      blocks: [ctx.ui.textBlock('你好')],
    });

  return {
    page,                                          // 面板要显示你的时候
    action(ctx, actionId, value) {                // 用户在界面上动了
      return { ...page(ctx), status: actionId };
    },
    meta: (ctx) => ({ title: '我的插件' }),        // 只有带自己页面时才被调
    data: (ctx) => ({ ok: true }),                 // 自带页面的首份数据
    tick: (ctx) => ({ n: Date.now() }),            // 周期数据
    act: (ctx, actionId, payload) => ({ ok: true }),// 自带页面里的动作
  };
}
```

**实例 API 全表**

| 方法 | 时机 | 返回 |
|---|---|---|
| `page(ctx)` | 面板要显示插件 | `Page` / `Promise<Page>`，`null` = 关掉面板 |
| `action(ctx, actionId, value)` | 用户点了积木 | 新的 `Page` |
| `meta(ctx)` | 插件**有自己的页面**时 | `{title?, subtitle?, status?}` |
| `data(ctx)` | 自带页面打开时 | 任意数据 |
| `tick(ctx)` | 每 `refreshMs` 一次 | 任意数据 |
| `act(ctx, actionId, payload)` | 自带页面里的动作 | 任意数据 |

**ctx 里有什么**

```
ctx.plugin   {id, manifest, dir, source}
ctx.ui       makePage / textBlock / listBlock / inputBlock / buttonsBlock
             / toggleBlock / emptyBlock / messagesBlock
ctx.assistant 待办、提醒、番茄钟、天气、剪贴板、对话
ctx.host     listAll / setEnabled / isEnabled / openWindow / closeWindow
             / onSurfaceChange
ctx.update   (page) => void，异步动作完成后再刷一次面板
ctx.openSettings()
```

**积木的动作值**

| 积木 | `actionId` | `value` |
|---|---|---|
| 列表点条目 | `item.actionId \|\| item.id` | 条目 `id` |
| 列表点 ✕ | `item.removeId` | 条目 `id` |
| 输入框提交 | `block.id` | 字符串 |
| 按钮 | `item.id` | `''` |
| 开关 | `block.id` | **`'true'` / `'false'`（字符串）** |

## 一页速查：宿主在哪

```
src/shared/plugin.js       插件清单与窗口规格的【唯一契约】——改字段先改这里
src/shared/panel.js        界面积木的形状
src/main/plugins/paths.js  插件根目录（内置 + 用户）
src/main/plugins/loader.js 发现与加载
src/main/plugins/host.js   注册、ctx、生命周期
src/main/plugins/window.js BrowserWindow、壳与 iframe
src/main/plugins/surface.js 界面路由与广播
src/renderer/ui/           theme.css 设计系统 / blocks.js 积木 / pluginPage.js bindSurface
```

细节见[插件系统架构](./插件系统架构.md)。

## 规矩

- **注释与文档用中文。**
- 每个文件开头一段块注释，说明「这是什么」和**「为什么这么写」**。
- 提交信息用中文 + 约定式前缀：`feat(录屏): …` / `fix(插件): …` / `docs(插件): …` / `test(插件): …`
- 能被测到的改动，先写测试。
