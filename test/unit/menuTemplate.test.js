import test from 'node:test';
import assert from 'node:assert/strict';
import { menuTemplate } from '../../src/main/menuTemplate.js';

function makeActions(overrides = {}) {
  const calls = [];
  return {
    calls,
    toggleVisible: () => calls.push('toggleVisible'),
    openSettings: () => calls.push('openSettings'),
    quit: () => calls.push('quit'),
    toggleClickThrough: () => calls.push('toggleClickThrough'),
    isClickThrough: () => false,
    isDocked: () => false,
    retrievePet: () => calls.push('retrievePet'),
    ...overrides,
  };
}

test('菜单包含显示隐藏、鼠标穿透、设置、退出', () => {
  const tpl = menuTemplate(makeActions());
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ['显示 / 隐藏', '鼠标穿透', '设置…', '退出']);
});

test('点击各菜单项触发对应动作', () => {
  const actions = makeActions();
  const tpl = menuTemplate(actions);
  for (const item of tpl) item.click?.();
  assert.deepEqual(actions.calls, ['toggleVisible', 'toggleClickThrough', 'openSettings', 'quit']);
});

test('「鼠标穿透」是勾选项，且勾选状态反映当前值', () => {
  const on = menuTemplate(makeActions({ isClickThrough: () => true }));
  const item = on.find((i) => i.label === '鼠标穿透');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);

  const off = menuTemplate(makeActions());
  assert.equal(off.find((i) => i.label === '鼠标穿透').checked, false);
});

test('停靠时才出现「取回桌宠」', () => {
  const docked = menuTemplate(makeActions({ isDocked: () => true }));
  const labels = docked.filter((i) => i.label).map((i) => i.label);
  assert.ok(labels.includes('取回桌宠'));

  const free = menuTemplate(makeActions());
  const freeLabels = free.filter((i) => i.label).map((i) => i.label);
  assert.ok(!freeLabels.includes('取回桌宠'));
});

test('点「取回桌宠」触发 retrievePet', () => {
  const actions = makeActions({ isDocked: () => true });
  const tpl = menuTemplate(actions);
  tpl.find((i) => i.label === '取回桌宠').click?.();
  assert.deepEqual(actions.calls, ['retrievePet']);
});
