import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuiltinTools } from '../../src/main/assistant/agent/tools/builtin.js';
import { TOOL_RISK } from '../../src/shared/assistant.js';

/**
 * `harness.run` 工具（规格 §9）。
 *
 * 它跟别的内置工具不一样：**立刻返回**，过程靠异步事件往外送。
 */

function findTool(tools, name) {
  return tools.find((t) => t.name === name) || null;
}

test('工具表里有 harness.run，且是执行级', () => {
  const tools = createBuiltinTools({});
  const tool = findTool(tools, 'harness.run');
  assert.ok(tool, '工具表里没有 harness.run');
  assert.equal(tool.risk, TOOL_RISK.EXEC);
  assert.deepEqual(tool.parameters.required, ['prompt']);
});

test('工具立刻返回，不等外部助手跑完', async () => {
  const tools = createBuiltinTools({
    getWorkspace: () => '',
    harness: {
      run: async (opts) => {
        // 真的开跑之后才 resolve——工具不能等它。
        return { ok: true, agent: opts.agent, label: 'claude code', logPath: 'x.log' };
      },
    },
  });
  const tool = findTool(tools, 'harness.run');
  const out = await tool.run({ prompt: '把 README 改短一点' }, {});
  assert.match(out.text, /已启动/);
  assert.match(out.text, /别凭空编结果/);
  assert.equal(out.data.agent, 'claude');
});

test('没有 prompt 就报错', async () => {
  const tools = createBuiltinTools({
    harness: { run: async () => ({ ok: true }) },
  });
  const tool = findTool(tools, 'harness.run');
  await assert.rejects(() => tool.run({ prompt: '   ' }, {}), /prompt/);
});

test('没接上外部助手时说不接上了', async () => {
  const tools = createBuiltinTools({});
  const tool = findTool(tools, 'harness.run');
  await assert.rejects(() => tool.run({ prompt: '干活' }, {}), /还没接上/);
});

test('审批档位翻译成 CLI 的权限模式', async () => {
  const seen = [];
  const tools = createBuiltinTools({
    harness: {
      run: async (opts) => {
        seen.push(opts.permissionMode);
        return { ok: true, agent: 'claude', label: 'claude code', logPath: '' };
      },
    },
    getPolicy: () => 'auto',
  });
  const tool = findTool(tools, 'harness.run');
  await tool.run({ prompt: '干活' }, {});
  assert.deepEqual(seen, ['bypassPermissions']);
});

test('任务号与事件一起送过去', async () => {
  const events = [];
  let captured = null;
  const tools = createBuiltinTools({
    harness: {
      run: async (opts) => {
        captured = opts;
        // 工具返回之后事件才来——这正是 harness 的形态。
        opts.onEvent({ kind: 'text', label: 'claude code 说了一句', result: '在干了' });
        return { ok: true, agent: 'claude', label: 'claude code', logPath: 'a.log' };
      },
    },
  });
  const tool = findTool(tools, 'harness.run');
  await tool.run({ prompt: '干活' }, {
    taskId: 'task-7',
    onEvent: (e) => events.push(e),
  });
  assert.equal(captured.taskId, 'task-7');
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, 'harness.run');
  assert.equal(events[0].label, 'claude code 说了一句');
  assert.equal(events[0].result, '在干了');
});

test('工作目录：相对路径按工作区解析，绝对路径原样用', async () => {
  const seen = [];
  const tools = createBuiltinTools({
    getWorkspace: () => 'C:\\work',
    harness: {
      run: async (opts) => {
        seen.push(opts.cwd);
        return { ok: true, agent: 'claude', label: 'claude code', logPath: '' };
      },
    },
  });
  const tool = findTool(tools, 'harness.run');
  await tool.run({ prompt: '干活' }, {});
  await tool.run({ prompt: '干活', cwd: 'sub' }, {});
  await tool.run({ prompt: '干活', cwd: 'D:\\other' }, {});
  assert.equal(seen[0], 'C:\\work');
  assert.equal(seen[1], 'C:\\work\\sub');
  assert.equal(seen[2], 'D:\\other');
});

test('超时：模型给的优先，没给就用设置里的上限', async () => {
  const seen = [];
  const tools = createBuiltinTools({
    getTimeoutMs: () => 60000,
    harness: {
      run: async (opts) => {
        seen.push(opts.timeoutMs);
        return { ok: true, agent: 'claude', label: 'claude code', logPath: '' };
      },
    },
  });
  const tool = findTool(tools, 'harness.run');
  await tool.run({ prompt: '干活' }, {});
  await tool.run({ prompt: '干活', timeout: 5000 }, {});
  assert.deepEqual(seen, [60000, 5000]);
});
