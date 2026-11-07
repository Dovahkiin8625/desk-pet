import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_RISK, TOOL_RISK_ORDER, TOOL_NAME_RE } from '../../src/shared/assistant.js';
import {
  TOOL_RISK_FLOOR,
  createToolRegistry,
  effectiveRisk,
  normalizeTool,
  stricterRisk,
} from '../../src/main/assistant/agent/tools/registry.js';

/**
 * agent 的工具注册表。
 *
 * 三条最容易做错的：
 * 1. 名字全局唯一、**先到先得**——插件不能覆盖内置的 shell.exec；
 * 2. 风险等级取「声明值」与「宿主下限」里**更严格**的那个；
 * 3. 声明了看不懂的风险等级 → 按最严格处理，不许当成 read。
 */

/** 造一个工具描述符。 */
function tool(name, risk = 'read', extra = {}) {
  return {
    name,
    label: `工具 ${name}`,
    description: '测试用',
    parameters: { type: 'object', properties: {} },
    risk,
    run: async () => ({ text: 'ok' }),
    ...extra,
  };
}

/** 收集日志的假 logger。 */
function fakeLogger() {
  const lines = [];
  return { warn: (...args) => lines.push(args.join(' ')), lines };
}

test('契约：风险等级与名字的形状', () => {
  assert.equal(TOOL_RISK.READ, 'read');
  assert.equal(TOOL_RISK.WRITE, 'write');
  assert.equal(TOOL_RISK.EXEC, 'exec');
  assert.deepEqual([...TOOL_RISK_ORDER], ['read', 'write', 'exec']);
  assert.ok(TOOL_NAME_RE.test('shell.exec'));
  assert.ok(TOOL_NAME_RE.test('fs.read'));
  assert.ok(!TOOL_NAME_RE.test('Shell.Exec'));
  assert.ok(!TOOL_NAME_RE.test('shell exec'));
});

test('注册表：注册、查找、列出', () => {
  const reg = createToolRegistry();
  const registered = reg.register(tool('fs.read'));
  assert.ok(registered, '注册要成功');
  assert.equal(registered.name, 'fs.read');
  assert.equal(reg.get('fs.read'), registered);
  assert.ok(reg.has('fs.read'));
  assert.deepEqual(reg.names(), ['fs.read']);
  assert.equal(reg.size, 1);
});

test('注册表：查不到的工具给 null，不给 undefined 也不抛错', () => {
  const reg = createToolRegistry();
  assert.equal(reg.get('没有这个'), null);
  assert.equal(reg.has('没有这个'), false);
});

test('注册表：同名工具**先到先得**，后来的被拒', () => {
  const logger = fakeLogger();
  const reg = createToolRegistry({ logger });
  const first = reg.register(tool('fs.read', 'read'));
  const second = reg.register(tool('fs.read', 'exec'));
  assert.ok(first);
  assert.equal(second, null, '后来的不能覆盖先来的');
  assert.equal(reg.get('fs.read'), first);
  assert.equal(reg.size, 1);
  assert.equal(logger.lines.length, 1, '要留一行日志');
});

test('注册表：描述符不合法就拒绝注册', () => {
  const reg = createToolRegistry();
  assert.equal(reg.register(null), null);
  assert.equal(reg.register({ name: '没有 run' }), null);
  assert.equal(reg.register(tool('Bad Name')), null);
  assert.equal(reg.size, 0);
});

test('风险：取更严格的那个', () => {
  assert.equal(stricterRisk('read', 'write'), 'write');
  assert.equal(stricterRisk('exec', 'write'), 'exec');
  assert.equal(stricterRisk('read', 'read'), 'read');
});

test('风险：宿主给已知危险工具名兜底', () => {
  assert.equal(TOOL_RISK_FLOOR['shell.exec'], 'exec');
  assert.equal(TOOL_RISK_FLOOR['fs.write'], 'write');
  assert.equal(effectiveRisk({ name: 'shell.exec', risk: 'read' }), 'exec', '插件自报 read 没用');
  assert.equal(effectiveRisk({ name: 'fs.write', risk: 'read' }), 'write');
  assert.equal(effectiveRisk({ name: 'weather.get', risk: 'read' }), 'read');
});

test('风险：看不懂的风险等级按最严格处理', () => {
  assert.equal(effectiveRisk({ name: 'x.y', risk: 'danger' }), 'exec');
  assert.equal(effectiveRisk({ name: 'x.y' }), 'exec', '没写风险等级也不许当成 read');
});

test('风险：插件提供的工具不自动放行——除非用户信任它', () => {
  // 规格 §5.2：「插件不能通过声明 read 来绕过检查」。
  // 按名字兜底只挡得住同名的那几个，插件换个名字（weather.get、backup.do）
  // 就绕过去了——所以插件来源的工具一律按「要确认」算。
  assert.equal(effectiveRisk({ name: 'weather.get', risk: 'read' }, { source: 'plugin' }), 'write');
  // 但用户永久放行过的工具，就按它声明的来（规格 §8.1 的 allowAlways）。
  assert.equal(
    effectiveRisk({ name: 'weather.get', risk: 'read' }, { source: 'plugin', allowAlways: ['weather.get'] }),
    'read'
  );
  // 内置工具不受这条影响：它们自己声明的就是真话。
  assert.equal(effectiveRisk({ name: 'weather.get', risk: 'read' }, { source: 'builtin' }), 'read');
});

test('注册表：插件注册的工具按插件来源算风险', () => {
  const reg = createToolRegistry();
  const t = reg.register(tool('weather.get', 'read'), { owner: 'weather' });
  assert.equal(t.risk, 'write', '插件来源的工具不能自动放行');
  assert.equal(t.source, 'plugin');
});

test('注册表：用户永久放行过的插件工具，按它声明的来', () => {
  const reg = createToolRegistry({ getAllowAlways: () => ['weather.get'] });
  const t = reg.register(tool('weather.get', 'read'), { owner: 'weather' });
  assert.equal(t.risk, 'read');
});

test('注册表：内置工具标着 builtin 来源', () => {
  const reg = createToolRegistry();
  const t = reg.register(tool('fs.read', 'read'));
  assert.equal(t.source, 'builtin');
});

test('注册表：注册时就把生效风险盖在描述符上', () => {
  const reg = createToolRegistry();
  const t = reg.register(tool('shell.exec', 'read'));
  assert.equal(t.risk, 'exec');
  assert.equal(reg.get('shell.exec').risk, 'exec');
});

test('注册表：按 owner 整批摘掉（插件被关掉时）', () => {
  const reg = createToolRegistry();
  reg.register(tool('a.one'), { owner: '插件甲' });
  reg.register(tool('a.two'), { owner: '插件甲' });
  reg.register(tool('b.one'), { owner: '插件乙' });
  assert.equal(reg.unregister('插件甲'), 2);
  assert.deepEqual(reg.names(), ['b.one']);
});

test('注册表：注册一批', () => {
  const reg = createToolRegistry();
  const registered = reg.registerAll([tool('a.one'), tool('a.two')], { owner: 'x' });
  assert.equal(registered.length, 2);
  assert.equal(reg.size, 2);
});

test('注册表：规整一个描述符', () => {
  const t = normalizeTool(tool('fs.read', 'read'));
  assert.equal(t.name, 'fs.read');
  assert.equal(t.risk, 'read');
  assert.equal(typeof t.run, 'function');
  assert.equal(normalizeTool(null), null);
  assert.equal(normalizeTool({ name: 'fs.read' }), null, '没有 run 就不算工具');
});
