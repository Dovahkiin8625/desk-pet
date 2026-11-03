import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { appUrl } from './protocol.js';
import { restorePosition, clampToDisplays, displayForPoint } from './display.js';
import { fitWindowSize, anchoredPosition } from '../shared/viewport.js';

/**
 * 桌宠窗口的尺寸：按用户缩放放大，并夹到所在显示器的可见工作区内。
 *
 * 为什么要跟着缩放变：桌宠窗口是**无边框**的，窗口有多大，模型才能画多大。
 * 窗口不变而模型变大，模型的上半身就被窗口边界切掉了——
 * 这正是「放大到一定程度后上方被截断」的成因。
 */
export function petWindowSize(scale, x, y, displays) {
  return fitWindowSize(scale, displayForPoint(x, y, displays)?.workArea);
}

export function createPetWindow({ rootDir, settings, displays }) {
  // 参考点：保存的位置（没有就用主显示器左上角），用来决定按哪块屏幕夹尺寸。
  const wa0 = displays?.[0]?.workArea;
  const ref =
    Number.isFinite(settings.position?.x) && Number.isFinite(settings.position?.y)
      ? settings.position
      : { x: wa0?.x ?? 0, y: wa0?.y ?? 0 };
  const size = petWindowSize(settings.scale, ref.x, ref.y, displays);
  // 用 restorePosition 而不是 clampToDisplays：启动恢复时若保存位置所在的显示器
  // 已被拔掉，应回落到主显示器右下角（spec §5.5），而不是停在原坐标的可见边缘。
  const pos = restorePosition(settings.position, size.width, size.height, displays);
  // 尺寸被屏幕夹小之后，restorePosition 给的位置可能让窗口超出屏幕，再夹一次位置。
  const placed = clampToDisplays(pos.x, pos.y, size.width, size.height, displays);

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: placed.x,
    y: placed.y,
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
  // 导航防护：窗口只该显示 app:// 下的页面。
  // 没有这道门，一次「把文件拖到桌宠身上」就可能把窗口导航到 file://，
  // 于是桌宠变成一个空白窗口——而用户只是拖了个文件进来。
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(appUrl('/src/renderer/index.html'));
  win.once('ready-to-show', () => {
    applySettingsToWindow(win, settings);
    if (settings.visible !== false) win.showInactive();
  });
  return win;
}

/**
 * 按新的缩放调整桌宠窗口的尺寸。
 *
 * 锚点是窗口的**下边缘中心**：桌宠是站在地上的角色，
 * 放大时脚下的位置不动，个头往上长——否则每放大一次，
 * 宠物就会在桌面上「长歪」一截。
 *
 * 返回新的边界；调用方要把它落盘：窗口尺寸变了，
 * 保存的左上角坐标就不再指向同一个位置。
 */
export function applyScaleToWindow(win, scale, displays) {
  if (!win || win.isDestroyed()) return null;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const size = petWindowSize(scale, x, y, displays);
  // 尺寸没变（已经被屏幕夹住了）：位置也不变，别白跑一次原生调用。
  if (size.width === w && size.height === h) {
    return { x, y, width: w, height: h };
  }
  const anchor = anchoredPosition(x, y, w, h, size);
  const placed = clampToDisplays(anchor.x, anchor.y, size.width, size.height, displays);
  win.setBounds({ x: placed.x, y: placed.y, width: size.width, height: size.height });
  return { x: placed.x, y: placed.y, width: size.width, height: size.height };
}

export function applySettingsToWindow(win, settings) {
  if (!win || win.isDestroyed()) return;
  if (typeof settings.opacity === 'number') {
    win.setOpacity(settings.opacity);
  }
}
