import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_BACKENDS,
  LLM_BACKEND_INFO,
  llmBackendInfo,
} from '../../src/shared/assistant.js';

/**
 * 对话后端的**中文名与说明**要跟着后端一起加。
 *
 * 契约只有一份（LLM_BACKENDS）——但光有 id 不够：
 * 加了第三个后端却忘了在设置页给它写名字，
 * 用户看到的是一个空白下拉框，只能靠猜。
 */

test('每个后端都有名字与说明', () => {
  for (const id of LLM_BACKENDS) {
    const info = LLM_BACKEND_INFO[id];
    assert.ok(info, `后端 ${id} 没有说明`);
    assert.ok(info.label.length > 0, `后端 ${id} 没有名字`);
    assert.ok(info.hint.length > 0, `后端 ${id} 没有说明文字`);
  }
});

test('说明要说清后果', () => {
  // agent 模式会动手：用户得知道它可能动他的文件。
  assert.match(LLM_BACKEND_INFO.agent.hint, /工具/);
  assert.match(LLM_BACKEND_INFO.agent.hint, /读/);
});

test('认不出来的后端：不抛错，原样回显', () => {
  // 磁盘上的值可能被手改过：设置页不能因此整个崩掉。
  const info = llmBackendInfo('bogus');
  assert.equal(info.label, 'bogus');
  assert.equal(info.hint, '');
});
