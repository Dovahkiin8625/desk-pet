import { Tray, nativeImage } from 'electron';

export function createTray({ iconPath }) {
  const image = nativeImage.createFromPath(iconPath);
  const resized = image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
  const tray = new Tray(resized);
  tray.setToolTip('桌面宠物');
  // 刻意不注册 click 回调：Windows 上托盘带右键菜单时，左键点击可能
  // 既触发 click 又弹出菜单，导致「显示/隐藏」被连按两次。
  // 托盘的三个动作（显示/隐藏、设置、退出）都在右键菜单里。
  return tray;
}
