// plugins/clipboard/lib/accelerator.js
/**
 * 全局快捷键的写法。
 *
 * 页面（渲染层）与主进程共用这一份：页面照着它把按键拼成字符串，
 * 主进程照着它检查这个组合能不能用。
 */

/** 修饰键的名字（Electron 那边就是这么写的）。 */
export const MODIFIERS = Object.freeze(['Control', 'Alt', 'Shift', 'Super']);

/**
 * 把一次按键事件翻成 Electron 的快捷键写法。
 *
 * **裸键不要**：只按一个字母会劫持用户所有的字母键。
 *
 * @param {object} event 键盘事件
 * @returns {string} 快捷键字符串；按不出合法组合时是空串
 */
export function accelFromEvent(event) {
  if (!event) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  const code = String(event.code || '');
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F[0-9]{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  // Electron 那边回车键叫 **Return**（不叫 Enter——写错了注册不上）。
  else if (code === 'Enter') key = 'Return';
  else if (code === 'Escape') key = 'Escape';
  else if (code === 'Backspace') key = 'Backspace';
  else if (code === 'Tab') key = 'Tab';
  else if (code.startsWith('Arrow')) {
    key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[code] || '';
  }
  if (!key) return '';
  if (!parts.length) return '';
  return [...parts, key].join('+');
}

/**
 * 这个组合能不能用。
 *
 * 至少要带一个修饰键：裸键会劫持用户所有的字母键。
 *
 * 也**不能全是修饰键**（「Ctrl+Shift」不是一个键）——
 * Electron 注册不了它，报错的话用户看不懂。
 *
 * @param {string} accel
 * @returns {boolean}
 */
export function isValidAccel(accel) {
  const value = String(accel || '').trim();
  if (!value) return false;
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const hasModifier = parts.some((part) => MODIFIERS.includes(part));
  const hasKey = parts.some((part) => !MODIFIERS.includes(part));
  return hasModifier && hasKey;
}

/**
 * 给人看的写法：「Control+Shift+V」→「Ctrl + Shift + V」。
 *
 * @param {string} accel
 * @returns {string}
 */
export function describeAccel(accel) {
  const value = String(accel || '').trim();
  if (!value) return '';
  return value
    .split('+')
    .map((part) => {
      const key = part.trim();
      if (key === 'Control') return 'Ctrl';
      if (key === 'Super') return 'Win';
      if (key === 'Return') return 'Enter';
      if (key === 'Escape') return 'Esc';
      return key;
    })
    .filter(Boolean)
    .join(' + ');
}
