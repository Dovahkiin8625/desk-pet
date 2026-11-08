# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.



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
- UI界面中不要出现代码逻辑的说明
- 注释要简洁明了，不要啰嗦 
- UI中不要出现代码逻辑的解释

## 插件

完整指南在 **`docs/开发说明/插件开发指南.md`**。几条最容易忘的：

- 插件 = `plugins/<id>/` 一个子目录，里面有 `plugin.json` 与 `main.js`。
- **目录名必须等于清单里的 `id`**，否则这个插件被静默跳过（只留一行日志）。
- 插件跑在**主进程**里，是个普通 Node 模块——**没有沙箱**，想 import 什么就 import 什么。
- 清单与窗口规格的**唯一定义**在 `src/shared/plugin.js`。宿主与插件作者对「一个插件长什么样」
  的理解必须一致，所以只有一份定义——改它要想到两边。
