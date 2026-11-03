/**
 * 角色右键菜单 / 托盘菜单的模板。返回普通数组，便于单测。
 *
 * 两套菜单现在**是同一套**：只有「显示/隐藏 · 设置 · 退出」三项。
 *
 * 以前右键菜单里还有一个「小工具」子菜单（待办、提醒、番茄钟……），
 * 那条路换成了**插件面板**（见 src/main/panel.js）：
 * 左键点桌宠 → 弹出搜索框 → 模糊搜索 → 回车打开插件界面。
 * 菜单放不下搜索框，也塞不下清单——插件面板才装得下。
 */

/** 基础菜单：显示/隐藏 · 设置 · 退出。托盘与右键都用它。 */
export function menuTemplate(actions) {
  return [
    { label: '显示 / 隐藏', click: () => actions.toggleVisible() },
    { type: 'separator' },
    { label: '设置…', click: () => actions.openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ];
}
