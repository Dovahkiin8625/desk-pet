// 系统提示词与回复解析的单元测试（时间锚点 + 开头时间标记）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSystemPrompt,
  createStreamSplitter,
  nowLine,
  parseReply,
  stripLeadingTimePrefix,
  buildChatMessages,
} from '../../src/main/assistant/chat/prompt.js';
import { buildAgentSystemPrompt } from '../../src/main/assistant/agent/prompt.js';
import { dayPeriod } from '../../src/main/assistant/clock.js';

/** 固定一个周日的下午。 */
const AFTERNOON = new Date('2026-11-15T15:42:00');

test('dayPeriod：时段说法按小时划分', () => {
  assert.equal(dayPeriod(new Date('2026-11-15T03:00:00')), '深夜');
  assert.equal(dayPeriod(new Date('2026-11-15T08:00:00')), '早上');
  assert.equal(dayPeriod(new Date('2026-11-15T10:00:00')), '上午');
  assert.equal(dayPeriod(new Date('2026-11-15T12:00:00')), '中午');
  assert.equal(dayPeriod(new Date('2026-11-15T15:00:00')), '下午');
  assert.equal(dayPeriod(new Date('2026-11-15T18:00:00')), '傍晚');
  assert.equal(dayPeriod(new Date('2026-11-15T21:00:00')), '晚上');
  assert.equal(dayPeriod(new Date('2026-11-15T23:00:00')), '深夜');
});

test('nowLine：直接写出时段词与星期', () => {
  const line = nowLine(AFTERNOON);
  assert.match(line, /2026 年 11 月 15 日/);
  assert.match(line, /星期日/);
  assert.match(line, /下午 15:42/);
});

test('buildSystemPrompt：时间那一行带时段词', () => {
  const system = buildSystemPrompt({ now: AFTERNOON });
  assert.match(system, /下午 15:42/);
});

test('buildAgentSystemPrompt：时间那一行带时段词', () => {
  const system = buildAgentSystemPrompt({ now: AFTERNOON });
  assert.match(system, /下午 15:42/);
});

test('stripLeadingTimePrefix：去掉模型抄进来的「[N 分钟前]」', () => {
  assert.equal(stripLeadingTimePrefix('[31 分钟前] 夜深啦'), '夜深啦');
  assert.equal(stripLeadingTimePrefix('[刚刚] 你好'), '你好');
  assert.equal(stripLeadingTimePrefix('[2 小时前] 在吗'), '在吗');
  assert.equal(stripLeadingTimePrefix('[3 天前] 在吗'), '在吗');
  assert.equal(stripLeadingTimePrefix('没有前缀'), '没有前缀');
});

test('parseReply：开头的时间标记不进正文', () => {
  const parsed = parseReply('[31 分钟前] 夜深啦，早点睡喵\n\n<<META>>{"emotion":"tired","mood":0,"memories":[]}');
  assert.equal(parsed.text, '夜深啦，早点睡喵');
  assert.equal(parsed.emotion, 'tired');
});

test('parseReply：action 读出来，缺省为空串', () => {
  const withAction = parseReply('笑一个<<META>>{"emotion":"happy","mood":5,"action":"laugh","memories":[]}');
  assert.equal(withAction.action, 'laugh');
  const without = parseReply('笑一个<<META>>{"emotion":"happy","mood":5,"memories":[]}');
  assert.equal(without.action, '');
  // 非法形态：不是字符串就丢掉。
  const bogus = parseReply('笑一个<<META>>{"emotion":"happy","mood":5,"action":42,"memories":[]}');
  assert.equal(bogus.action, '');
});

test('buildAgentSystemPrompt：clip 清单带进提示词，点播契约也写进 META 说明', () => {
  const system = buildAgentSystemPrompt({
    clips: [
      { id: 'sleepy', label: '犯困打瞌睡', category: 'emotion', semantic: 'tired' },
      { id: 'dance-1', label: '跳舞', category: 'action' },
    ],
  });
  assert.match(system, /你能做出的动作/);
  assert.match(system, /sleepy=犯困打瞌睡/);
  assert.match(system, /dance-1=跳舞/);
  assert.match(system, /"action"/);
});

test('buildSystemPrompt：clip 清单带进提示词', () => {
  const system = buildSystemPrompt({
    clips: [{ id: 'greet', label: '挥手打招呼', category: 'action' }],
  });
  assert.match(system, /greet=挥手打招呼/);
});

test('buildChatMessages：ambient 触发用自发反应的话术', () => {
  const messages = buildChatMessages({ history: [], trigger: 'ambient', now: AFTERNOON });
  assert.match(messages.at(-1).content, /自发反应/);
  assert.match(messages.at(-1).content, /正文留空/);
});

test('createStreamSplitter：标记跨 chunk 也能认出来', () => {
  const splitter = createStreamSplitter();
  let out = '';
  out += splitter.push('[31 分');
  out += splitter.push('钟前] 夜深啦');
  out += splitter.push('，早点睡');
  out += splitter.finish();
  assert.equal(out, '夜深啦，早点睡');
});

test('createStreamSplitter：没有时间标记时不少字', () => {
  const splitter = createStreamSplitter();
  let out = '';
  out += splitter.push('下午好呀');
  out += splitter.push('，继续加油');
  out += splitter.finish();
  assert.equal(out, '下午好呀，继续加油');
});

test('createStreamSplitter：开头是别的括号不当成时间标记', () => {
  const splitter = createStreamSplitter();
  let out = '';
  out += splitter.push('[注] 这是正文');
  out += splitter.finish();
  assert.equal(out, '[注] 这是正文');
});
