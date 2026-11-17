// test/unit/clipboard-tracker.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createClipboardTracker } from '../../src/main/clipboardTracker.js';

/** 等一小会儿（让跟踪器轮询几轮）。 */
function wait(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTracker(options, body) {
  const tracker = createClipboardTracker(options);
  try {
    await body(tracker);
  } finally {
    tracker.stop();
  }
}

function grabFor(box) {
  return () => box.current;
}

test('启动时不记成「刚复制的」', async () => {
  const box = { current: '原来的' };
  await withTracker({ grab: grabFor(box), intervalMs: 10 }, async (tracker) => {
    tracker.start();
    await wait();
    assert.equal(tracker.changedAt(), 0);
  });
});

test('复制新内容后会记下变化时刻', async () => {
  const box = { current: '原来的' };
  await withTracker({ grab: grabFor(box), intervalMs: 10 }, async (tracker) => {
    tracker.start();
    await wait();

    box.current = '复制来的';
    await wait();
    const t = tracker.changedAt();
    assert.ok(t > 0, '记下了变化时刻');
    assert.ok(Date.now() - t < 5000, '变化时刻是最近的');

    // 内容没再变：时刻不动。
    await wait();
    assert.equal(tracker.changedAt(), t);
  });
});

test('读不到剪贴板时不算变化', async () => {
  const box = { current: '原来的', ok: true };
  const grab = () => (box.ok ? box.current : Promise.reject(new Error('locked')));
  await withTracker({ grab, intervalMs: 10 }, async (tracker) => {
    tracker.start();
    await wait();

    box.ok = false;
    box.current = '复制来的';
    await wait();
    assert.equal(tracker.changedAt(), 0, '读不到时不记变化');

    box.ok = true;
    await wait();
    assert.ok(tracker.changedAt() > 0, '读得到之后记下变化');
  });
});
