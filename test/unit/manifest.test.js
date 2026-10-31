import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveManifest,
  loadManifest,
  mergeManifest,
  resolveExpressionName,
  resolveMotionSpec,
} from '../../src/renderer/pet/manifest.js';

const MODEL3 = {
  FileReferences: {
    Expressions: [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }],
    Motions: {
      Idle: [{ File: 'i1' }, { File: 'i2' }],
      TapBody: [{ File: 't1' }, { File: 't2' }, { File: 't3' }],
    },
  },
};

test('探测出表情与动作组', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.deepEqual(m.availableExpressions, ['A', 'B', 'C']);
  assert.equal(m.motionGroups.Idle, 2);
  assert.equal(m.motionGroups.TapBody, 3);
});

test('清单优先于探测值', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const base = { id: 'x', name: 'X', expressions: { happy: 'B' }, motions: { tapHead: { group: 'TapBody', index: 2 } } };
  const merged = mergeManifest(base, derived);
  assert.equal(merged.expressions.happy, 'B');
  assert.equal(merged.motions.tapHead.group, 'TapBody');
  assert.equal(merged.motions.tapHead.index, 2);
  // 清单没写的语义保持未映射：探测阶段不猜语义。
  // MODEL3 的表情名是 A/B/C，没有一个叫 "Normal"，所以 normal 也不填。
  assert.equal(merged.expressions.normal, undefined);
  assert.equal(resolveExpressionName(merged, 'happy'), 'B');
  assert.equal(resolveExpressionName(merged, 'normal'), null);
});

test('缺失语义时返回 null：只播动作，不套表情', () => {
  // 猜表情比不猜更糟：Natori 的表情表第一项是 Angry，
  // 按序号猜会让「摸头」触发生气。spec §4.4 的降级表写的是
  // 「语义缺失 → 退化为播放对应动作；仍缺失 → 仅播动作」。
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.equal(resolveExpressionName(m, 'happy'), null);
  assert.equal(resolveExpressionName(m, 'angry'), null);
});

test('模型完全没有表情时返回 null', () => {
  const m = deriveManifest({ FileReferences: {} }, { id: 'x' });
  assert.equal(resolveExpressionName(m, 'happy'), null);
});

test('动作索引被夹紧到该组的有效范围', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  const spec = resolveMotionSpec(m, 'tapHead');
  assert.ok(spec);
  assert.ok(spec.index < m.motionGroups[spec.group]);
});

test('动作组名不存在时返回 null', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.equal(resolveMotionSpec(m, '不存在的键'), null);
});

// ---------------------------------------------------------------------------
// 以下用例补齐 brief 未覆盖、但接口契约要求的边界。
// ---------------------------------------------------------------------------

test('探测阶段不按序号猜语义，探测清单的表情映射始终为空', () => {
  // 官方样例 Haru 的 expressions[1] 是 F02，而 pet.json 里 F02 是 angry——
  // 按序号猜会让「摸头」触发生气。降级时宁可留空：未映射的语义只播动作。
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.deepEqual(m.expressions, {});
});

test('降级清单只按名字兜底普通表情，其余语义保持未映射', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const merged = mergeManifest(null, derived);
  // MODEL3 的表情名是 A/B/C：没有一个叫 "Normal"，所以**一个都不填**。
  assert.deepEqual(Object.keys(merged.expressions), []);
  assert.equal(merged.expressions.normal, undefined);
  // 未映射的语义解析为 null —— 交互层因此只播动作、不套表情。
  assert.equal(resolveExpressionName(merged, 'happy'), null);
  assert.equal(resolveExpressionName(merged, 'angry'), null);
  // 普通表情也解析为 null：没有就叫 "Normal" 的表情，就不猜。
  assert.equal(resolveExpressionName(merged, 'normal'), null);
});

test('没有 pet.json 且模型第一个表情是 Angry 时，摸头不会触发生气', () => {
  // Natori 的表情表第一项就是 Angry。一个只放了目录、没有 pet.json 的模型
  // （正是 §4.6「只放目录也能加载」的路径）如果按序号猜语义，
  // 「摸头」就会触发生气的脸。
  const derived = deriveManifest(
    { FileReferences: { Expressions: [{ Name: 'Angry' }, { Name: 'Smile' }, { Name: 'Normal' }] } },
    { id: 'natori' }
  );
  const merged = mergeManifest(null, derived);
  // 未映射的语义一律不猜：解析为 null → 交互层只播动作、不套表情。
  assert.equal(resolveExpressionName(merged, 'happy'), null);
  assert.equal(resolveExpressionName(merged, 'smile'), null);
  // 「普通表情」按**名字**匹配到 Normal——绝不是按序号匹配到 Angry。
  assert.equal(resolveExpressionName(merged, 'normal'), 'Normal');
  assert.notEqual(resolveExpressionName(merged, 'normal'), 'Angry');
});

test('没有 pet.json 且模型没有叫 Normal 的表情时，普通表情也保持未映射', () => {
  // Haru 的表情名是 F01…F08，没有 "Normal"：降级后空闲只播动作、不套表情，
  // 而不是硬塞一张「第一个表情」（那是按序号猜，正是要避免的）。
  const derived = deriveManifest(
    { FileReferences: { Expressions: [{ Name: 'F01' }, { Name: 'F02' }, { Name: 'F03' }] } },
    { id: 'haru' }
  );
  const merged = mergeManifest(null, derived);
  assert.equal(resolveExpressionName(merged, 'normal'), null);
  assert.notEqual(resolveExpressionName(merged, 'normal'), 'F01');
  assert.deepEqual(Object.keys(merged.expressions), []);
});

test('按名字兜底普通表情时忽略大小写与首尾空白', () => {
  const derived = deriveManifest(
    { FileReferences: { Expressions: [{ Name: ' normal ' }, { Name: 'NORMAL' }] } },
    { id: 'x' }
  );
  const merged = mergeManifest(null, derived);
  // 匹配到的是模型**自己的**名字（保留原样），不是我们拼出来的 "normal"。
  assert.equal(resolveExpressionName(merged, 'normal'), ' normal ');
});

test('清单指定普通表情时以清单为准', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const merged = mergeManifest({ id: 'x', name: 'X', expressions: { normal: 'C' } }, derived);
  assert.equal(merged.expressions.normal, 'C');
  assert.equal(resolveExpressionName(merged, 'normal'), 'C');
});

test('清单指向模型没有的动作组时返回 null', () => {
  // 探测结果里没有这个组 → 这个模型没有这个能力，如实返回 null，
  // 而不是给出一个到调用时才会失败的 spec。
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const base = { id: 'x', name: 'X', expressions: {}, motions: { tapHead: { group: 'NoSuchGroup', index: 0 } } };
  const merged = mergeManifest(base, derived);
  assert.equal(resolveMotionSpec(merged, 'tapHead'), null);
});

test('动作索引越界时被夹紧到该组最后一个', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const base = { id: 'x', name: 'X', expressions: {}, motions: { tapHead: { group: 'TapBody', index: 99 } } };
  const merged = mergeManifest(base, derived);
  const spec = resolveMotionSpec(merged, 'tapHead');
  assert.equal(spec.group, 'TapBody');
  assert.equal(spec.index, merged.motionGroups.TapBody - 1);
});

test('清单未定义动作组时降级为空动作表', () => {
  const m = deriveManifest({ FileReferences: { Expressions: [{ Name: 'A' }] } }, { id: 'x' });
  assert.deepEqual(m.motions, {});
  assert.equal(resolveMotionSpec(m, 'tapHead'), null);
});

// ---------------------------------------------------------------------------
// 注册表条目规整：渲染层必须与主进程用同一套推导规则。
// ---------------------------------------------------------------------------

/** 用一个假的 fetch 跑 loadManifest，并记录它请求过的 URL。 */
async function loadManifestWithFakeFetch(registry, files) {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === '/assets/live2d/index.json') {
      return new Response(JSON.stringify(registry), { status: 200 });
    }
    const body = files?.[url];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  try {
    return { manifest: await loadManifest(registry.models[0].id), requested };
  } finally {
    globalThis.fetch = original;
  }
}

test('注册表条目缺 manifest 时按 <id>/pet.json 推导，不去取 .../undefined/pet.json', async () => {
  // 主进程把缺 manifest 的条目规整成 `<id>/pet.json`；
  // 渲染层若把 entry.manifest 直接拼进 URL，得到的是 `…/undefined/pet.json`
  // → 404 → 模型静默降级成「没有语义映射」的样子。
  const { manifest, requested } = await loadManifestWithFakeFetch(
    { models: [{ id: 'natori', name: 'Natori' }] },
    {
      '/assets/live2d/models/natori/pet.json': {
        id: 'natori',
        expressions: { normal: 'Normal', happy: 'Smile' },
      },
    }
  );
  assert.ok(
    !requested.some((u) => u.includes('undefined')),
    `不应请求 undefined 路径，实际请求：${requested.join(', ')}`
  );
  assert.ok(requested.includes('/assets/live2d/models/natori/pet.json'));
  // 清单真的被读到了：语义映射来自 pet.json，而不是降级。
  assert.equal(manifest.derived, false);
  assert.equal(manifest.expressions.normal, 'Normal');
  assert.equal(manifest.expressions.happy, 'Smile');
});

test('注册表条目的 id 两侧都 trim：带空格的条目也能被找到', async () => {
  // 主进程读注册表时会 trim id；渲染层若拿原始的 m.id 去比，
  // 两边就指的不是同一个形象（设置窗口显示一个、桌面上跑另一个）。
  const { manifest } = await loadManifestWithFakeFetch(
    { models: [{ id: ' natori ', name: 'Natori', manifest: 'natori/pet.json' }] },
    {
      '/assets/live2d/models/natori/pet.json': { id: 'natori', expressions: { normal: 'Normal' } },
    }
  );
  assert.equal(manifest.id, 'natori');
  assert.equal(manifest.derived, false);
});
