/** 把 Live2D 命中区名归一化。只认名字，不认模型内部的 Id。 */
export function normalizeZone(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return 'other';
  if (n.includes('head')) return 'head';
  if (n.includes('body') || n.includes('torso')) return 'body';
  return 'other';
}

/** 模型没有命中区时的几何兜底：包围盒上 35% 视为头部。 */
export function geometricZone(bounds, x, y) {
  if (!bounds || !Number.isFinite(bounds.height) || bounds.height <= 0) return 'other';
  const rel = (y - bounds.y) / bounds.height;
  if (!Number.isFinite(rel)) return 'other';
  return rel <= 0.35 ? 'head' : 'body';
}

/** 优先使用模型原生命中区，失败或无结果时退回几何判定。 */
export function hitZoneAt(model, x, y) {
  const areas = model?.internalModel?.hitAreas || {};
  const hasAreas = Object.keys(areas).length > 0;
  if (hasAreas) {
    try {
      const hit = model.hitTest(x, y);
      const list = Array.isArray(hit) ? hit : hit ? [hit] : [];
      for (const h of list) {
        const zone = normalizeZone(h);
        if (zone !== 'other') return zone;
      }
    } catch {
      /* 落到几何判定 */
    }
  }
  try {
    return geometricZone(model.getBounds(), x, y);
  } catch {
    return 'other';
  }
}
