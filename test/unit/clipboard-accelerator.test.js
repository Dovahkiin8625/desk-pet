// test/unit/clipboard-accelerator.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODIFIERS,
  accelFromEvent,
  describeAccel,
  isValidAccel,
} from '../../plugins/clipboard/lib/accelerator.js';

/** 造一次按键。 */
function key(code, mods = {}) {
  return { code, ...mods };
}

test('按键 → 快捷键写法', () => {
  assert.equal(accelFromEvent(key('KeyV', { ctrlKey: true })), 'Control+V');
  assert.equal(
    accelFromEvent(key('KeyV', { ctrlKey: true, shiftKey: true })),
    'Control+Shift+V',
    '修饰键的顺序是固定的'
  );
  assert.equal(accelFromEvent(key('KeyB', { ctrlKey: true, altKey: true })), 'Control+Alt+B');
  assert.equal(accelFromEvent(key('Digit7', { ctrlKey: true })), 'Control+7');
  assert.equal(accelFromEvent(key('F5', { ctrlKey: true })), 'Control+F5');
  assert.equal(accelFromEvent(key('Space', { altKey: true })), 'Alt+Space');
  assert.equal(accelFromEvent(key('ArrowUp', { ctrlKey: true })), 'Control+Up');
  assert.equal(accelFromEvent(key('Enter', { ctrlKey: true })), 'Control+Return', '回车键叫 Return');
});

test('裸键不要：它会劫持用户所有的字母键', () => {
  assert.equal(accelFromEvent(key('KeyV')), '');
  assert.equal(accelFromEvent(key('Digit1')), '');
  assert.equal(accelFromEvent(key('Space')), '');
});

test('认不出来的键就是空串', () => {
  assert.equal(accelFromEvent(key('CapsLock', { ctrlKey: true })), '');
  assert.equal(accelFromEvent(null), '');
  assert.equal(accelFromEvent(undefined), '');
});

test('这个组合能不能用', () => {
  assert.equal(isValidAccel('Control+Shift+V'), true);
  assert.equal(isValidAccel('Alt+F4'), true);
  assert.equal(isValidAccel('Super+V'), true);
  assert.equal(isValidAccel('V'), false, '裸键不行');
  assert.equal(isValidAccel('Control'), false, '只有修饰键不行');
  assert.equal(isValidAccel(''), false);
  assert.equal(isValidAccel('   '), false);
  assert.equal(isValidAccel(null), false);
  assert.equal(isValidAccel('Control+Shift'), false, '没有主键不行');
});

test('修饰键就那几个', () => {
  assert.deepEqual([...MODIFIERS], ['Control', 'Alt', 'Shift', 'Super']);
});

test('给人看的写法', () => {
  assert.equal(describeAccel('Control+Shift+V'), 'Ctrl + Shift + V');
  assert.equal(describeAccel('Super+V'), 'Win + V');
  assert.equal(describeAccel('Control+Return'), 'Ctrl + Enter');
  assert.equal(describeAccel(''), '');
  assert.equal(describeAccel(null), '');
});
