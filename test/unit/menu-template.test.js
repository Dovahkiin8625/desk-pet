import test from 'node:test';
import assert from 'node:assert/strict';

import { menuTemplate } from '../../src/main/menuTemplate.js';

/** 把菜单拍平成 [label, item] 的清单，方便断言。 */
function flatten(items) {
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...flatten(item.submenu));
  }
  return out;
}

function baseActions(overrides = {}) {
  return {
    toggleVisible() {},
    openSettings() {},
    quit() {},
    toggleClickThrough() {},
    isClickThrough: () => false,
    isDocked: () => false,
    ...overrides,
  };
}

function motionItem(items) {
  return items.find((i) => i.label === '动作');
}

test('没有上报动作清单时，「动作」子菜单只有一项禁用项', () => {
  const items = menuTemplate(baseActions());
  const motion = motionItem(items);
  assert.ok(motion, '菜单里应有「动作」');
  assert.equal(motion.submenu.length, 1);
  assert.equal(motion.submenu[0].label, '暂无可用动作');
  assert.equal(motion.submenu[0].enabled, false);
});

test('单动作组铺成一项时，用动作自己的 label（视频形象的中文名），不是 group 的 key', () => {
  const items = menuTemplate(
    baseActions({
      listMotions: () => [
        { group: 'heart-1', motions: [{ index: 0, label: '比心（双手）1' }] },
        { group: 'dance-1', motions: [{ index: 0, label: '跳舞' }] },
      ],
      playMotion() {},
    }),
  );
  const motion = motionItem(items);
  assert.deepEqual(
    motion.submenu.map((i) => i.label),
    ['比心（双手）1', '跳舞'],
  );
});

test('动作组里只有一个动作：该组直接铺成一项', () => {
  const items = menuTemplate(
    baseActions({
      listMotions: () => [
        { group: 'idle', motions: [{ index: 0, label: 'idle' }] },
        { group: 'attack', motions: [{ index: 0, label: 'attack' }] },
      ],
      playMotion() {},
    }),
  );
  const motion = motionItem(items);
  assert.deepEqual(
    motion.submenu.map((i) => i.label),
    ['idle', 'attack'],
  );
});

test('动作组里有多个动作：该组展开为二级子菜单', () => {
  const items = menuTemplate(
    baseActions({
      listMotions: () => [
        {
          group: 'Idle',
          motions: [
            { index: 0, label: 'haru_g_idle' },
            { index: 1, label: 'haru_g_m15' },
          ],
        },
        { group: 'TapBody', motions: [{ index: 2, label: 'haru_g_m06' }] },
      ],
      playMotion() {},
    }),
  );
  const motion = motionItem(items);
  assert.deepEqual(
    motion.submenu.map((i) => i.label),
    // 单动作组直接用动作的 label（与多动作组二级菜单里的项一致）。
    ['Idle', 'haru_g_m06'],
  );
  assert.deepEqual(
    motion.submenu[0].submenu.map((i) => i.label),
    ['haru_g_idle', 'haru_g_m15'],
  );
});

test('点动作子菜单里的项：回调带上正确的 group 与 index', () => {
  const played = [];
  const items = menuTemplate(
    baseActions({
      listMotions: () => [
        {
          group: 'TapBody',
          motions: [
            { index: 0, label: 'm0' },
            { index: 1, label: 'm1' },
          ],
        },
        { group: 'idle', motions: [{ index: 3, label: 'idle' }] },
      ],
      playMotion: (group, index) => played.push({ group, index }),
    }),
  );
  const motion = motionItem(items);
  const tapBody = motion.submenu.find((i) => i.label === 'TapBody');
  tapBody.submenu[1].click();
  motion.submenu.find((i) => i.label === 'idle').click();
  assert.deepEqual(played, [
    { group: 'TapBody', index: 1 },
    { group: 'idle', index: 3 },
  ]);
});

test('菜单不假设 action 一定提供 playMotion', () => {
  const items = menuTemplate(
    baseActions({
      listMotions: () => [{ group: 'idle', motions: [{ index: 0, label: 'idle' }] }],
    }),
  );
  const motion = motionItem(items);
  // 没提供 playMotion 时，点击不该抛错。
  motion.submenu[0].click?.();
});

test('扁平化后覆盖所有项：包括禁用的占位项', () => {
  const items = menuTemplate(
    baseActions({
      listMotions: () => [{ group: 'Idle', motions: [{ index: 0, label: 'a' }, { index: 1, label: 'b' }] }],
    }),
  );
  const labels = flatten(items).map((i) => i.label);
  assert.ok(labels.includes('动作'));
  assert.ok(labels.includes('Idle'));
  assert.ok(labels.includes('a'));
  assert.ok(labels.includes('b'));
});

test('带 category 的动作按分类分组到子菜单', () => {
  const played = [];
  const items = menuTemplate(
    baseActions({
      listMotions: () => [
        { group: 'idle-nod', category: '待机与呼吸', motions: [{ index: 0, label: '微微点头' }] },
        { group: 'idle-tilt', category: '待机与呼吸', motions: [{ index: 0, label: '歪头' }] },
        { group: 'laugh', category: '开心与喜悦', motions: [{ index: 0, label: '开怀大笑' }] },
      ],
      playMotion: (group, index) => played.push({ group, index }),
    }),
  );
  const motion = motionItem(items);
  assert.deepEqual(motion.submenu.map((i) => i.label), ['待机与呼吸', '开心与喜悦']);
  assert.deepEqual(motion.submenu[0].submenu.map((i) => i.label), ['微微点头', '歪头']);
  assert.deepEqual(motion.submenu[1].submenu.map((i) => i.label), ['开怀大笑']);
  motion.submenu[0].submenu[1].click();
  motion.submenu[1].submenu[0].click();
  assert.deepEqual(played, [
    { group: 'idle-tilt', index: 0 },
    { group: 'laugh', index: 0 },
  ]);
});
