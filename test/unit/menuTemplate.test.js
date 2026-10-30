import test from 'node:test';
import assert from 'node:assert/strict';
import { menuTemplate } from '../../src/main/menuTemplate.js';

function makeActions() {
  const calls = [];
  return {
    calls,
    toggleVisible: () => calls.push('toggleVisible'),
    openSettings: () => calls.push('openSettings'),
    quit: () => calls.push('quit'),
  };
}

test('菜单包含显示隐藏、设置、退出三项', () => {
  const tpl = menuTemplate(makeActions());
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels, ['显示 / 隐藏', '设置…', '退出']);
});

test('点击各菜单项触发对应动作', () => {
  const actions = makeActions();
  const tpl = menuTemplate(actions);
  for (const item of tpl) item.click?.();
  assert.deepEqual(actions.calls, ['toggleVisible', 'openSettings', 'quit']);
});
