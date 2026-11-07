import { Menu } from 'electron';
import { menuTemplate } from './menuTemplate.js';

/**
 * 右键菜单与托盘菜单现在用的是同一份模板。
 *
 * 它们以前不一样：右键菜单里还有个「小工具」子菜单。
 * 那条路换成了插件面板（双击桌宠 → 搜索 → 打开插件界面），
 * 菜单里就只剩「显示/隐藏 · 鼠标穿透 · 设置 · 退出」这几项了。
 * （停靠中的桌宠还会多出「取回桌宠」一项。）
 */
export function buildContextMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}

export function buildTrayMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}
