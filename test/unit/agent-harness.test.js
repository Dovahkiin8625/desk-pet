import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHarnessRunner,
  parseHarnessLine,
  permissionModeForPolicy,
  HARNESS_AGENTS,
} from '../../src/main/assistant/agent/harness.js';

/**
 * 外部 harness 适配器（规格 §9）。
 *
 * 盯的是**真实 CLI 的输出格式**（实测自 claude code 2.1.319）：
 * stdout 是 JSONL，一行一个 JSON——但**不一定每行都是 JSON**。
 */

/** 造一个假的子进程。 */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    on() {},
    end(data) {
      child.stdinData = data;
    },
  };
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

/** 等一小会儿（让异步事件走完）。 */
function tick(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

test('认得出 CLI 的四种行', () => {
  assert.equal(parseHarnessLine('{"type":"system","subtype":"init","session_id":"s1"}')[0].kind, 'init');

  const toolUse = parseHarnessLine(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"a"}}]}}'
  );
  assert.equal(toolUse[0].kind, 'tool_use');
  assert.equal(toolUse[0].tool, 'Read');
  assert.deepEqual(toolUse[0].input, { file_path: 'a' });

  const toolResult = parseHarnessLine(
    '{"type":"user","message":{"content":[{"tool_use_id":"c1","type":"tool_result","content":"ok"}]}}'
  );
  assert.equal(toolResult[0].kind, 'tool_result');
  assert.equal(toolResult[0].text, 'ok');

  const text = parseHarnessLine('{"type":"assistant","message":{"content":[{"type":"text","text":"说点什么"}]}}');
  assert.equal(text[0].kind, 'text');
  assert.equal(text[0].text, '说点什么');

  const result = parseHarnessLine('{"type":"result","subtype":"success","result":"干完了"}');
  assert.equal(result[0].kind, 'result');
  assert.equal(result[0].text, '干完了');
});

test('一条消息里的多个内容块都要认出来', () => {
  const events = parseHarnessLine(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"先说一句"},{"type":"tool_use","id":"c1","name":"Bash","input":{}}]}}'
  );
  assert.deepEqual(events.map((e) => e.kind), ['text', 'tool_use']);
});

test('认不出的行不抛，返回空数组', () => {
  assert.deepEqual(parseHarnessLine('MiniMax is temporarily unavailable…'), []);
  assert.deepEqual(parseHarnessLine(''), []);
  assert.deepEqual(parseHarnessLine('{"type":"assistant"'), []);
  assert.deepEqual(parseHarnessLine('{"type":"unknown_kind"}'), []);
});

test('审批档位翻译成 CLI 的权限模式', () => {
  assert.equal(permissionModeForPolicy('auto'), 'bypassPermissions');
  assert.equal(permissionModeForPolicy('graded'), 'acceptEdits');
  assert.equal(permissionModeForPolicy('manual'), 'dontAsk');
  // 认不出来的档位按「问一声」处理（保守）。
  assert.equal(permissionModeForPolicy('胡说'), 'acceptEdits');
});

test('启动器：立刻返回，prompt 走 stdin，输出以事件的形式流出来', async () => {
  const child = fakeChild();
  const events = [];
  const runner = createHarnessRunner({
    spawn: () => child,
    killTree: () => {},
    logDir: '',
  });

  const started = await runner.run({
    agent: 'claude',
    prompt: '读一下 note.txt',
    taskId: 't1',
    onEvent: (e) => events.push(e),
  });
  assert.equal(started.ok, true);
  // **prompt 走 stdin**：命令行里一个字都不放模型写的东西。
  assert.equal(child.stdinData, '读一下 note.txt');

  child.stdout.emit(
    'data',
    '{"type":"system","subtype":"init","session_id":"s1"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"a"}}]}}\n' +
      '{"type":"user","message":{"content":[{"tool_use_id":"c1","type":"tool_result","content":"文件内容"}]}}\n'
  );
  await tick();

  assert.deepEqual(events.map((e) => e.kind), ['init', 'tool_use', 'tool_result']);
  assert.equal(events[1].label.includes('Read'), true);
  // 结果要靠 tool_use_id 对上工具名。
  assert.equal(events[2].label.includes('Read'), true);
  assert.equal(events[2].result, '文件内容');
});

test('启动器：认不出的行不抛，只进日志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-harness-'));
  try {
    const child = fakeChild();
    const events = [];
    const runner = createHarnessRunner({
      spawn: () => child,
      killTree: () => {},
      logDir: dir,
      now: () => 1,
    });
    const started = await runner.run({
      agent: 'claude',
      prompt: '干活',
      taskId: 't1',
      onEvent: (e) => events.push(e),
    });
    child.stdout.emit('data', 'MiniMax is temporarily unavailable…\n');
    await tick(30);

    assert.deepEqual(events, [], '认不出的行不该变成事件');
    const log = await readFile(started.logPath, 'utf8');
    assert.match(log, /MiniMax is temporarily unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('启动器：退出码非 0 要报出来', async () => {
  const child = fakeChild();
  const events = [];
  const runner = createHarnessRunner({ spawn: () => child, killTree: () => {} });
  await runner.run({ agent: 'claude', prompt: '干活', onEvent: (e) => events.push(e) });
  child.emit('close', 1);
  await tick();

  const err = events.find((e) => e.kind === 'error');
  assert.ok(err, '非零退出码没有变成错误事件');
  assert.match(err.error, /退出码 1/);
});

test('启动器：超时要杀掉进程树', async () => {
  const child = fakeChild();
  const events = [];
  let killed = null;
  const runner = createHarnessRunner({
    spawn: () => child,
    killTree: (c) => {
      killed = c;
    },
  });
  await runner.run({
    agent: 'claude',
    prompt: '干活',
    timeoutMs: 20,
    onEvent: (e) => events.push(e),
  });
  await tick(60);

  assert.equal(killed, child, '超时没有杀进程树');
  const err = events.find((e) => e.kind === 'error');
  assert.ok(err, '超时没有变成错误事件');
  assert.match(err.error, /超时/);
});

test('启动器：取消要杀进程树，而且不算失败', async () => {
  const child = fakeChild();
  const events = [];
  let killed = null;
  const runner = createHarnessRunner({
    spawn: () => child,
    killTree: (c) => {
      killed = c;
    },
  });
  const controller = new AbortController();
  await runner.run({
    agent: 'claude',
    prompt: '干活',
    taskId: 't1',
    signal: controller.signal,
    onEvent: (e) => events.push(e),
  });
  controller.abort();
  await tick();

  assert.equal(killed, child, '取消没有杀进程树');
  assert.equal(events.some((e) => e.kind === 'error'), false, '取消不该报成失败');
  assert.equal(events.some((e) => e.kind === 'cancelled'), true);
});

test('启动器：不认识的外部助手要报人话', async () => {
  const runner = createHarnessRunner({ spawn: () => fakeChild(), killTree: () => {} });
  await assert.rejects(
    () => runner.run({ agent: '不存在的', prompt: '干活' }),
    /还没有这个外部助手/
  );
});

test('启动器：没给 prompt 要报人话', async () => {
  const runner = createHarnessRunner({ spawn: () => fakeChild(), killTree: () => {} });
  await assert.rejects(() => runner.run({ agent: 'claude', prompt: '  ' }), /prompt/);
});

test('只有一个外部助手时，命令与参数是固定的那一套', () => {
  assert.ok(HARNESS_AGENTS.claude);
  assert.deepEqual(
    [...HARNESS_AGENTS.claude.args],
    ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
  );
});
