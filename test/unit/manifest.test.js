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

test('缺失语义时回退到第一个可用表情', () => {
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.equal(resolveExpressionName(m, 'happy'), 'A');
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
  // 按序号猜会让「摸头」触发生气。降级时宁可留空，由 resolveExpressionName 回退。
  const m = deriveManifest(MODEL3, { id: 'x' });
  assert.deepEqual(m.expressions, {});
});

test('降级清单只为普通表情兜底，其余语义保持未映射', () => {
  const derived = deriveManifest(MODEL3, { id: 'x' });
  const merged = mergeManifest(null, derived);
  assert.deepEqual(Object.keys(merged.expressions), ['normal']);
  assert.equal(merged.expressions.normal, 'A');
  // 未映射的语义仍能解析出可用表情（回退到第一个可用表情）
  assert.equal(resolveExpressionName(merged, 'happy'), 'A');
  assert.equal(resolveExpressionName(merged, 'angry'), 'A');
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
