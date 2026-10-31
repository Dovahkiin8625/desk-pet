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
  // 猜不准就不猜：expressions 留空（见下方返回值的说明）。

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
    // 探测阶段永远不猜语义：表情映射保持为空。
    // （猜错的后果是「摸头」触发生气的脸，比不猜更糟。）
    expressions: {},
    motions,
    derived: true,
    availableExpressions: expressions,
    motionGroups,
  };
}

/**
 * 清单与探测结果合并：清单优先，缺失项用探测值补齐。
 *
 * 表情方面只补一个键：`normal`，而且**按名字**补、绝不按序号补。
 * 探测阶段不猜语义（见 deriveManifest 的注释），但「普通表情」总得有个值，
 * 否则清单缺项时连中性表情都拿不到。这里在模型**自己叫 "Normal"** 的表情里找：
 * Natori 有（它的表情表第一项是 Angry——按序号猜就正好猜错），
 * Haru 没有（它的表情名是 F01…F08），那就留空。
 *
 * 留空不是缺陷：未映射的语义在 resolveExpressionName 里返回 null，
 * 交互层于是只播动作、不套表情——这正是 spec §4.4 的降级表写的。
 *
 * 其余语义（happy/angry/...）一律不补，保持未映射。
 */
export function mergeManifest(base, derived) {
  const expressions = { ...(derived?.expressions || {}), ...(base?.expressions || {}) };
  const motions = { ...(derived?.motions || {}), ...(base?.motions || {}) };
  if (!expressions.normal) {
    // 按**名字**匹配，绝不按序号：availableExpressions[0] 是一个序号，
    // Natori 的第一项是 Angry——那会让降级模型空闲时永远挂着一张生气的脸。
    const named = (derived?.availableExpressions || []).find(
      (n) => typeof n === 'string' && n.trim().toLowerCase() === 'normal'
    );
    if (named) expressions.normal = named;
  }
  return {
    ...derived,
    ...(base || {}),
    expressions,
    motions,
    // derived 为 true 表示「没有用户清单，全部来自探测」。
    derived: !base,
    availableExpressions: derived?.availableExpressions || [],
    motionGroups: derived?.motionGroups || {},
  };
}

/**
 * 语义 → 模型自己的表情名。
 *
 * **未映射的语义返回 null**（不是「第一个可用表情」）：
 * 猜出来的表情可能是完全相反的情绪——Natori 的表情表第一项是 Angry，
 * 于是「摸头」会触发生气。spec §4.4 的降级表写的是
 * 「语义缺失 → 退化为播放对应动作；仍缺失 → 仅播动作」，
 * 交互层拿到 null 表情名时正是只播动作。
 */
export function resolveExpressionName(manifest, semantic) {
  const map = manifest?.expressions || {};
  return map[semantic] || null;
}

/**
 * 解析语义动作键 → { group, index }。
 *
 * 动作组在模型里不存在时返回 null：诚实的「这个模型没有这个能力」
 * 比一个到调用时才失败的 spec 好——后者会在渲染层抛错。
 */
export function resolveMotionSpec(manifest, key) {
  const spec = manifest?.motions?.[key];
  if (!spec || typeof spec.group !== 'string' || spec.group === '') return null;
  const groups = manifest?.motionGroups || {};
  const count = groups[spec.group];
  if (typeof count !== 'number' || count <= 0) return null;
  const index = Math.min(Math.max(0, spec.index | 0), count - 1);
  return { group: spec.group, index };
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
  // id 两边都要 trim：主进程读注册表时会 trim（entry.id 是规整后的值），
  // 渲染层若拿原始的 m.id 去比，两边就对不上同一个形象。
  const wanted = typeof modelId === 'string' ? modelId.trim() : '';
  const entry =
    models.find(
      (m) => typeof m?.id === 'string' && m.id.trim() !== '' && m.id.trim() === wanted
    ) || models[0];
  if (!entry) throw new Error(`未找到形象: ${modelId}`);
  const entryId = typeof entry.id === 'string' ? entry.id.trim() : '';

  // 注册表条目缺 manifest 时按与主进程**完全相同**的规则推导：`<id>/pet.json`。
  // 直接把 entry.manifest 拼进 URL 会得到 `…/undefined/pet.json` → 404 →
  // 模型静默降级成「没有语义映射」的样子，而用户完全看不出发生了什么。
  const manifestPath = entry.manifest || `${entryId}/pet.json`;
  const manifestUrl = `/assets/live2d/models/${manifestPath}`;
  let base = null;
  try {
    const res = await fetch(manifestUrl);
    if (res.ok) base = await res.json();
  } catch {
    base = null;
  }

  const model3Name = base?.model3 || entry.model3 || `${entryId}.model3.json`;
  const model3Url = `/assets/live2d/models/${entryId}/${model3Name}`;
  let model3 = null;
  try {
    const res = await fetch(model3Url);
    if (res.ok) model3 = await res.json();
  } catch {
    model3 = null;
  }

  const derived = deriveManifest(model3, {
    id: entryId,
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
  merged.id = entryId;
  return merged;
}
