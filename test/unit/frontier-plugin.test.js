import test from 'node:test';
import assert from 'node:assert/strict';

import createFrontierPlugin from '../../plugins/frontier/main.js';

/**
 * 前沿插件（主进程侧）：切换榜单不能被网络卡住。
 *
 * 网络慢的时候，act('feed') / data() 必须立刻回来（snapshot 里 loading=true），
 * 拉回来的数据通过 push 推给界面；预热过的榜切过来是即时的。
 */

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>量子位文章一</title><link>https://example.com/1</link><pubDate>Mon, 03 Nov 2026 10:00:00 GMT</pubDate></item>
  <item><title>量子位文章二</title><link>https://example.com/2</link><pubDate>Tue, 04 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

/** 一个可以手动放行的 fetch。 */
function deferredFetch() {
  const gates = [];
  const calls = [];
  const fetch = (url) => {
    calls.push(String(url));
    let release;
    const promise = new Promise((resolve) => {
      release = () => resolve({ ok: true, text: async () => RSS });
    });
    gates.push(release);
    return promise;
  };
  return { fetch, calls, gates };
}

function fakeCtx() {
  const pushed = [];
  const updated = [];
  const ctx = {
    push: (data) => pushed.push(data),
    update: (page) => updated.push(page),
  };
  return { ctx, pushed, updated };
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('等超时了');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('切换榜单：网络慢时立刻返回，loading=true，数据到了再推', async () => {
  const originalFetch = globalThis.fetch;
  const d = deferredFetch();
  globalThis.fetch = d.fetch;
  try {
    const plugin = createFrontierPlugin();
    const { ctx, pushed } = fakeCtx();

    // 先切到量子位：这一跳必须立刻回（不等网络）。
    const snap = await plugin.act(ctx, 'feed', { feed: 'qbitai' });
    assert.equal(snap.feed, 'qbitai');
    assert.equal(snap.loading, true, '请求还在路上时 loading 应该是 true');
    assert.equal(snap.items.length, 0);

    // 手动放行网络：数据应该被缓存并推给界面。
    d.gates.forEach((release) => release());
    await waitFor(() => pushed.length > 0, 3000);
    const last = pushed[pushed.length - 1];
    assert.equal(last.loading, false);
    assert.equal(last.items.length, 2);
    assert.equal(last.items[0].title, '量子位文章一');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('切换回预热过的榜：不等网络，直接给缓存数据', async () => {
  const originalFetch = globalThis.fetch;
  const d = deferredFetch();
  globalThis.fetch = d.fetch;
  try {
    const plugin = createFrontierPlugin();
    const { ctx, pushed } = fakeCtx();

    // 首开：预热所有榜（fetch 都会被 delay 住），选中的 qbitai 先热。
    await plugin.act(ctx, 'feed', { feed: 'qbitai' });
    d.gates.forEach((release) => release());
    await waitFor(() => pushed.length > 0, 3000);

    // 切到 HN（同样要等网络），再切回量子位：缓存已热，立刻就有数。
    const hn = await plugin.act(ctx, 'feed', { feed: 'hn-ai' });
    assert.equal(hn.loading, true);
    const back = await plugin.act(ctx, 'feed', { feed: 'qbitai' });
    assert.equal(back.feed, 'qbitai');
    assert.equal(back.loading, false, '缓存新鲜时不该再等网络');
    assert.equal(back.items.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refresh：强制重新拉，且与进行中的请求共用一个', async () => {
  const originalFetch = globalThis.fetch;
  const d = deferredFetch();
  globalThis.fetch = d.fetch;
  try {
    const plugin = createFrontierPlugin();
    const { ctx, pushed } = fakeCtx();

    await plugin.act(ctx, 'feed', { feed: 'qbitai' });
    const before = d.calls.length;
    d.gates.forEach((release) => release());
    await waitFor(() => pushed.length > 0, 3000);

    // 连点两次刷新：只该再发一个请求（进行中共用）。
    const r1 = await plugin.act(ctx, 'refresh');
    const r2 = await plugin.act(ctx, 'refresh');
    assert.equal(r1.loading, true);
    assert.equal(r2.loading, true);
    const qbitaiCalls = d.calls.filter((u) => u === 'https://www.qbitai.com/feed');
    assert.equal(qbitaiCalls.length, before + 1, '连点刷新不该重复发请求');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
