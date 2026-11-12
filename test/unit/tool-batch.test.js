import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_APPROVAL,
  applyBatchEnabled,
  applyBatchApproval,
  selectAllState,
} from '../../src/settings/toolBatch.js';

/**
 * 「工具」页的批量操作。
 *
 * 钉三件事：
 *   1. 批量开关只动**选中的**那些工具；
 *   2. 批量设审批等级 = 改「以后不问」的那份名单（加进去 / 拿掉）；
 *   3. 「全选」的三种状态（全选、选了一半、没选）分得清。
 */

/** 批量开启：选中的从「关掉的」名单里拿掉，没选的一个都不动。 */
test('批量开启只动选中的工具', () => {
  const disabled = new Set(['fs.write', 'shell.exec']);
  const next = applyBatchEnabled(['fs.write'], true, disabled);
  assert.deepEqual([...next].sort(), ['shell.exec']);
});

/** 批量关闭：选中的进「关掉的」名单。 */
test('批量关闭把关掉的工具放进名单', () => {
  const next = applyBatchEnabled(['fs.write', 'fs.read'], false, new Set());
  assert.deepEqual([...next].sort(), ['fs.read', 'fs.write']);
});

/** 没选东西时，名单不该被动。 */
test('没选工具时批量开关不动名单', () => {
  const disabled = new Set(['fs.write']);
  const next = applyBatchEnabled([], false, disabled);
  assert.deepEqual([...next], ['fs.write']);
});

/** 批量设成「以后不问」：进名单。 */
test('批量设成「以后不问」的工具进名单', () => {
  const next = applyBatchApproval(['fs.write'], TOOL_APPROVAL.ALWAYS, new Set());
  assert.deepEqual([...next], ['fs.write']);
});

/** 批量设成「每次询问」：从名单里拿掉。 */
test('批量设成「每次询问」的工具从名单里拿掉', () => {
  const next = applyBatchApproval(['fs.write'], TOOL_APPROVAL.ASK, new Set(['fs.write', 'fs.read']));
  assert.deepEqual([...next], ['fs.read']);
});

/** 认不出来的值一律当「每次询问」——宁可多问一次，也不要悄悄放行。 */
test('认不出来的审批等级当「每次询问」', () => {
  const next = applyBatchApproval(['fs.write'], '胡说', new Set(['fs.write']));
  assert.deepEqual([...next], []);
});

/** 批量操作不改没选中的工具。 */
test('批量设审批等级不动没选中的工具', () => {
  const next = applyBatchApproval(['fs.write'], TOOL_APPROVAL.ALWAYS, new Set(['shell.exec']));
  assert.deepEqual([...next].sort(), ['fs.write', 'shell.exec']);
});

/** 「全选」的三种状态。 */
test('「全选」的状态分得清', () => {
  const names = ['a', 'b', 'c'];
  assert.deepEqual(selectAllState(names, new Set()), {
    total: 3,
    picked: 0,
    all: false,
    some: false,
  });
  assert.deepEqual(selectAllState(names, new Set(['a'])), {
    total: 3,
    picked: 1,
    all: false,
    some: true,
  });
  assert.deepEqual(selectAllState(names, new Set(['a', 'b', 'c'])), {
    total: 3,
    picked: 3,
    all: true,
    some: false,
  });
});

/** 一个工具都没有时，「全选」不算全选（不然点一下等于什么都没选）。 */
test('没有工具时「全选」不算全选', () => {
  const state = selectAllState([], new Set());
  assert.equal(state.all, false);
  assert.equal(state.total, 0);
});
