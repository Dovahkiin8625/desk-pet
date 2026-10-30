import { Tray, nativeImage } from 'electron';

export function createTray({ iconPath, onAction }) {
  const image = nativeImage.createFromPath(iconPath);
  const resized = image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
  const tray = new Tray(resized);
  tray.setToolTip('桌面宠物');
  tray.on('click', () => onAction('toggleVisible'));
  return tray;
}
