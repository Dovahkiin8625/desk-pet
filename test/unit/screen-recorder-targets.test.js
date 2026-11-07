// 录屏插件的目标缓存。
//
// 这里守的是一个真实的坑：**模式有三个，目标只有两类**。
// 全屏与选区用的都是显示器，只有窗口模式用的是窗口。
// 早先拿模式直接当下标，选区模式就去找一个根本不存在的桶，
// 取数据时炸成「Cannot read properties of undefined (reading 'length')」——
// 而配置里的模式还停在选区，于是**每次打开录屏都炸**。
import test from 'node:test';
import assert from 'node:assert/strict';

import { targetKind, createTargetCache } from '../../plugins/screen-recorder/lib/targets.js';

test('选区模式用的是显示器那一类目标', () => {
  assert.equal(targetKind('screen'), 'screen');
  assert.equal(targetKind('region'), 'screen', '选区是在某块显示器上框的');
  assert.equal(targetKind('window'), 'window');
  // 认不出的模式别炸：退回显示器（列表空着就空着）。
  assert.equal(targetKind('投影仪'), 'screen');
  assert.equal(targetKind(undefined), 'screen');
});

test('选区模式列目标：列的是显示器，不会去找不存在的桶', async () => {
  const cache = createTargetCache();
  const kinds = [];
  const { list, listed } = await cache.load('region', async (kind) => {
    kinds.push(kind);
    return [{ id: 'screen:0:0', label: '屏幕 1' }];
  });
  assert.deepEqual(kinds, ['screen'], '列的是显示器');
  assert.equal(listed, true);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, '屏幕 1');
});

test('全屏与选区共用一份显示器列表：切来切去不重新列', async () => {
  const cache = createTargetCache();
  let count = 0;
  const lister = async (kind) => {
    count += 1;
    return [{ id: `${kind}:1`, label: kind }];
  };
  await cache.load('screen', lister);
  const second = await cache.load('region', lister);
  assert.equal(count, 1, '两个模式共用一个桶，只列一次');
  assert.equal(second.listed, false, '没重列');
  assert.equal(second.list[0].id, 'screen:1');
});

test('窗口模式列的是窗口那一类', async () => {
  const cache = createTargetCache();
  const kinds = [];
  await cache.load('window', async (kind) => {
    kinds.push(kind);
    return [{ id: 'window:7:0', label: '记事本' }];
  });
  assert.deepEqual(kinds, ['window']);
  assert.equal(cache.get('window')[0].label, '记事本');
  // 窗口模式拿不到显示器那一类。
  assert.deepEqual(cache.get('screen'), []);
});

test('强制刷新：重新列一遍', async () => {
  const cache = createTargetCache();
  let count = 0;
  const lister = async () => {
    count += 1;
    return [{ id: `screen:${count}`, label: `屏幕 ${count}` }];
  };
  await cache.load('screen', lister);
  const { listed } = await cache.load('screen', lister, { force: true });
  assert.equal(count, 2, '刷新要真的再列一次');
  assert.equal(listed, true);
  assert.equal(cache.get('screen')[0].label, '屏幕 2');
});

test('列目标失败：空列表，不抛错', async () => {
  const cache = createTargetCache();
  const { list, listed } = await cache.load('region', async () => {
    throw new Error('系统不给了');
  });
  assert.equal(listed, true);
  assert.deepEqual(list, [], '列不出来就是空列表，界面照样能用');
});

test('列回来的不是数组：当作空列表', async () => {
  const cache = createTargetCache();
  const { list } = await cache.load('screen', async () => undefined);
  assert.deepEqual(list, []);
});

test('同时列同一类：只列一次，两边拿到同一份', async () => {
  // 面板与独立窗口可能同时打开录屏：两边各列一遍就是白花的半秒
  //（列目标要 0.4 秒上下，而缓存是「列完了才有」）。
  const cache = createTargetCache();
  let count = 0;
  const lister = async (kind) => {
    count += 1;
    // 慢一点，让两次调用真的撞在一起
    await new Promise((r) => setTimeout(r, 20));
    return [{ id: `${kind}:1`, label: kind }];
  };
  const [a, b] = await Promise.all([cache.load('screen', lister), cache.load('region', lister)]);
  assert.equal(count, 1, '同一类的两次列，共享一次');
  assert.deepEqual(a.list, b.list);
  assert.equal(a.listed, true, '发起的那次算「列了」');
  assert.equal(b.listed, false, '搭便车的那次不算——图标之类只做一次');
});

test('同时列不同的两类：各列一次，互不干扰', async () => {
  const cache = createTargetCache();
  const kinds = [];
  const lister = async (kind) => {
    kinds.push(kind);
    await new Promise((r) => setTimeout(r, 10));
    return [{ id: `${kind}:1`, label: kind }];
  };
  await Promise.all([cache.load('screen', lister), cache.load('window', lister)]);
  assert.deepEqual(kinds.sort(), ['screen', 'window']);
  assert.equal(cache.get('screen').length, 1);
  assert.equal(cache.get('window').length, 1);
});
