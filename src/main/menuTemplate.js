/** 角色右键菜单 / 托盘菜单共用的模板。返回普通数组，便于单测。 */
export function menuTemplate(actions) {
  return [
    { label: '显示 / 隐藏', click: () => actions.toggleVisible() },
    { type: 'separator' },
    { label: '设置…', click: () => actions.openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ];
}
