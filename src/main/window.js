import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { appUrl } from './protocol.js';
import { restorePosition } from './display.js';

export function createPetWindow({ rootDir, settings, displays }) {
  const vp = settings.viewport || { width: 300, height: 560 };
  // 用 restorePosition 而不是 clampToDisplays：启动恢复时若保存位置所在的显示器
  // 已被拔掉，应回落到主显示器右下角（spec §5.5），而不是停在原坐标的可见边缘。
  const pos = restorePosition(settings.position, vp.width, vp.height, displays);

  const win = new BrowserWindow({
    width: vp.width,
    height: vp.height,
    x: pos.x,
    y: pos.y,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(rootDir, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadURL(appUrl('/src/renderer/index.html'));
  win.once('ready-to-show', () => {
    applySettingsToWindow(win, settings);
    if (settings.visible !== false) win.showInactive();
  });
  return win;
}

export function applySettingsToWindow(win, settings) {
  if (!win || win.isDestroyed()) return;
  if (typeof settings.opacity === 'number') {
    win.setOpacity(settings.opacity);
  }
}
