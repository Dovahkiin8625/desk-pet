import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chimeText,
  greetingFor,
  isOnTheHour,
  msUntilNextHour,
  weekdayText,
} from '../../src/main/assistant/clock.js';
import { DEFAULT_LLM } from '../../src/shared/assistant.js';
import {
  addTodo,
  clearDone,
  createTodo,
  pendingCount,
  removeTodo,
  toggleTodo,
} from '../../src/main/assistant/todos.js';
import {
  addReminder,
  dueReminders,
  humanDuration,
  markFired,
  parseReminder,
  removeReminder,
} from '../../src/main/assistant/reminders.js';
import {
  PHASE,
  createPomodoroState,
  formatRemaining,
  isFinished,
  pause,
  pomodoroText,
  remaining,
  reset,
  resume,
  start,
} from '../../src/main/assistant/pomodoro.js';
import {
  DEFAULT_ASSISTANT,
  sanitizeAssistant,
} from '../../src/main/assistant/state.js';

// 2026-10-31 是星期六。用固定时刻，测试才不受「跑测的时间」影响。
const NOON = new Date(2026, 9, 31, 12, 0, 0, 0).getTime();

test('问候语按时间段变化', () => {
  assert.match(greetingFor(new Date(2026, 9, 31, 7)).text, /早上好/);
  assert.match(greetingFor(new Date(2026, 9, 31, 10)).text, /上午好/);
  assert.match(greetingFor(new Date(2026, 9, 31, 13)).text, /中午好/);
  assert.match(greetingFor(new Date(2026, 9, 31, 16)).text, /下午好/);
  assert.match(greetingFor(new Date(2026, 9, 31, 20)).text, /晚上好/);
  assert.match(greetingFor(new Date(2026, 9, 31, 23)).text, /夜深了/);
  assert.match(greetingFor(new Date(2026, 9, 31, 3)).text, /夜深了/);
});

test('整点报时的说法', () => {
  assert.equal(chimeText(new Date(2026, 9, 31, 14, 0)), '现在 14 点整');
  assert.equal(chimeText(new Date(2026, 9, 31, 14, 30)), '现在 14 点 30 分');
});

test('整点判定', () => {
  assert.equal(isOnTheHour(new Date(2026, 9, 31, 14, 0)), true);
  assert.equal(isOnTheHour(new Date(2026, 9, 31, 14, 1)), false);
});

test('下一个整点的等待时间不会跨过整点本身', () => {
  // 对齐到整点的**那一秒**，让「整点判定」自己决定要不要报——
  // 否则定时器会在 14:00 报一次、14:01 又报一次。
  const base = new Date(2026, 9, 31, 14, 0, 0, 0);
  const delay = msUntilNextHour(base);
  assert.ok(delay > 0);
  // 上界是「一小时 + 一秒」：从整点出发的话，
  // 下一个 HH:00:01 在 1 小时 1 秒之后（差的那一秒是刻意留给判定用的）。
  assert.ok(delay <= 3600000 + 1000, `等待时间 ${delay} 不该超过一小时零一秒`);
  const target = new Date(base.getTime() + delay);
  assert.equal(target.getHours(), 15);
  assert.equal(target.getMinutes(), 0);
  assert.equal(target.getSeconds(), 1);
});

test('星期几的中文说法', () => {
  assert.equal(weekdayText(new Date(2026, 9, 31)), '六');
  assert.equal(weekdayText(new Date(2026, 9, 28)), '三');
});

test('待办：加、勾选、删除、清空已完成', () => {
  let todos = [];
  const a = addTodo(todos, '买菜');
  todos = a.todos;
  const b = addTodo(todos, '写周报');
  todos = b.todos;
  assert.equal(todos.length, 2);
  assert.equal(pendingCount(todos), 2);

  todos = toggleTodo(todos, a.added.id);
  assert.equal(todos[0].done, true);
  assert.equal(pendingCount(todos), 1);

  todos = toggleTodo(todos, a.added.id);
  assert.equal(todos[0].done, false);

  todos = removeTodo(todos, b.added.id);
  assert.equal(todos.length, 1);

  todos = toggleTodo(todos, a.added.id);
  todos = clearDone(todos);
  assert.equal(todos.length, 0);
});

test('待办：空白内容不会被加进去', () => {
  assert.equal(createTodo('   '), null);
  assert.equal(createTodo(''), null);
  const r = addTodo([], '  ');
  assert.equal(r.added, null);
  assert.equal(r.todos.length, 0);
});

test('提醒：解析相对时长', () => {
  const r = parseReminder('30分钟后喝水', NOON);
  assert.ok(r);
  assert.equal(r.at, NOON + 30 * 60000);
  assert.equal(r.text, '喝水');
  assert.match(r.label, /30 分钟/);
});

test('提醒：解析小时与分钟的组合', () => {
  const r = parseReminder('1小时30分后起来走走', NOON);
  assert.ok(r);
  assert.equal(r.at, NOON + 90 * 60000);
  assert.equal(r.text, '起来走走');
});

test('提醒：解析绝对时刻', () => {
  const r = parseReminder('14:30 交周报', NOON);
  assert.ok(r);
  const at = new Date(r.at);
  assert.equal(at.getHours(), 14);
  assert.equal(at.getMinutes(), 30);
  assert.equal(r.text, '交周报');
  assert.match(r.label, /今天/);
});

test('提醒：已经过去的时刻顺延到明天', () => {
  const r = parseReminder('09:00 开会', NOON);
  assert.ok(r);
  const at = new Date(r.at);
  assert.equal(at.getDate(), 1); // 10 月 31 日 → 11 月 1 日
  assert.match(r.label, /明天/);
});

test('提醒：写「明天」就是明天', () => {
  const r = parseReminder('明天 09:00 开会', NOON);
  assert.ok(r);
  const at = new Date(r.at);
  assert.equal(at.getDate(), 1);
  assert.equal(at.getHours(), 9);
});

test('提醒：解析不出时间时返回 null，而不是默默按默认时间提醒', () => {
  assert.equal(parseReminder('记得喝水', NOON), null);
  assert.equal(parseReminder('', NOON), null);
  assert.equal(parseReminder('25:00 不可能', NOON), null);
});

test('提醒：到点与已播报', () => {
  const r = addReminder([], '喝水', NOON + 1000);
  let reminders = r.reminders;
  assert.equal(dueReminders(reminders, NOON).length, 0);
  assert.equal(dueReminders(reminders, NOON + 2000).length, 1);

  reminders = markFired(reminders, [r.added.id]);
  // 播报过的不再重复触发——但**不能**从数组里删掉：
  // 删掉的话重启应用时就没法区分「没到点」和「到点但还没播报」。
  assert.equal(dueReminders(reminders, NOON + 999999).length, 0);
  assert.equal(reminders.length, 1);

  reminders = removeReminder(reminders, r.added.id);
  assert.equal(reminders.length, 0);
});

test('时长的人话说法', () => {
  assert.equal(humanDuration(30 * 60000), '30 分钟');
  assert.equal(humanDuration(60 * 60000), '1 小时');
  assert.equal(humanDuration(90 * 60000), '1 小时 30 分');
});

test('番茄钟：开始、暂停、继续、结束', () => {
  const s = start(createPomodoroState(), PHASE.FOCUS, 60000, NOON);
  assert.equal(s.phase, PHASE.FOCUS);
  assert.equal(s.endsAt, NOON + 60000);
  assert.equal(remaining(s, NOON + 30000), 30000);
  assert.equal(isFinished(s, NOON + 30000), false);

  const p = pause(s, NOON + 30000);
  assert.equal(p.phase, PHASE.PAUSED);
  assert.equal(p.endsAt, null);
  assert.equal(p.remainingMs, 30000);
  // 暂停期间时间不流逝
  assert.equal(remaining(p, NOON + 999999), 30000);

  const r = resume(p, NOON + 60000);
  assert.equal(r.phase, PHASE.FOCUS);
  assert.equal(r.endsAt, NOON + 60000 + 30000);

  assert.equal(isFinished(s, NOON + 60001), true);
  assert.equal(reset().phase, PHASE.IDLE);
});

test('番茄钟：暂停不计时', () => {
  const s = start(createPomodoroState(), PHASE.FOCUS, 60000, NOON);
  assert.equal(pause(s, NOON).phase, PHASE.PAUSED);
  // 空闲状态暂停是空操作
  assert.equal(pause(createPomodoroState(), NOON).phase, PHASE.IDLE);
});

test('番茄钟的剩余时间显示', () => {
  assert.equal(formatRemaining(0), '00:00');
  assert.equal(formatRemaining(65000), '01:05');
  assert.equal(formatRemaining(18 * 60000 + 24000), '18:24');
});

test('番茄钟状态文本', () => {
  const s = start(createPomodoroState(), PHASE.FOCUS, 60000, NOON);
  assert.match(pomodoroText(s, NOON + 30000), /专注中/);
  assert.match(pomodoroText(pause(s, NOON), NOON), /已暂停/);
  assert.match(pomodoroText(createPomodoroState(), NOON), /没有在跑/);
});

test('助理状态：非法输入回退默认值', () => {
  const s = sanitizeAssistant(null);
  assert.equal(s.version, DEFAULT_ASSISTANT.version);
  assert.deepEqual(s.todos, []);
  assert.equal(s.weather.enabled, false);
  assert.equal(s.tts.enabled, false);
  assert.equal(s.chime.enabled, true);
});

test('助理状态：未知字段被丢弃，合法值被保留', () => {
  const s = sanitizeAssistant({
    version: 1,
    todos: [{ id: 'a', text: '买菜', done: false, createdAt: 1 }],
    reminders: [{ id: 'r', text: '喝水', at: 123, createdAt: 1, fired: false }],
    unknownField: 'should be dropped',
    tts: { enabled: true, voiceId: 'male-qn-qingse', speed: 3 },
  });
  assert.equal(s.unknownField, undefined);
  assert.equal(s.todos.length, 1);
  assert.equal(s.reminders.length, 1);
  assert.equal(s.tts.enabled, true);
  assert.equal(s.tts.voiceId, 'male-qn-qingse');
  // 速度被夹到合法区间
  assert.equal(s.tts.speed, 2);
});

test('助理状态：缺字段的待办被丢掉', () => {
  const s = sanitizeAssistant({
    todos: [{ id: 'a', text: '买菜' }, { text: '没有 id' }, null, '乱写'],
  });
  assert.equal(s.todos.length, 1);
  assert.equal(s.todos[0].text, '买菜');
});

test('助理状态：番茄钟的非法阶段回退到空闲', () => {
  const s = sanitizeAssistant({ pomodoro: { phase: '乱写', endsAt: 'soon' } });
  assert.equal(s.pomodoro.phase, 'idle');
  assert.equal(s.pomodoro.endsAt, null);
});

test('补丁合并是深一层的：不会把没提到的字段抹掉', async () => {
  const { mergePatch } = await import('../../src/main/assistant/state.js');
  const before = {
    chime: { enabled: true },
    tts: {
      enabled: false,
      voiceId: 'female-shaonv',
      model: 'speech-02-hd',
      speed: 1,
      vol: 1,
      pitch: 0,
      // 探测出来的可用域名：抹掉就得重新探测一遍
      host: 'https://api.minimaxi.com',
    },
  };
  // 设置窗口送来的 tts 只有三个字段
  const after = mergePatch(before, {
    chime: { enabled: false },
    tts: { enabled: true, voiceId: 'male-qn-qingse', speed: 1.2 },
  });
  assert.equal(after.chime.enabled, false);
  assert.equal(after.tts.enabled, true);
  assert.equal(after.tts.voiceId, 'male-qn-qingse');
  assert.equal(after.tts.speed, 1.2);
  // 没提到的字段必须还在
  assert.equal(after.tts.model, 'speech-02-hd');
  assert.equal(after.tts.host, 'https://api.minimaxi.com');
  // 原对象不能被改
  assert.equal(before.tts.voiceId, 'female-shaonv');
});

test('系统状态：CPU 还没有差值时写「采样中」，不写 0%', async () => {
  const { formatStatus, thermalText, isTooHot } = await import(
    '../../src/main/assistant/systemStatus.js'
  );
  // 第一次采样没有差值 → cpu 为 null。
  // 报 0% 是在说谎：机器可能正忙得冒烟。
  const text = formatStatus({ cpu: null, memory: 23 });
  assert.match(text, /CPU 采样中/);
  assert.ok(!/CPU 0%/.test(text));
  // 有值时就正常显示
  assert.match(formatStatus({ cpu: 42, memory: 23 }), /CPU 42%/);
  assert.match(formatStatus({ cpu: 42, memory: 23 }), /内存 23%/);
  // 电源与温度
  assert.match(formatStatus({ onBattery: true }), /电池供电/);
  assert.match(formatStatus({ onBattery: false }), /已接电/);
  assert.equal(thermalText('serious'), '很热');
  assert.equal(thermalText('unknown'), '未知');
  assert.equal(isTooHot('serious'), true);
  assert.equal(isTooHot('critical'), true);
  assert.equal(isTooHot('fair'), false);
});

test('偏好改动要过一遍规整：内存与磁盘不能不一致', async () => {
  const { mergePatch, sanitizeAssistant } = await import('../../src/main/assistant/state.js');
  const before = {
    version: 1,
    tts: { enabled: false, voiceId: 'v', model: 'speech-02-hd', speed: 1, vol: 1, pitch: 0, host: 'h' },
  };
  // 设置窗口送来一个越界的语速
  const patched = mergePatch(before, { tts: { enabled: true, speed: 0 } });
  const clean = sanitizeAssistant(patched);
  // 越界的值被夹回合法区间（否则它会被直接发给接口）
  assert.equal(clean.tts.speed, 0.5);
  assert.equal(clean.tts.enabled, true);
  // 没提到的字段还在
  assert.equal(clean.tts.model, 'speech-02-hd');
  assert.equal(clean.tts.host, 'h');
});

// ---------------------------------------------------------------------------
// 大模型对话的状态
// ---------------------------------------------------------------------------

test('助理状态：对话配置非法时回退默认值', () => {
  const s = sanitizeAssistant({
    llm: {
      enabled: 'yes',
      baseUrl: 123,
      model: 456,
      temperature: 9,
      maxTokens: 1,
      maxTokensField: '乱写',
      backend: 42,
    },
  });
  assert.equal(s.llm.enabled, true, '与其它开关一样的取值规则（非空即真）');
  assert.equal(s.llm.baseUrl, DEFAULT_LLM.baseUrl);
  assert.equal(s.llm.model, DEFAULT_LLM.model);
  assert.equal(s.llm.temperature, 2, '温度被夹到上限');
  assert.equal(s.llm.maxTokens, 64, '回复长度有下限');
  assert.equal(s.llm.maxTokensField, 'max_tokens');
  assert.equal(s.llm.backend, DEFAULT_LLM.backend);
});

test('助理状态：人设与主动搭话的字段被规整', () => {
  const s = sanitizeAssistant({
    llm: {
      persona: { name: 'x'.repeat(100), style: 42, backstory: '很好' },
      proactive: { enabled: true, minIntervalMs: 1, consecutiveFailures: -3 },
    },
  });
  assert.equal(s.llm.persona.name.length, 40, '名字被截断');
  assert.equal(s.llm.persona.style, DEFAULT_LLM.persona.style);
  assert.equal(s.llm.persona.backstory, '很好');
  assert.equal(s.llm.proactive.enabled, true);
  assert.equal(s.llm.proactive.minIntervalMs, 5 * 60 * 1000, '间隔有下限');
  assert.equal(s.llm.proactive.consecutiveFailures, 0);
});

test('助理状态：聊天记录只留最近 40 条，非法角色被丢掉', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `第${i}条`,
    at: i,
  }));
  messages.push({ role: 'system', text: '越权角色' });
  messages.push({ role: 'user', text: '' });
  const s = sanitizeAssistant({ chat: { messages } });
  assert.equal(s.chat.messages.length, 40);
  assert.equal(s.chat.messages[0].text, '第10条', '留的是最近的');
  assert.ok(!s.chat.messages.some((m) => m.role === 'system'));
  assert.ok(!s.chat.messages.some((m) => m.text === ''));
});

test('助理状态：长期记忆去重并截断', () => {
  const facts = Array.from({ length: 60 }, (_, i) => `事实${i}`);
  facts.push('事实0');
  const s = sanitizeAssistant({ chat: { facts } });
  assert.equal(s.chat.facts.length, 50);
  assert.equal(new Set(s.chat.facts).size, 50, '重复的要去掉');
});

test('聊天记录追加与记忆合并', async () => {
  const { appendMessage, mergeFacts } = await import('../../src/main/assistant/chat/memory.js');
  let messages = [];
  for (let i = 0; i < 45; i += 1) {
    messages = appendMessage(messages, { role: 'user', text: `第${i}条` });
  }
  assert.equal(messages.length, 40);
  assert.equal(messages[0].text, '第5条');

  let facts = mergeFacts([], ['喜欢美式', ' 喜欢美式 ', '写代码']);
  assert.deepEqual(facts, ['喜欢美式', '写代码'], '去空格后重复的算同一条');
  facts = mergeFacts(facts, ['写代码']);
  assert.equal(facts.length, 2, '已有的不该重复加');
});

// 总音量（sound.volume）：提示音与桌宠说话共用一个值。
//
// 越界的**数字**按规格 §9「音量超出 [0,1] → sanitizeAssistant 夹紧」处理：
// 5 夹到 1、-1 夹到 0。非数字（'x'）是**非法值**，回退默认 0.8。
test('sound.volume 被夹进 [0,1]，非法值回退 0.8', () => {
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: 0.5 } }).sound.volume, 0.5);
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: 5 } }).sound.volume, 1);
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: -1 } }).sound.volume, 0);
  assert.equal(sanitizeAssistant({ sound: { enabled: true, volume: 'x' } }).sound.volume, 0.8);
  assert.equal(sanitizeAssistant({}).sound.volume, 0.8);
});
