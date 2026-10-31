import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveManifest,
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
  // 清单未覆盖的语义保留探测值
  assert.ok(merged.expressions.normal);
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

test('降级清单只为普通表情兜底，其余语义保持未映射', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const merged = mergeManifest(null, derived);
  assert.deepEqual(Object.keys(merged.expressions), ['normal']);
  assert.equal(merged.expressions.normal, 'A');
  // 未映射的语义解析为 null —— 交互层因此只播动作、不套表情。
  assert.equal(resolveExpressionName(merged, 'happy'), null);
  assert.equal(resolveExpressionName(merged, 'angry'), null);
  // 普通表情仍然有值：唯一被允许的猜测（「普通」不猜错任何情绪）。
  assert.equal(resolveExpressionName(merged, 'normal'), 'A');
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
  // 唯一被允许的兜底是「普通表情」——它不猜错情绪，只是可能不是中性脸。
  assert.equal(resolveExpressionName(merged, 'normal'), 'Angry');
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
