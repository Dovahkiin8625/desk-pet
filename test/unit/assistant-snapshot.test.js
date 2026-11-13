import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshotLines, snapshotSection } from '../../src/main/assistant/snapshot.js';
import {
  PROACTIVE_TRIGGER,
  buildHistoryMessages,
  buildChatMessages,
} from '../../src/main/assistant/chat/prompt.js';
import { buildInteractionPrompt } from '../../src/main/assistant/layer/prompt.js';
import { LAYER } from '../../src/shared/assistant.js';

/**
 * 「此刻正在发生的事」。
 *
 * 主动搭话全靠它：没有这一段，模型只能从历史里挖一件早就结束的事
 * 当成现状（用户早就手动停掉的音乐，被说成「还在播放」）。
 */

const NOW = Date.UTC(2026, 0, 2, 10, 0, 0);

test('快照：专注在跑就说专注在跑', () => {
  const lines = buildSnapshotLines({
    state: {
      pomodoro: {
        phase: 'focus',
        endsAt: NOW + 12 * 60 * 1000,
        remainingMs: 12 * 60 * 1000,
        durationMs: 25 * 60 * 1000,
        label: '',
      },
    },
    now: NOW,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^在专注，还剩 12:00$/);
});

test('快照：没在跑的事一条都不写', () => {
  const lines = buildSnapshotLines({
    state: { pomodoro: { phase: 'idle' }, todos: [], reminders: [], weather: {} },
    now: NOW,
  });
  assert.deepEqual(lines, []);
});

test('快照：待办只数没做完的', () => {
  const lines = buildSnapshotLines({
    state: {
      todos: [
        { id: '1', text: '写周报', done: false },
        { id: '2', text: '买菜', done: false },
        { id: '3', text: '遛狗', done: true },
      ],
    },
    now: NOW,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /还有 2 件事没做完/);
  assert.match(lines[0], /写周报/);
});

test('快照：提醒只留最近的那个，已经响过的不算', () => {
  const lines = buildSnapshotLines({
    state: {
      reminders: [
        { id: 'a', text: '开会', at: NOW - 60_000, fired: false },
        { id: 'b', text: '取快递', at: NOW + 30 * 60 * 1000, fired: false },
        { id: 'c', text: '喝水', at: NOW + 60 * 60 * 1000, fired: true },
      ],
    },
    now: NOW,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /取快递/);
  assert.doesNotMatch(lines[0], /开会/);
});

test('快照：天气缓存太旧就不算数了', () => {
  const fresh = buildSnapshotLines({
    state: { weather: { last: { city: '北京', text: '晴', temperature: 26, at: NOW - 10 * 60_000 } } },
    now: NOW,
  });
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /北京/);

  const stale = buildSnapshotLines({
    state: { weather: { last: { city: '北京', text: '晴', temperature: 26, at: NOW - 3 * 3600_000 } } },
    now: NOW,
  });
  assert.deepEqual(stale, []);
});

test('快照：电池与温度只在值得说的时候写', () => {
  const lines = buildSnapshotLines({
    state: {},
    now: NOW,
    onBattery: true,
    thermal: 'critical',
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /电池/);
  assert.match(lines[1], /很热/);

  const plugged = buildSnapshotLines({
    state: {},
    now: NOW,
    onBattery: false,
    thermal: 'nominal',
  });
  assert.deepEqual(plugged, []);
});

test('快照那一段：空的时候要说「看不到」，不能写成「什么都没发生」', () => {
  const section = snapshotSection([]);
  assert.match(section, /此刻正在发生的事/);
  assert.match(section, /看不到什么特别的事/);
  // 「没写到的只是我不知道」——不然模型会当成「它没在发生」。
  assert.match(section, /只是我不知道/);
});

test('快照那一段：每条都列出来', () => {
  const section = snapshotSection(['在专注，还剩 12:00', '还有 2 件事没做完']);
  assert.match(section, /- 在专注，还剩 12:00/);
  assert.match(section, /- 还有 2 件事没做完/);
});

// ---------------------------------------------------------------------------
// 时态：历史是过去，「此刻」才是现在
// ---------------------------------------------------------------------------

test('历史：每条都带相对时间', () => {
  const history = [
    { id: '1', role: 'user', kind: 'user', text: '放首歌', at: NOW - 12 * 60_000 },
    { id: '2', role: 'assistant', kind: 'reply', text: '好', at: NOW - 30_000 },
  ];
  const messages = buildHistoryMessages({ history, layer: LAYER.INTERACTION, now: NOW });
  assert.equal(messages[0].content, '[12 分钟前] 放首歌');
  assert.equal(messages[1].content, '[刚刚] 好');
});

test('历史：没有时间戳就不加前缀', () => {
  const history = [{ id: '1', role: 'user', kind: 'user', text: '放首歌' }];
  const messages = buildHistoryMessages({ history, layer: LAYER.INTERACTION, now: NOW });
  assert.equal(messages[0].content, '放首歌');
});

test('主动搭话：触发语要立住「历史是过去」这条规矩', () => {
  assert.match(PROACTIVE_TRIGGER, /此刻正在发生的事/);
  assert.match(PROACTIVE_TRIGGER, /已经过去了/);
  // 旧的话术是在**邀请**模型从历史里挖由头。
  assert.doesNotMatch(PROACTIVE_TRIGGER, /找个由头/);

  const messages = buildChatMessages({ history: [], trigger: 'proactive', now: NOW });
  assert.equal(messages.at(-1).content, PROACTIVE_TRIGGER);
});

test('交互层提示词：「此刻」那一段要进提示词', () => {
  const system = buildInteractionPrompt({ snapshot: ['在专注，还剩 12:00'] });
  assert.match(system, /此刻正在发生的事/);
  assert.match(system, /在专注，还剩 12:00/);
});
