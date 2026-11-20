/**
 * 「动作」子菜单的数据契约：主进程（菜单）与渲染层（播放）共用
 *
 * 形状：[{ group, motions: [{ index, label }] }]
 *   - Live2D：group 是动作组名（Idle / TapBody），label 是组内动作文件去掉扩展名的原名
 *   - Spine：每个动画自成一个 group（count 恒为 1），label 就是动画名
 */

/** 菜单项上限：模型再多动作也撑不爆原生菜单 */
export const MAX_MOTION_GROUPS = 256;
export const MAX_MOTIONS_PER_GROUP = 64;

/** 从动作文件路径取显示名：去掉目录与扩展名（含 .motion3.json 这类复合扩展） */
export function motionLabelFromFile(file) {
  if (typeof file !== 'string') return '';
  const base = file.replace(/\\/g, '/').split('/').pop() || '';
  const lower = base.toLowerCase();
  for (const suffix of ['.motion3.json', '.motion.json', '.json']) {
    if (lower.endsWith(suffix) && base.length > suffix.length) {
      return base.slice(0, base.length - suffix.length).trim();
    }
  }
  return base.replace(/\.[^./]+$/, '').trim();
}

/** 由清单生成菜单数据（渲染层用它上报） */
export function motionListForMenu(manifest) {
  // 视频形象：按 clip 清单生成，携带分类信息（用于菜单分组）并保持清单顺序。
  if (manifest?.type === 'video' && Array.isArray(manifest.clips)) {
    const out = [];
    for (const clip of manifest.clips) {
      if (!clip || !clip.file) continue;
      const id = typeof clip.id === 'string' ? clip.id.trim().slice(0, 64) : '';
      if (!id) continue;
      const label = typeof clip.label === 'string' && clip.label.trim() ? clip.label.trim().slice(0, 64) : id;
      const category = typeof clip.category === 'string' ? clip.category.trim().slice(0, 64) : '';
      const item = { group: id, motions: [{ index: 0, label }] };
      if (category) item.category = category;
      out.push(item);
      if (out.length >= MAX_MOTION_GROUPS) break;
    }
    if (out.length > 0) return out;
  }
  const groups = manifest?.motionGroups;
  if (!groups || typeof groups !== 'object') return [];
  const isSpine = manifest?.type === 'spine';
  const names = !isSpine && manifest?.motionNames && typeof manifest.motionNames === 'object'
    ? manifest.motionNames
    : {};
  const out = [];
  for (const [rawGroup, count] of Object.entries(groups)) {
    const group = typeof rawGroup === 'string' ? rawGroup.trim().slice(0, 64) : '';
    const total = Number(count);
    if (!group || !Number.isInteger(total) || total <= 0) continue;
    const labels = Array.isArray(names[group]) ? names[group] : [];
    const motions = [];
    for (let i = 0; i < Math.min(total, MAX_MOTIONS_PER_GROUP); i++) {
      const label = typeof labels[i] === 'string' && labels[i].trim()
        ? labels[i].trim().slice(0, 64)
        : isSpine
          ? group
          : `动作 ${i + 1}`;
      motions.push({ index: i, label });
    }
    if (motions.length > 0) out.push({ group, motions });
    if (out.length >= MAX_MOTION_GROUPS) break;
  }
  return out;
}

/**
 * 校验渲染层上报的菜单数据。清单来自渲染层（不是可信边界），
 * 原样用来建菜单会把任意字符串塞进原生菜单
 */
export function sanitizeMotions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const g of input.slice(0, MAX_MOTION_GROUPS)) {
    const group = typeof g?.group === 'string' ? g.group.trim().slice(0, 64) : '';
    if (!group) continue;
    const raw = Array.isArray(g?.motions) ? g.motions : [];
    const motions = [];
    for (const m of raw.slice(0, MAX_MOTIONS_PER_GROUP)) {
      const index = Number(m?.index);
      if (!Number.isInteger(index) || index < 0) continue;
      const label = typeof m?.label === 'string' && m.label.trim()
        ? m.label.trim().slice(0, 64)
        : `动作 ${index + 1}`;
      motions.push({ index, label });
    }
    if (motions.length > 0) {
      const item = { group, motions };
      const category = typeof g?.category === 'string' ? g.category.trim().slice(0, 64) : '';
      if (category) item.category = category;
      out.push(item);
    }
  }
  return out;
}
