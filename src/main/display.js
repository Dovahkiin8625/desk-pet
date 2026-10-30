function rectContains(area, x, y, width, height) {
  return (
    x >= area.x &&
    y >= area.y &&
    x + width <= area.x + area.width &&
    y + height <= area.y + area.height
  );
}

function distanceToCenter(area, x, y) {
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  return Math.hypot(x - cx, y - cy);
}

/**
 * 把窗口位置夹紧到某个显示器的可见工作区内。
 * 若原位置已完整落在某显示器内则原样返回。
 */
export function clampToDisplays(x, y, width, height, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPosition(width, height, list);

  for (const d of list) {
    if (rectContains(d.workArea, x, y, width, height)) return { x, y };
  }

  // 选中心距离最近的那块屏幕
  let best = list[0];
  let bestDist = Infinity;
  for (const d of list) {
    const dist = distanceToCenter(d.workArea, x, y);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  const wa = best.workArea;
  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - height);
  return {
    x: Math.min(Math.max(x, wa.x), maxX),
    y: Math.min(Math.max(y, wa.y), maxY),
  };
}

/** 主显示器可见区域右下角的位置。 */
export function defaultPosition(width, height, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (list.length === 0) return { x: 0, y: 0 };
  const wa = list[0].workArea;
  return {
    x: wa.x + Math.max(0, wa.width - width),
    y: wa.y + Math.max(0, wa.height - height),
  };
}
