// test/unit/clipboard-recorder.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecorder } from '../../plugins/clipboard/lib/recorder.js';

/** 等一小会儿（让记录器轮询几轮）。 */
function wait(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑一段测试，中途**一定**把记录器停掉。
 *
 * 停不掉的话那个定时器会一直吊着进程——
 * 断言失败时测试就卡在那儿不动了（而不是干脆地失败）。
 */
async function withRecorder(options, body) {
  const recorder = createRecorder(options);
  try {
    await body(recorder);
  } finally {
    recorder.stop();
  }
}

test('复制到新东西时才报一次', async () => {
  let current = '原来的';
  const seen = [];
  await withRecorder(
    { readText: () => current, onText: (text) => seen.push(text), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();
      assert.deepEqual(seen, [], '启动时不报旧内容');

      current = '复制来的';
      await wait();
      assert.deepEqual(seen, ['复制来的'], '报一次');

      await wait();
      assert.deepEqual(seen, ['复制来的'], '没变就不重复报');
    }
  );
});

test('自己贴出去的那一条不算新的复制', async () => {
  let current = '原来的';
  const seen = [];
  await withRecorder(
    { readText: () => current, onText: (text) => seen.push(text), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();

      // 贴一条：先开后门，再写回剪贴板。
      recorder.ignore('贴出去的');
      current = '贴出去的';
      await wait();
      assert.deepEqual(seen, [], '自己贴的没被当成新复制');

      // 用户又复制了别的东西：后门作废，那一条要被记下来。
      current = '用户复制';
      await wait();
      assert.deepEqual(seen, ['用户复制']);
    }
  );
});

test('复制到空不算一条', async () => {
  let current = '有东西';
  const seen = [];
  await withRecorder(
    { readText: () => current, onText: (text) => seen.push(text), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();
      current = '   ';
      await wait();
      assert.deepEqual(seen, [], '空白不算');
    }
  );
});

test('读剪贴板读不出来时当作空字符串', async () => {
  const seen = [];
  await withRecorder(
    {
      readText: () => {
        throw new Error('剪贴板被锁住了');
      },
      onText: (text) => seen.push(text),
      intervalMs: 10,
    },
    async (recorder) => {
      recorder.start();
      await wait();
      assert.deepEqual(seen, [], '读不到就不报');
      assert.equal(recorder.isRunning(), true);
    }
  );
  assert.equal(seen.length, 0);
});

test('读不到的时候不会把「上次看到的内容」忘掉', async () => {
  let fail = true;
  const seen = [];
  await withRecorder(
    {
      readText: () => {
        if (fail) throw new Error('剪贴板被锁住了');
        return '内容';
      },
      onText: (text) => seen.push(text),
      intervalMs: 10,
    },
    async (recorder) => {
      recorder.start();
      // 基准没取到：先让它一直读不到。
      await wait(60);
      assert.deepEqual(seen, [], '读不到就不报');

      // 能读了：基准取到「内容」，之后内容变了才报。
      fail = false;
      await wait(60);
      assert.deepEqual(seen, [], '基准刚取到，不算新的');
    }
  );
});

test('停掉之后就不再读了', async () => {
  let current = '原来的';
  let reads = 0;
  const seen = [];
  const recorder = createRecorder({
    readText: () => {
      reads += 1;
      return current;
    },
    onText: (text) => seen.push(text),
    intervalMs: 10,
  });
  recorder.start();
  await wait();
  recorder.stop();
  const before = reads;
  current = '复制来的';
  await wait();
  assert.equal(reads, before, '停掉之后不再读剪贴板');
  assert.deepEqual(seen, []);
});
