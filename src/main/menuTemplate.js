/**
 * 角色右键菜单 / 托盘菜单的模板。返回普通数组，便于单测。
 *
 * 两套菜单现在**是同一套**：只有「显示/隐藏 · 鼠标穿透 · 设置 · 退出」几项。
 * （桌宠停靠在屏幕边缘外时，还会多出「取回桌宠」一项。）
 *
 * 以前右键菜单里还有一个「小工具」子菜单（待办、提醒、番茄钟……），
 * 那条路换成了**插件面板**（见 src/main/panel.js）：
 * 左键点桌宠 → 弹出搜索框 → 模糊搜索 → 回车打开插件界面。
 * 菜单放不下搜索框，也塞不下清单——插件面板才装得下。
 */

/** 基础菜单。托盘与右键都用它。 */
export function menuTemplate(actions) {
  const items = [
    { label: '显示 / 隐藏', click: () => actions.toggleVisible() },
    { type: 'separator' },
  ];
  // 停靠（藏到屏幕边缘外）时才出现「取回桌宠」。
  if (actions.isDocked?.()) {
    items.push({ label: '取回桌宠', click: () => actions.retrievePet?.() });
    items.push({ type: 'separator' });
  }
  items.push({
    label: '鼠标穿透',
    type: 'checkbox',
    checked: Boolean(actions.isClickThrough?.()),
    click: () => actions.toggleClickThrough?.(),
  });
  items.push({ type: 'separator' });
  items.push({ label: '设置…', click: () => actions.openSettings() });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => actions.quit() });
  return items;
}
