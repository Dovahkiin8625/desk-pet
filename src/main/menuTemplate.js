/**
 * 角色右键菜单 / 托盘菜单的模板。返回普通数组，便于单测。
 *
 * 两套菜单现在**是同一份**：「显示/隐藏 · 鼠标穿透 · 动作 · 设置 · 退出」几项，
 * （桌宠停靠在屏幕边缘外时，还会多出「取回桌宠」一项。）
 *
 * 以前右键菜单里还有一个「小工具」子菜单（待办、提醒、番茄钟……）。
 * 那条路换成了**插件面板**（见 src/main/panel.js）：
 * 双击桌宠 → 弹出搜索框 → 模糊搜索 → 回车打开插件界面。
 * 菜单放不下搜索框，也塞不下清单——插件面板才装得下。
 */

/**
 * 「动作」子菜单：按模型的动作组分组，组内逐个动作的菜单项。
 *
 * 只有一个动作的组直接铺成一项（如 Spine 的每个动画都自成一组），
 * 其余的组展开成二级子菜单。标签用模型里的原名（Idle / Hiyori_m01），
 * 不猜语义。清单由渲染层上报（pet:motions），主进程负责校验。
 */
function buildMotionItem(actions) {
  const list = actions.listMotions?.() || [];
  const groups = Array.isArray(list)
    ? list.filter((g) => g && typeof g.group === 'string' && Array.isArray(g.motions))
    : [];
  const submenu = [];
  for (const g of groups) {
    const motions = g.motions.filter((m) => m && Number.isInteger(m.index));
    if (motions.length === 0) continue;
    if (motions.length === 1) {
      const only = motions[0];
      submenu.push({
        label: g.group,
        click: () => actions.playMotion?.(g.group, only.index),
      });
    } else {
      submenu.push({
        label: g.group,
        submenu: motions.map((m) => ({
          label: typeof m.label === 'string' && m.label ? m.label : `动作 ${m.index + 1}`,
          click: () => actions.playMotion?.(g.group, m.index),
        })),
      });
    }
  }
  if (submenu.length === 0) {
    submenu.push({ label: '暂无可用动作', enabled: false });
  }
  return { label: '动作', submenu };
}

/** 基础菜单。托盘与右键都用它。 */
export function menuTemplate(actions) {
  const petName = actions.personaName?.() || '小桌';
  const items = [
    { label: '显示 / 隐藏', click: () => actions.toggleVisible() },
    { type: 'separator' },
  ];
  // 停靠（藏到屏幕边缘外）时才出现「取回{人设名}」。
  if (actions.isDocked?.()) {
    items.push({ label: `取回${petName}`, click: () => actions.retrievePet?.() });
    items.push({ type: 'separator' });
  }
  items.push({
    label: '鼠标穿透',
    type: 'checkbox',
    checked: Boolean(actions.isClickThrough?.()),
    click: () => actions.toggleClickThrough?.(),
  });
  items.push(buildMotionItem(actions));
  items.push({ type: 'separator' });
  items.push({ label: '设置…', click: () => actions.openSettings() });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => actions.quit() });
  return items;
}
