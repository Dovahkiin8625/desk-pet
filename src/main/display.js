import { hasVisibleRect } from '../shared/petRect.js';

function rectContains(area, x, y, width, height) {
  return (
    x >= area.x &&
    y >= area.y &&
    x + width <= area.x + area.width &&
    y + height <= area.y + area.height
  );
}

function distanceToRect(area, x, y) {
  // 到矩形的距离（而非到中心的距离）：点在两块屏幕正下方时，
  // 中心距离会选中更远的那块，矩形距离才总是选最近的。
  const dx = Math.max(area.x - x, 0, x - (area.x + area.width));
  const dy = Math.max(area.y - y, 0, y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

/**
 * 把窗口位置夹紧到某个显示器的可见工作区内。
 * 用于**拖拽过程中的实时夹紧**——角色被拖到屏幕边缘时应停在最近的可见处，
 * 而不是跳回主显示器。
 * 若原位置已完整落在某显示器内则原样返回。
 *
 * `visible` 是桌宠**本体**在窗口里的矩形（窗口内坐标）。
 * 给了它，夹紧就按本体算：Live2D 贴图四周的透明留白不再占地方，
 * 小模型因此能贴到屏幕边（也能被拖到屏幕顶）。
 * 不给（默认）时按整块窗口算——那是旧行为。
 */
export function clampToDisplays(x, y, width, height, displays, visible = null) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPosition(width, height, list);

  const hasVisible = hasVisibleRect(visible);

  for (const d of list) {
    if (rectContains(d.workArea, x, y, width, height)) return { x, y };
    // 窗口本体可以有一部分在屏幕外（模型上方那块透明留白），
    // 只要**看得见的那个形象**完整落在屏幕里就算数。
    if (hasVisible && rectContains(d.workArea, x + visible.x, y + visible.y, visible.width, visible.height)) {
      return { x, y };
    }
  }

  // 选与该点距离最近的屏幕
  // （按本体算：离得近的是形象所在的那块屏，不是那块空白。）
  const px = hasVisible ? x + visible.x : x;
  const py = hasVisible ? y + visible.y : y;
  let best = list[0];
  let bestDist = Infinity;
  for (const d of list) {
    const dist = distanceToRect(d.workArea, px, py);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  const wa = best.workArea;
  if (hasVisible) {
    // 夹的是本体：窗口可以有一截在屏幕外。
    const minX = wa.x - visible.x;
    const maxX = wa.x + wa.width - visible.x - visible.width;
    const minY = wa.y - visible.y;
    const maxY = wa.y + wa.height - visible.y - visible.height;
    return {
      x: Math.min(Math.max(x, minX), Math.max(minX, maxX)),
      y: Math.min(Math.max(y, minY), Math.max(minY, maxY)),
    };
  }
  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - height);
  return {
    x: Math.min(Math.max(x, wa.x), maxX),
    y: Math.min(Math.max(y, wa.y), maxY),
  };
}

/**
 * 找到包含该点的显示器；没有显示器包含它时，返回**最近**的那块。
 *
 * 「最近」用的是到矩形的距离而不是到中心的距离（理由同 distanceToRect）：
 * 点在两块屏幕正下方时，中心距离会选中更远的那块。
 */
export function displayForPoint(x, y, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return null;
  for (const d of list) {
    if (rectContains(d.workArea, x, y, 1, 1)) return d;
  }
  let best = list[0];
  let bestDist = Infinity;
  for (const d of list) {
    const dist = distanceToRect(d.workArea, x, y);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/**
 * 启动时恢复上次保存的位置（spec §5.5）。
 * 位置完整落在某显示器可见区域内 → 原样恢复；
 * 否则（例如保存位置所在的显示器已被拔掉）→ 回落到**主显示器可见区域内的默认位置（右下角）**。
 *
 * 与 clampToDisplays 的分工：clampToDisplays 服务于拖拽（停在最近的可见处），
 * restorePosition 服务于启动恢复（回到主显示器默认位置）。两者语义不同，不能混用。
 */
export function restorePosition(saved, width, height, displays, visible = null) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    for (const d of list) {
      if (rectContains(d.workArea, saved.x, saved.y, width, height)) {
        return { x: saved.x, y: saved.y };
      }
      // 窗口有一截在屏幕外也算数：只要**看得见的那个形象**完整落在屏幕里。
      //
      // 桌宠窗口是固定大小的画布，形象上方常常有一大片透明留白，
      // 用户把角色拖到屏幕顶时窗口必然有一部分在屏幕外——
      // 按窗口判「不在屏幕内」会把桌宠判成「显示器被拔掉了」，
      // 悄悄挪回右下角。
      if (
        hasVisibleRect(visible) &&
        rectContains(
          d.workArea,
          saved.x + visible.x,
          saved.y + visible.y,
          visible.width,
          visible.height
        )
      ) {
        return { x: saved.x, y: saved.y };
      }
    }
  }
  return defaultPosition(width, height, list);
}

/**
 * 主显示器可见区域右下角的位置。
 * **前置条件：`displays[0]` 必须是主显示器**——调用方（Task 3 的 currentDisplays）
 * 负责把主显示器排在数组第一位，Electron 的 `getAllDisplays()` 并不保证这一点。
 */
export function defaultPosition(width, height, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  const wa = list[0].workArea;
  return {
    x: wa.x + Math.max(0, wa.width - width),
    y: wa.y + Math.max(0, wa.height - height),
  };
}
