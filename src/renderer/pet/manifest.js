const SEMANTIC_ORDER = ['normal', 'happy', 'smile', 'shy', 'angry', 'surprised', 'sad'];

function pickExpression(model3) {
  const list = model3?.FileReferences?.Expressions;
  if (!Array.isArray(list)) return [];
  return list.map((e) => e.Name).filter((n) => typeof n === 'string' && n !== '');
}

function pickMotionGroups(model3) {
  const groups = model3?.FileReferences?.Motions;
  if (!groups || typeof groups !== 'object') return {};
  const out = {};
  for (const [group, entries] of Object.entries(groups)) {
    if (Array.isArray(entries) && entries.length > 0) out[group] = entries.length;
  }
  return out;
}

/**
 * 从 model3.json 探测模型能力，生成兜底清单。
 * 缺失任何能力都只影响对应功能，不抛错。
 */
export function deriveManifest(model3, opts = {}) {
  const expressions = pickExpression(model3);
  const motionGroups = pickMotionGroups(model3);

  // 降级时**不**按序号猜语义。官方样例 Haru 的 expressions[1] 是 F02，
  // 而 pet.json 里 F02 是 angry——按序号猜会让「摸头」触发生气的表情。
  // 猜不准就不猜：留空，由 resolveExpressionName 回退到第一个可用表情。
  const derived = {};

  const groupNames = Object.keys(motionGroups);
  const motions = {};
  if (groupNames.length > 0) {
    motions.idle = { group: groupNames[0], index: 0 };
    const tapGroup = groupNames.find((g) => /tap|body|hit/i.test(g)) || groupNames[0];
    motions.tapHead = { group: tapGroup, index: 0 };
    motions.tapBody = { group: tapGroup, index: Math.min(1, motionGroups[tapGroup] - 1) };
    motions.drag = { group: tapGroup, index: Math.min(2, motionGroups[tapGroup] - 1) };
  }

  return {
    id: opts.id || 'unknown',
    name: opts.name || opts.id || 'unknown',
    model3: opts.model3 || '',
    viewport: opts.viewport || { width: 300, height: 560 },
    fit: opts.fit || { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
    expressions: Object.keys(derived).length > 0 ? derived : {},
    motions,
    derived: true,
    availableExpressions: expressions,
    motionGroups,
  };
}

/** 清单与探测结果合并：清单优先，缺失项用探测值补齐。 */
export function mergeManifest(base, derived) {
  if (!base) return derived;
  const expressions = { ...(derived?.expressions || {}), ...(base.expressions || {}) };
  const motions = { ...(derived?.motions || {}), ...(base.motions || {}) };
  return {
    ...derived,
    ...base,
    expressions,
    motions,
    derived: false,
    availableExpressions: derived?.availableExpressions || [],
    motionGroups: derived?.motionGroups || {},
  };
}

export function resolveExpressionName(manifest, semantic) {
  const map = manifest?.expressions || {};
  if (map[semantic]) return map[semantic];
  const available = manifest?.availableExpressions || [];
  if (Array.isArray(available) && available.length > 0) return available[0] || null;
  return null;
}

export function resolveMotionSpec(manifest, key) {
  const spec = manifest?.motions?.[key];
  if (!spec || typeof spec.group !== 'string') return null;
  const groups = manifest?.motionGroups || {};
  const count = groups[spec.group];
  if (typeof count === 'number') {
    const index = Math.min(Math.max(0, spec.index | 0), Math.max(0, count - 1));
    return { group: spec.group, index };
  }
  return { group: spec.group, index: Math.max(0, spec.index | 0) };
}

/** 读取形象注册表与清单；清单缺失时回退到探测。 */
export async function loadManifest(modelId) {
  // 注册表读不出来时不能直接崩掉整个 boot——降级成空列表并让调用方拿到
  // 一个明确的错误，而不是一个未捕获的 fetch 异常。
  let registry = { models: [] };
  try {
    const registryRes = await fetch('/assets/live2d/index.json');
    if (!registryRes.ok) throw new Error(`HTTP ${registryRes.status}`);
    registry = await registryRes.json();
  } catch (err) {
    console.warn('[desk-pet] 形象注册表读取失败：', err?.message);
  }
  const models = Array.isArray(registry.models) ? registry.models : [];
  const entry = models.find((m) => m.id === modelId) || models[0];
  if (!entry) throw new Error(`未找到形象: ${modelId}`);

  const manifestUrl = `/assets/live2d/models/${entry.manifest}`;
  let base = null;
  try {
    const res = await fetch(manifestUrl);
    if (res.ok) base = await res.json();
  } catch {
    base = null;
  }

  const model3Name = base?.model3 || entry.model3 || `${entry.id}.model3.json`;
  const model3Url = `/assets/live2d/models/${entry.id}/${model3Name}`;
  let model3 = null;
  try {
    const res = await fetch(model3Url);
    if (res.ok) model3 = await res.json();
  } catch {
    model3 = null;
  }

  const derived = deriveManifest(model3, {
    id: entry.id,
    name: entry.name,
    model3: model3Name,
    viewport: base?.viewport,
    fit: base?.fit,
  });
  const merged = mergeManifest(base, derived);
  // 即使没有 pet.json，也要保证 model3 有值，否则模型无法加载
  merged.model3 = model3Name;
  // id 以注册表为准：pet.json 里的 id 若与注册表不一致，
  // 用它拼 URL 会 404，而且没有回退到已知可用的 entry.id。
  merged.id = entry.id;
  return merged;
}
