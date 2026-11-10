import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AGENT_CONTEXT_CHARS,
  MAX_AGENT_CONTEXT_STEPS,
  MAX_AGENT_TOOL_RESULT_CHARS,
  buildAgentSystemPrompt,
  compactAgentMessages,
  compactionNote,
  truncateToolResult,
} from '../../src/main/assistant/agent/prompt.js';

/** 两只工具：一读一执行。 */
const TOOLS = [
  {
    name: 'fs.read',
    label: '读文件',
    description: '读一个文本文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
    risk: 'read',
  },
  {
    name: 'shell.exec',
    label: '执行命令',
    description: '执行一条命令。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command'],
    },
    risk: 'exec',
  },
];

/** 造一轮工具调用：assistant(tool_calls) + 一条 tool 结果。 */
function round(index, size = 10) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `c${index}`, type: 'function', function: { name: 'fs.read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `c${index}`, content: 'x'.repeat(size) },
  ];
}

/** 上下文里所有 assistant 的 tool_calls 都要有对应的 tool 结果。 */
function assertToolMessagesMatch(messages) {
  const ids = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      assert.ok(ids.includes(c.id), `缺 tool 结果：${c.id}`);
    }
  }
}

test('提示词：工具表、工作区、审批策略、人设、记忆都在里面', () => {
  const prompt = buildAgentSystemPrompt({
    persona: { name: '小桌', style: '活泼、亲切', backstory: '' },
    facts: ['用户喜欢喝美式'],
    tools: TOOLS,
    workspace: 'E:/project/desk-pet',
    approval: { policy: 'graded', allowAlways: ['fs.read'] },
    now: new Date('2026-11-07T10:00:00'),
  });
  assert.match(prompt, /小桌/);
  assert.match(prompt, /活泼、亲切/);
  assert.match(prompt, /fs\.read/);
  assert.match(prompt, /shell\.exec/);
  assert.match(prompt, /E:\/project\/desk-pet/);
  assert.match(prompt, /graded/);
  assert.match(prompt, /用户喜欢喝美式/);
  assert.match(prompt, /<<META>>/);
});

test('提示词：工作区为空时说清楚是用户主目录', () => {
  const prompt = buildAgentSystemPrompt({ tools: TOOLS, workspace: '' });
  assert.match(prompt, /用户主目录/);
});

test('提示词：告诉模型绝对路径能去任何地方', () => {
  const prompt = buildAgentSystemPrompt({ tools: TOOLS, workspace: 'E:/project/desk-pet' });
  assert.match(prompt, /绝对路径/);
});

test('提示词：一个工具都没有时，不列工具表', () => {
  const prompt = buildAgentSystemPrompt({ tools: [] });
  assert.doesNotMatch(prompt, /shell\.exec/);
});

test('提示词：技能只列名字与说明，正文不进提示词', () => {
  const prompt = buildAgentSystemPrompt({
    tools: TOOLS,
    skills: [{ name: 'weather', description: '查当前天气' }],
  });
  assert.match(prompt, /weather/);
  assert.match(prompt, /查当前天气/);
  assert.match(prompt, /skill\.read/, '要告诉模型有 skill.read 这个工具');
});

test('提示词：没有技能就不提技能', () => {
  const prompt = buildAgentSystemPrompt({ tools: TOOLS, skills: [] });
  assert.doesNotMatch(prompt, /skill\.read/);
});

test('工具结果超长要截断，而且要留痕', () => {
  const out = truncateToolResult('x'.repeat(MAX_AGENT_TOOL_RESULT_CHARS + 200));
  assert.ok(out.length < MAX_AGENT_TOOL_RESULT_CHARS + 200);
  assert.match(out, /已截断/);
});

test('工具结果不长就原样返回', () => {
  assert.equal(truncateToolResult('短短一句话'), '短短一句话');
});

test('上下文压缩：轮数超上限就丢最老的轮', () => {
  const messages = [{ role: 'user', content: '帮我看看' }, ...round(1), ...round(2), ...round(3)];
  const { messages: out, dropped } = compactAgentMessages(messages, { maxSteps: 2 });
  assert.equal(dropped, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out.filter((m) => m.role === 'tool').length, 2);
  assertToolMessagesMatch(out);
});

test('上下文压缩：不能留下孤零零的 tool 消息', () => {
  const messages = [{ role: 'user', content: '帮我看看' }, ...round(1), ...round(2), ...round(3)];
  const { messages: out } = compactAgentMessages(messages, { maxSteps: 1 });
  assert.equal(out.filter((m) => m.role === 'tool').length, 1);
  assertToolMessagesMatch(out);
  // 第一条绝不能是 tool：接口看到开头的 tool 消息会直接报错。
  assert.notEqual(out[0].role, 'tool');
});

test('上下文压缩：字数超上限也要压下去', () => {
  const messages = [{ role: 'user', content: 'x' }, ...round(1, 5000), ...round(2, 5000)];
  const { messages: out } = compactAgentMessages(messages, { maxSteps: 8, maxChars: 6000 });
  const chars = out.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(chars <= 6000, `还有 ${chars} 字没压下去`);
  assertToolMessagesMatch(out);
});

test('上下文压缩：本来就不超就什么都不动', () => {
  const messages = [{ role: 'user', content: 'x' }, ...round(1)];
  const { messages: out, dropped } = compactAgentMessages(messages, {});
  assert.equal(dropped, 0);
  assert.equal(out.length, messages.length);
});

test('压缩说明：丢了几轮就说几轮', () => {
  assert.equal(compactionNote(0), '');
  assert.match(compactionNote(3), /3/);
});
