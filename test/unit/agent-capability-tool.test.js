import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapabilityTool } from '../../src/main/assistant/layer/capabilityTool.js';
import { TOOL_RISK } from '../../src/shared/assistant.js';

/**
 * 能力清单工具（规格 §4.1）。
 *
 * 三件事最容易做错：
 * 1. **只列名字**——技能正文与工具参数都不在这里，用户问的是「有哪些」；
 * 2. **清单是当场读的**——插件被关掉、工具被禁用，清单要跟着变；
 * 3. **只读**——交互层没有审批渠道，只读的工具才接得上。
 */

const SKILLS = [
  { name: 'weather', description: '查天气的用法' },
  { name: 'reminders', description: '管理定时提醒' },
];

const PLUGINS = [
  { id: 'weather', name: '天气', description: '查天气' },
  { id: 'todos', name: '待办', description: '记要做的事' },
];

const TOOLS = [
  { name: 'fs.read', source: 'builtin' },
  { name: 'weather.get', source: 'plugin' },
];

/** 造这个工具。 */
function makeTool(overrides = {}) {
  const tools = createCapabilityTool({
    getSkills: () => SKILLS,
    getPlugins: () => PLUGINS,
    getTools: () => TOOLS,
    ...overrides,
  });
  return tools[0];
}

test('清单：技能、插件、工具都列出来', async () => {
  const out = await makeTool().run({});
  assert.match(out.text, /weather/);
  assert.match(out.text, /reminders/);
  assert.match(out.text, /天气/);
  assert.match(out.text, /待办/);
  assert.match(out.text, /fs\.read/);
  assert.match(out.text, /weather\.get/);
});

test('清单：只列名字，不带参数与正文', async () => {
  const out = await makeTool({
    getSkills: () => [{ name: 'weather', description: '查天气的用法', body: '很长很长的正文' }],
    getTools: () => [{ name: 'fs.read', parameters: { type: 'object', properties: { path: {} } } }],
  }).run({});
  assert.doesNotMatch(out.text, /path/, '工具参数不该出现在清单里');
  assert.doesNotMatch(out.text, /很长很长的正文/, '技能正文不该出现在清单里');
});

test('清单：只读，交互层才接得上', () => {
  assert.equal(makeTool().risk, TOOL_RISK.READ);
});

test('清单：插件关掉后就没了——清单是当场读的', async () => {
  const out = await makeTool({ getPlugins: () => [] }).run({});
  assert.doesNotMatch(out.text, /^- 天气：/m);
  assert.match(out.text, /插件：现在没有/);
});

test('清单：插件没接给后台任务时说清楚', async () => {
  // 那个插件的工具不在工具表里——模型说「我可以帮你查」就是骗人。
  const out = await makeTool({
    getPlugins: () => [{ id: 'weather', name: '天气', description: '查天气', agentEnabled: false }],
  }).run({});
  assert.match(out.text, /没接给后台任务/);
});

test('清单：没有工具时说清楚没有', async () => {
  const out = await makeTool({ getTools: () => [] }).run({});
  assert.match(out.text, /工具：现在没有可用的工具/);
});
