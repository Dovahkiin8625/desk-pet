import test from 'node:test';
import assert from 'node:assert/strict';

import { nextCronTime, parseCron } from '../../plugins/scheduler/lib/cron.js';
import {
  describeSchedule,
  formatTime,
  nextRunAt,
  normalizeSchedule,
  parseScheduleText,
  parseTimeOfDay,
} from '../../plugins/scheduler/lib/schedule.js';

/**
 * 定时任务的时间算法。
 *
 * 这些是纯函数：算错一次，用户就会在半夜被吵醒，或者该跑的时候没跑。
 */

test('cron：每天九点', () => {
  const parsed = parseCron('0 9 * * *');
  assert.equal(parsed.ok, true);
  const next = nextCronTime(parsed.value, new Date(2026, 0, 1, 8, 0, 0));
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 1);
});

test('cron：过了就等明天', () => {
  const parsed = parseCron('0 9 * * *');
  const next = nextCronTime(parsed.value, new Date(2026, 0, 1, 10, 0, 0));
  assert.equal(next.getDate(), 2);
  assert.equal(next.getHours(), 9);
});

test('cron：工作日的早上九点', () => {
  // 2026-01-03 是周六 → 下一次是周一 1 月 5 日。
  const parsed = parseCron('0 9 * * 1-5');
  const next = nextCronTime(parsed.value, new Date(2026, 0, 3, 12, 0, 0));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 5);
});

test('cron：每 15 分钟', () => {
  const parsed = parseCron('*/15 * * * *');
  const next = nextCronTime(parsed.value, new Date(2026, 0, 1, 8, 1, 0));
  assert.equal(next.getMinutes(), 15);
});

test('cron：日与周都写了就取并集', () => {
  // 1 号或者周一，哪个先来算哪个。
  const parsed = parseCron('0 0 1 * 1');
  const next = nextCronTime(parsed.value, new Date(2026, 0, 2, 12, 0, 0));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 5);
});

test('cron：段数不对要说清楚', () => {
  const parsed = parseCron('0 9 * *');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /5 段/);
});

test('cron：值不合法要说清楚', () => {
  const parsed = parseCron('0 99 * * *');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /取值|取值不合法/);
});

test('schedule：间隔', () => {
  const s = normalizeSchedule({ kind: 'interval', everyMinutes: 30 });
  assert.deepEqual(s.value, { kind: 'interval', everyMinutes: 30 });
  assert.equal(nextRunAt(s.value, 1000), 1000 + 30 * 60 * 1000);
});

test('schedule：间隔至少一分钟', () => {
  const s = normalizeSchedule({ kind: 'interval', everyMinutes: 0 });
  assert.equal(s.ok, false);
});

test('schedule：每天几点', () => {
  const s = normalizeSchedule({ kind: 'daily', at: '9:05' });
  assert.deepEqual(s.value, { kind: 'daily', at: '09:05' });
  const base = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const at = new Date(nextRunAt(s.value, base));
  assert.equal(at.getHours(), 9);
  assert.equal(at.getMinutes(), 5);
  // 已经过了 → 明天。
  const late = new Date(2026, 0, 1, 10, 0, 0).getTime();
  assert.equal(new Date(nextRunAt(s.value, late)).getDate(), 2);
});

test('schedule：时间写歪了要说清楚', () => {
  const s = normalizeSchedule({ kind: 'daily', at: '25:00' });
  assert.equal(s.ok, false);
  assert.match(s.error, /HH:MM/);
});

test('schedule：说人话', () => {
  assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 30 }), '每隔 30 分钟');
  assert.equal(describeSchedule({ kind: 'daily', at: '09:00' }), '每天 09:00');
  assert.equal(describeSchedule({ kind: 'cron', expr: '0 9 * * *' }), 'cron 0 9 * * *');
});

test('schedule：时刻分今天明天后天', () => {
  const now = new Date(2026, 0, 1, 8, 0, 0).getTime();
  assert.match(formatTime(new Date(2026, 0, 1, 9, 0, 0).getTime(), now), /^今天 /);
  assert.match(formatTime(new Date(2026, 0, 2, 9, 0, 0).getTime(), now), /^明天 /);
  assert.match(formatTime(new Date(2026, 0, 3, 9, 0, 0).getTime(), now), /^后天 /);
});

test('schedule：自然语言 → 定时方式', () => {
  assert.deepEqual(parseScheduleText('每隔 30 分钟').value, {
    kind: 'interval',
    everyMinutes: 30,
  });
  assert.deepEqual(parseScheduleText('每隔 2 小时').value, {
    kind: 'interval',
    everyMinutes: 120,
  });
  assert.deepEqual(parseScheduleText('每天 09:00').value, { kind: 'daily', at: '09:00' });
  assert.deepEqual(parseScheduleText('每天九点').value, { kind: 'daily', at: '09:00' });
  assert.deepEqual(parseScheduleText('0 9 * * 1-5').value, {
    kind: 'cron',
    expr: '0 9 * * 1-5',
  });
});

test('schedule：自然语言里的每周几变成 cron', () => {
  const r = parseScheduleText('每周一三五 09:00');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { kind: 'cron', expr: '0 9 * * 1,3,5' });
});

test('schedule：看不懂就说清楚', () => {
  const r = parseScheduleText('有空的时候');
  assert.equal(r.ok, false);
  assert.match(r.error, /没看懂定时方式/);
});

test('schedule：时刻认几种写法', () => {
  assert.equal(parseTimeOfDay('09:30'), '09:30');
  assert.equal(parseTimeOfDay('9：30'), '09:30');
  assert.equal(parseTimeOfDay('9点'), '09:00');
  assert.equal(parseTimeOfDay('9点30分'), '09:30');
  assert.equal(parseTimeOfDay('十点半'), '10:30');
  assert.equal(parseTimeOfDay('随便什么时候'), null);
});
