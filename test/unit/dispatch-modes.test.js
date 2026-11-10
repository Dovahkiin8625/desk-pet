import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPATCH_MODES,
  DISPATCH_MODE_INFO,
  dispatchModeInfo,
  DEFAULT_AGENT,
} from '../../src/shared/assistant.js';
import { sanitizeAssistant } from '../../src/main/assistant/state.js';

/**
 * 派单模式（规格 §10.3）。
 *
 * `llm.backend` 退役了，换成 `agent.dispatch`。
 * **迁移规则要精确**：给老用户平白发一个新能力（能派单、能动手），
 * 比不给要糟得多——用户会突然发现桌宠开始动他的文件。
 */

/** 每个派单模式都有名字与说明。 */
test('每个派单模式都有名字与说明', () => {
  for (const id of DISPATCH_MODES) {
    const info = DISPATCH_MODE_INFO[id];
    assert.ok(info, `派单模式 ${id} 没有说明`);
    assert.ok(info.label.length > 0, `派单模式 ${id} 没有名字`);
    assert.ok(info.hint.length > 0, `派单模式 ${id} 没有说明文字`);
  }
});

/** 说明要说清后果。 */
test('说明要说清后果', () => {
  // 「自动」意味着它会动手：用户得知道它可能动他的文件。
  assert.match(DISPATCH_MODE_INFO.auto.hint, /派/);
  assert.match(DISPATCH_MODE_INFO.auto.hint, /文件|动手|工具/);
  // 「关」意味着它只聊天。
  assert.match(DISPATCH_MODE_INFO.off.hint, /只|不|聊/);
});

/** 认不出来的模式：不抛错，原样回显。 */
test('认不出来的模式：不抛错，原样回显', () => {
  const info = dispatchModeInfo('bogus');
  assert.equal(info.label, 'bogus');
  assert.equal(info.hint, '');
});

/** 默认是「自动」。 */
test('默认能派单', () => {
  assert.equal(DEFAULT_AGENT.dispatch, 'auto');
  assert.equal(sanitizeAssistant({}).agent.dispatch, 'auto');
});

/** 迁移：以前选过 agent 的，现在能派单。 */
test('迁移：老配置 backend=agent → 能派单', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'agent' } }).agent.dispatch, 'auto');
});

/** 迁移：以前选普通对话的，保守起见不派单。 */
test('迁移：老配置 backend=chat → 不派单', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'chat' } }).agent.dispatch, 'off');
});

/** 迁移：整个文件里没有 llm 段（新装的）→ 默认值。 */
test('迁移：新装（没有 llm 段）→ 默认能派单', () => {
  assert.equal(sanitizeAssistant({}).agent.dispatch, 'auto');
});

/** 迁移：磁盘上的值认不出来 → 保守（不派单）。 */
test('迁移：认不出来的后端 → 不派单', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'bogus' } }).agent.dispatch, 'off');
});

/** 已经写过 dispatch 的：认它。 */
test('迁移：已有 dispatch 的就认它', () => {
  assert.equal(sanitizeAssistant({ agent: { dispatch: 'off' } }).agent.dispatch, 'off');
  assert.equal(sanitizeAssistant({ agent: { dispatch: 'auto' } }).agent.dispatch, 'auto');
});

/** 认不出来的 dispatch 值 → 默认。 */
test('迁移：认不出来的 dispatch → 默认', () => {
  assert.equal(sanitizeAssistant({ agent: { dispatch: 'bogus' } }).agent.dispatch, 'auto');
});
