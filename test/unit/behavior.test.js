import test from 'node:test';
import assert from 'node:assert/strict';
import { reactionFor, idleReaction } from '../../src/renderer/pet/behavior.js';
import { deriveManifest, mergeManifest } from '../../src/renderer/pet/manifest.js';

const manifest = mergeManifest(
  {
    id: 'x',
    name: 'X',
    expressions: { normal: 'N', happy: 'H', smile: 'S' },
    motions: { tapHead: { group: 'TapBody', index: 0 }, tapBody: { group: 'TapBody', index: 1 } },
  },
  deriveManifest(
    {
      FileReferences: {
        Expressions: [{ Name: 'N' }, { Name: 'H' }, { Name: 'S' }],
        Motions: { Idle: [{ File: 'i' }], TapBody: [{ File: 't1' }, { File: 't2' }] },
      },
    },
    { id: 'x' }
  )
);

test('摸头触发 happy 表情与 tapHead 动作', () => {
  const r = reactionFor(manifest, 'head');
  assert.equal(r.expressionName, 'H');
  assert.equal(r.motionSpec.group, 'TapBody');
  assert.equal(r.motionSpec.index, 0);
});

test('点击身体触发 smile 表情与 tapBody 动作', () => {
  const r = reactionFor(manifest, 'body');
  assert.equal(r.expressionName, 'S');
  assert.equal(r.motionSpec.index, 1);
});

test('未知区域没有反应', () => {
  const r = reactionFor(manifest, 'other');
  assert.equal(r.expressionName, null);
  assert.equal(r.motionSpec, null);
});

test('语义缺失时降级为可用表情而不是崩溃', () => {
  const bare = mergeManifest(null, deriveManifest({ FileReferences: { Expressions: [{ Name: 'Only' }] } }, { id: 'y' }));
  const r = reactionFor(bare, 'head');
  assert.equal(r.expressionName, 'Only');
});

test('空闲反应回到 normal 表情并播放 idle 动作', () => {
  const r = idleReaction(manifest);
  assert.equal(r.expressionName, 'N');
  assert.equal(r.motionSpec.group, 'Idle');
});

test('模型没有动作组时空闲反应不报错', () => {
  const bare = mergeManifest(null, deriveManifest({ FileReferences: { Expressions: [{ Name: 'Only' }] } }, { id: 'z' }));
  const r = idleReaction(bare);
  assert.equal(r.expressionName, 'Only');
  assert.equal(r.motionSpec, null);
});
