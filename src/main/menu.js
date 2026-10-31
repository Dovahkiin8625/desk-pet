import { Menu } from 'electron';
import { menuTemplate } from './menuTemplate.js';

export function buildContextMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}

export function buildTrayMenu(actions) {
  return Menu.buildFromTemplate(menuTemplate(actions));
}
