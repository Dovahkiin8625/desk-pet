# 桌面宠物（Live2D）

Windows 桌面上的 Live2D 桌宠。默认形象为 Live2D 官方样例角色 Haru。

> **许可提示：** 官方样例模型（Haru / Natori）**限非商业用途**；Cubism Core 为
> Live2D 专有许可代码。`npm run setup` 会把官方样例素材下载到你的机器上，
> 分发前请先读 [NOTICE](./NOTICE)。

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

> `npm run setup` 下载的是 Live2D 官方样例素材，**限非商业用途**；
> Cubism Core（运行时从 `node_modules` 加载）是 Live2D 专有许可代码。
> 详见 [NOTICE](./NOTICE)。

> **模型二进制不在版本库里。** 仓库只提交手写的 `pet.json` 清单，
> Haru / Natori 的 `.moc3`、贴图、动作等二进制由 `npm run setup` 下载。
> 全新克隆的仓库必须先跑一次 `npm run setup`，否则桌宠窗口里没有任何模型。

## 测试

```bash
npm run test:unit   # 纯函数单测：主进程 + 渲染层（node:test）
npm run test:e2e    # 端到端测试（Playwright + Electron）
npm test            # 全部
```

`test/e2e/acceptance.spec.js` 是端到端验收用例，逐条对应设计规格 §11 的验收标准
（启动渲染、头/身不同反应、托盘与右键菜单、设置窗口）；
§11 的拖拽与「重启后记住位置」由 `test/e2e/drag.spec.js` 覆盖。

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

### 注册表条目格式

`assets/live2d/index.json` 里每个形象是一个对象：

```jsonc
{
  "models": [
    {
      "id": "haru",                    // 唯一标识；设置里存的就是它
      "name": "Haru",                  // 下拉框里显示的名字
      "manifest": "haru/pet.json",     // 清单路径（相对 models/ 目录）；缺省为 "<id>/pet.json"
      "model3": "Haru.model3.json"     // model3 文件名（相对 <id>/ 目录）；缺省为 "<id>.model3.json"
    }
  ]
}
```

只有 `id` 是必须的：`name` 缺省用 `id`，`manifest` / `model3` 缺省按上面的规则推导。
没有 `id` 的条目会被忽略并在终端里留痕。

清单缺失时应用会自动从 `model3.json` 探测能力并降级运行，因此**只放目录也能加载**。

清单格式见 `assets/live2d/models/haru/pet.json`：

```jsonc
{
  "id": "haru",                    // 与注册表里的 id 一致（以注册表为准）
  "name": "Haru",                  // 显示名
  "model3": "Haru.model3.json",    // 目录下的 model3 文件名
  "viewport": { "width": 300, "height": 560 },        // 见下方说明
  "fit": { "scale": 1.0, "anchor": [0.5, 1.0], "offset": [0, 0] },  // 适配与摆位
  "expressions": { /* 语义键 → 模型自己的表情名 */ },
  "motions": { /* 语义键 → { group, index } */ }
}
```

各字段的用法：

- `viewport`：桌宠窗口的视口尺寸。**窗口尺寸目前写死在 `src/main/window.js`（300×560）**，
  清单里的这个值只是与它保持一致的对照，改它不会改变窗口大小。
- `fit.scale`：模型在视口内的基础缩放（还会再乘设置里的用户缩放）。
- `fit.anchor`：模型锚点，`[x, y]`，默认 `[0.5, 1.0]`（水平居中、贴底）。
- `fit.offset`：摆位偏移，单位是视口宽/高的比例，`[0, 0]` 表示不偏移。

### 语义键

`pet.json` 里用的是**语义键**，不是模型自己的表情名/动作名——这样换模型时
交互逻辑不用改。清单里可用的语义键如下（`应用会触发` 一列标明应用当前真正会用到哪些）：

| 类别 | 语义键 | 应用会触发 |
| --- | --- | --- |
| 表情 | `normal` | 空闲时回到中性表情 |
| 表情 | `happy` | 摸头（命中 `Head` 区） |
| 表情 | `smile` | 点击身体（命中 `Body` 区） |
| 表情 | `shy` / `angry` / `surprised` / `sad` | 清单里可以预先映射，应用目前不会自动触发 |
| 动作 | `idle` | 空闲时播放的动作（不写 `index`，由库随机挑一个） |
| 动作 | `tapHead` | 摸头时的动作 |
| 动作 | `tapBody` | 点击身体时的动作 |
| 动作 | `drag` | 开始拖拽时的动作 |

语义键缺失时不会报错：**未映射的表情语义一律不套表情，只播对应动作**，
动作组不存在则跳过该动作。（spec §4.4 的降级表：「语义缺失 → 退化为播放对应动作；
仍缺失 → 仅播动作」。）

> Natori 的清单里 `happy` 与 `smile` 都映射到 `Smile`：
> 选 Natori 时摸头与点击身体的**表情相同**，只有动作不同。

**降级（没有 `pet.json`）时只探测能力、不猜语义**——按序号猜会让「摸头」触发生气的脸。
唯一的例外是 `normal`：降级时**按名字**匹配模型里叫 `Normal` 的表情
（Natori 有；Haru 的表情名是 `F01`…`F08`，没有）。
匹配不到就留空——空闲时只播动作、不套任何表情，
绝不按序号取「第一个可用表情」：Natori 的表情表第一项是 `Angry`，
按序号兜底会让没写清单的 Natori 永远挂着一张生气的脸。
写一份 `pet.json` 把 `normal` 指对即可。

## 已知限制

这些是开发期间实测确认的事实，不是待办事项。

- **桌宠窗口会挡住它下面的东西。** 桌宠窗口是 300×560 的**整块透明矩形**，
  而角色只占其中一部分——角色周围那片透明区域同样会吃掉鼠标点击，
  压在下面的窗口、按钮因此点不到。鼠标穿透（click-through）不在本项目范围内。
- **混合 DPI 跨显示器拖拽会有一次跳变。** 拖拽增量由 `window.screenX` 算出，
  而它是 DIP 单位；角色一旦被拖到缩放比例不同的显示器上，这段拖拽的增量
  会在两套比例之间混用，产生一次跳变，并让该次拖拽余下部分的移动速率有偏差。
  单个 100 % 缩放的显示器上行为是精确的。
- **模型加载失败后的回退目标是注册表的第一项。** 若第一项**就是**那个坏掉的形象，
  回退等于没回退：桌宠仍然是空的，直到用户删掉对应的模型目录后重跑 `npm run setup`。
  错误弹窗里写明了这一点。更聪明的做法是「依次试下一个能加载的形象」，
  但那是一次行为变更，超出当前范围。
- **`app://` 提供的是整个项目目录，不只是资源包。** 渲染层因此可以读到项目根目录下的
  文件（例如 `app://bundle/package.json`）。以 `.` 开头的路径段会被拒绝，
  目录穿越到项目根之外也会被拦下。渲染层实际只加载自己的模块和模型资源，
  没有不受信任的代码在其中运行。
- **`npm audit` 会报 2 条 critical**（另有 3 条 moderate）。critical 都来自 `gh-pages`——它是
  `pixi-live2d-display@0.4.0` 的传递依赖（那个包把发布文档的工具链错当成了运行时依赖）。
  它只在开发期使用，运行时不会被加载。**故意不修**：`npm audit fix --force` 会把
  `pixi-live2d-display` 降到 `0.3.1`，那样就不再支持 Cubism 4（`.moc3`）模型。
- **`window.__pet.setIdleMs(ms)` 是测试缝**，用来缩短空闲动画间隔以便测试；
  渲染层里任何脚本都能调用它。`window.__pet.switchModel(id)` 同理：
  它是诊断钩子，直接挂载模型，绕过持久化、主进程与形象 id 解析规则。
  正常使用请走设置窗口。

## 许可

见 [NOTICE](./NOTICE)。Cubism Core 为 Live2D 专有许可代码，官方样例模型限非商业用途。
