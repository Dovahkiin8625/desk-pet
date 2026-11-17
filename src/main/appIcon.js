import { join } from 'node:path';

/**
 * 应用图标的路径（`assets/icons/icon.png`，由 `scripts/gen-icon.mjs` 生成）。
 *
 * 所有 BrowserWindow 的 `icon`、以及 Windows 任务栏上的窗口按钮、
 * Alt+Tab 里的样子，都靠它——不给的话 Electron 会拿自己的默认图标
 * 顶上（那个蓝紫色方块跟这儿的桌宠没有一点关系）。
 */
export function appIconPath(rootDir) {
  return join(rootDir, 'assets', 'icons', 'icon.png');
}
