import { displayForPoint } from './display.js';

/**
 * 「贴在桌宠旁边」的摆位算法。
 *
 * 气泡与插件面板共用它：两者都是桌宠旁边的小窗口，
 * 摆位规则完全一样（头顶 → 脚下 → 左侧 → 右侧，
 * 取第一个**完整落在工作区内**的位置）。
 *
 * 抄一份的后果是两边会慢慢漂移——窗口尺寸一变，
 * 只改了其中一个，另一个就会压到屏幕外或者盖住角色。
 */

/** 四个候选位置的默认优先顺序。 */
export const DEFAULT_SIDES = Object.freeze(['top', 'bottom', 'left', 'right']);

export function placeBesidePet({
  petWindow,
  displays,
  width,
  height,
  gap = 8,
  preferred = DEFAULT_SIDES,
} = {}) {
  if (!petWindow || petWindow.isDestroyed()) {
    return { placement: 'top', x: 0, y: 0 };
  }
  const [px, py] = petWindow.getPosition();
  const [pw, ph] = petWindow.getSize();
  const display = displayForPoint(px + pw / 2, py + ph / 2, displays);
  const wa = display?.workArea;

  const candidates = {
    top: { placement: 'top', x: px + pw / 2 - width / 2, y: py - height - gap },
    bottom: { placement: 'bottom', x: px + pw / 2 - width / 2, y: py + ph + gap },
    left: { placement: 'left', x: px - width - gap, y: py + ph / 2 - height / 2 },
    right: { placement: 'right', x: px + pw + gap, y: py + ph / 2 - height / 2 },
  };

  // `preferred` 允许调用方指定优先顺序。
  // 流式气泡要用它**锁住方向**：气泡长大之后可能从「头顶」变成「脚下」，
  // 换边会让小尾巴跳一下——正在读字的人会以为换了个窗口。
  const order = (Array.isArray(preferred) && preferred.length ? preferred : DEFAULT_SIDES).filter(
    (side) => candidates[side]
  );
  for (const side of order) {
    const c = candidates[side];
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (!wa) return { placement: c.placement, x, y };
    const fits =
      x >= wa.x && y >= wa.y && x + width <= wa.x + wa.width && y + height <= wa.y + wa.height;
    if (fits) return { placement: c.placement, x, y };
  }

  // 一个都放不下（屏幕太小）：夹进工作区，别让窗口跑到屏幕外面去。
  const x = wa ? px + pw / 2 - width / 2 : px;
  const y = wa ? py - height - gap : py;
  if (!wa) return { placement: 'top', x: Math.round(x), y: Math.round(y) };
  return {
    placement: 'top',
    x: Math.min(Math.max(Math.round(x), wa.x), wa.x + Math.max(0, wa.width - width)),
    y: Math.min(Math.max(Math.round(y), wa.y), wa.y + Math.max(0, wa.height - height)),
  };
}
