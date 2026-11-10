import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_INFO,
  approvalPolicyInfo,
  DEFAULT_AGENT,
} from '../../src/shared/assistant.js';
import { sanitizeAssistant, mergeAssistantPatch } from '../../src/main/assistant/state.js';

/**
 * 后台任务的设置（规格 §10 的 agent 段）。
 *
 * 审批是两组东西：**档位**与「永久放行的工具名单」。
 * 合并只深一层这件事在这里最容易出事——
 * 只带档位的补丁会把名单整个换掉，用户勾过的工具全白勾了。
 */

/** 每个档位都有名字与说明。 */
test('每个审批档位都有名字与说明', () => {
  assert.deepEqual([...APPROVAL_POLICIES].sort(), ['auto', 'graded', 'manual']);
  for (const id of APPROVAL_POLICIES) {
    const info = APPROVAL_POLICY_INFO[id];
    assert.ok(info, `审批档位 ${id} 没有说明`);
    assert.ok(info.label.length > 0, `审批档位 ${id} 没有名字`);
    assert.ok(info.hint.length > 0, `审批档位 ${id} 没有说明文字`);
  }
});

/** 认不出来的档位回退默认，别让用户卡在「什么都不问」还是「什么都问」之间。 */
test('认不出来的审批档位回退默认', () => {
  assert.equal(sanitizeAssistant({ agent: { approval: { policy: '胡说' } } }).agent.approval.policy, 'graded');
  assert.equal(sanitizeAssistant({ agent: { approval: {} } }).agent.approval.policy, 'graded');
});

/** 永久放行的名单：去重、去空。 */
test('永久放行的名单去重去空', () => {
  const clean = sanitizeAssistant({
    agent: { approval: { allowAlways: ['fs.write', 'fs.write', '', 'shell.exec'] } },
  });
  assert.deepEqual(clean.agent.approval.allowAlways, ['fs.write', 'shell.exec']);
});

/** 只改档位时，名单不能丢。 */
test('只改审批档位不会弄丢永久放行的名单', () => {
  const state = sanitizeAssistant({
    agent: { approval: { policy: 'graded', allowAlways: ['fs.write'] } },
  });
  const next = mergeAssistantPatch(state, { agent: { approval: { policy: 'manual' } } });
  assert.equal(next.agent.approval.policy, 'manual');
  assert.deepEqual(next.agent.approval.allowAlways, ['fs.write']);
});

/** 名单本身可以被换掉（用户取消勾选）。 */
test('永久放行的名单可以被换掉', () => {
  const state = sanitizeAssistant({
    agent: { approval: { policy: 'graded', allowAlways: ['fs.write'] } },
  });
  const next = mergeAssistantPatch(state, {
    agent: { approval: { policy: 'graded', allowAlways: [] } },
  });
  assert.deepEqual(next.agent.approval.allowAlways, []);
});

/** 改档位不该把别的 agent 设置带跑（并发数、工作区）。 */
test('改审批档位不会动到别的后台任务设置', () => {
  const state = sanitizeAssistant({ agent: { maxConcurrent: 4, workspace: 'C:/work' } });
  const next = mergeAssistantPatch(state, { agent: { approval: { policy: 'manual' } } });
  assert.equal(next.agent.maxConcurrent, 4);
  assert.equal(next.agent.workspace, 'C:/work');
});

/** 越界的值夹回范围——这些值直接决定「几个任务同时跑」与「工具多久算超时」。 */
test('后台任务的数字被夹回范围', () => {
  assert.equal(sanitizeAssistant({ agent: { maxConcurrent: 9999 } }).agent.maxConcurrent, 8);
  assert.equal(sanitizeAssistant({ agent: { maxConcurrent: 0 } }).agent.maxConcurrent, 1);
  assert.equal(sanitizeAssistant({ agent: { maxSteps: 0 } }).agent.maxSteps, 1);
  assert.equal(sanitizeAssistant({ agent: { maxSteps: 9999 } }).agent.maxSteps, 100);
  assert.equal(sanitizeAssistant({ agent: { timeoutMs: 1 } }).agent.timeoutMs, 1000);
  assert.equal(sanitizeAssistant({ agent: { timeoutMs: 99999999 } }).agent.timeoutMs, 30 * 60 * 1000);
});

/** 默认值是给人看的：档位是「问一声」，并发 1。 */
test('后台任务的默认值', () => {
  const clean = sanitizeAssistant({});
  assert.equal(clean.agent.maxConcurrent, DEFAULT_AGENT.maxConcurrent);
  assert.equal(clean.agent.approval.policy, 'graded');
  assert.deepEqual(clean.agent.approval.allowAlways, []);
});

/** 关掉的工具名：去重、去空。 */
test('关掉的工具名单去重去空', () => {
  const clean = sanitizeAssistant({
    agent: { tools: { disabled: ['fs.write', 'fs.write', '', 42] } },
  });
  assert.deepEqual(clean.agent.tools.disabled, ['fs.write']);
});

/** 默认全部开着：新插件带来新工具时不用手动开一遍。 */
test('默认没有工具被关掉', () => {
  assert.deepEqual(sanitizeAssistant({}).agent.tools.disabled, []);
});

/** 只改别的字段时，关掉的名单不能丢。 */
test('只改别的字段不会弄丢关掉的工具名单', () => {
  const state = sanitizeAssistant({ agent: { tools: { disabled: ['fs.write'] } } });
  const next = mergeAssistantPatch(state, { agent: { maxSteps: 30 } });
  assert.deepEqual(next.agent.tools.disabled, ['fs.write']);
  assert.equal(next.agent.maxSteps, 30);
});
