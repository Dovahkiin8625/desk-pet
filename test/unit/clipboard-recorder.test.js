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

/** 用「现在剪贴板里是什么」造一个 grab。 */
function grabFor(box) {
  return () => ({ ok: true, signature: box.current });
}

test('复制到新东西时才报一次', async () => {
  const box = { current: '原来的' };
  const seen = [];
  await withRecorder(
    { grab: grabFor(box), onEntry: (r) => seen.push(r.signature), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();
      assert.deepEqual(seen, [], '启动时不报旧内容');

      box.current = '复制来的';
      await wait();
      assert.deepEqual(seen, ['复制来的'], '报一次');

      await wait();
      assert.deepEqual(seen, ['复制来的'], '没变就不重复报');
    }
  );
});

test('自己贴出去的那一条不算新的复制', async () => {
  const box = { current: '原来的' };
  const seen = [];
  await withRecorder(
    { grab: grabFor(box), onEntry: (r) => seen.push(r.signature), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();

      // 贴一条：先开后门，再写回剪贴板。
      recorder.ignore('贴出去的');
      box.current = '贴出去的';
      await wait();
      assert.deepEqual(seen, [], '自己贴的没被当成新复制');

      // 用户又复制了别的东西：后门作废，那一条要被记下来。
      box.current = '用户复制';
      await wait();
      assert.deepEqual(seen, ['用户复制']);
    }
  );
});

test('贴出去的内容，系统改写了格式之后还能认得出来（后门按读回来的签名保）', async () => {
  // 模拟「写回去之后被系统重写了一遍」：按原样算的签名认不出来，
  // 于是贴完之后插件自己又读了一遍，换成了「系统里实际长什么样」的签名。
  const box = { current: '原来的' };
  const seen = [];
  await withRecorder(
    { grab: grabFor(box), onEntry: (r) => seen.push(r.signature), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();

      // 先按原样开后门（像 pasteEntry 第一步那样）。
      recorder.ignore('原样的');
      // 再换成「读回来的样子」的签名（像 pasteEntry 写完之后那样）。
      recorder.ignore('系统重写的');
      box.current = '系统重写的';
      await wait();
      assert.deepEqual(seen, [], '重写之后的那条也没被当成新复制');
    }
  );
});

test('贴出去后的保护期：任何签名都当回声', async () => {
  const box = { current: '原来的' };
  const seen = [];
  await withRecorder(
    { grab: grabFor(box), onEntry: (r) => seen.push(r.signature), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();

      // 开保护期：不管读回来什么签名都当「自己贴的回声」。
      recorder.muzzle(400);
      box.current = '系统重写出来的回声';
      await wait();
      assert.deepEqual(seen, [], '保护期内不算新复制');

      // 保护期过后：同一条内容再也不报（lastSignature 已经记了）。
      await new Promise((resolve) => setTimeout(resolve, 450));
      await wait();
      assert.deepEqual(seen, [], '保护期过了也不报同一条内容');

      // 保护期之后用户又复制了：正常报。
      box.current = '用户又复制了';
      await wait();
      assert.deepEqual(seen, ['用户又复制了']);
    }
  );
});

test('复制到空不算一条', async () => {
  const box = { current: '有东西' };
  const seen = [];
  await withRecorder(
    { grab: grabFor(box), onEntry: (r) => seen.push(r.signature), intervalMs: 10 },
    async (recorder) => {
      recorder.start();
      await wait();
      box.current = '';
      await wait();
      assert.deepEqual(seen, [], '空签名不算');
    }
  );
});

test('读剪贴板读不出来时当作读不到', async () => {
  const seen = [];
  await withRecorder(
    {
      grab: () => {
        throw new Error('剪贴板被锁住了');
      },
      onEntry: (r) => seen.push(r.signature),
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
  const box = { current: '内容' };
  await withRecorder(
    {
      grab: () => {
        if (fail) throw new Error('剪贴板被锁住了');
        return { ok: true, signature: box.current };
      },
      onEntry: (r) => seen.push(r.signature),
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

test('内容太大跳过、但照样记住「看过了」', async () => {
  const box = { current: 'big-signature' };
  const seen = [];
  await withRecorder(
    {
      grab: () => ({ ok: true, signature: box.current, tooBig: true }),
      onEntry: (r) => seen.push(r.signature),
      intervalMs: 10,
    },
    async (recorder) => {
      recorder.start();
      await wait();
      // 基准是启动时取的：看到的那一条要报一次（由 onEntry 自己决定不记）。
      assert.deepEqual(seen, [], '与基准一样，不报');

      // 内容「变了」（哪怕只是又复制了一个同样大的东西）：签名没变就不重复报。
      await wait();
      assert.deepEqual(seen, [], '签名没变，不重复报');
    }
  );
});

test('停掉之后就不再读了', async () => {
  const box = { current: '原来的' };
  let reads = 0;
  const seen = [];
  const recorder = createRecorder({
    grab: () => {
      reads += 1;
      return { ok: true, signature: box.current };
    },
    onEntry: (r) => seen.push(r.signature),
    intervalMs: 10,
  });
  recorder.start();
  await wait();
  recorder.stop();
  const before = reads;
  box.current = '复制来的';
  await wait();
  assert.equal(reads, before, '停掉之后不再读剪贴板');
  assert.deepEqual(seen, []);
});
