import { Menu } from 'electron';
import { menuTemplate } from './menuTemplate.js';

/**
 * 右键菜单与托盘菜单现在用的是同一份模板。
 *
 * 它们以前不一样：右键菜单里还有个「小工具」子菜单。
 * 那条路换成了插件面板（左键点桌宠 → 搜索 → 打开插件界面），
 * 菜单里就只剩这三项了。
 */
export function buildContextMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}

export function buildTrayMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}
