/**
 * 搜索结果右键菜单的模板。返回普通数组，便于单测。
 *
 * 菜单只有两项：**打开**与**打开所在目录**。
 * 没有所在目录的条目（系统设置页）只有「打开」——
 * 摆一个点了没反应的项比不摆更糟。
 */
export function resultMenuTemplate(item, actions) {
  const items = [
    { label: '打开', click: () => actions.open?.(item) },
  ];
  if (item?.path) {
    items.push({ label: '打开所在目录', click: () => actions.reveal?.(item) });
  }
  return items;
}
