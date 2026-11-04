/**
 * 全局快捷键的「槽位」。
 *
 * 每个槽位 = 一个设置字段 + 一个全局快捷键 + 一份状态。
 * 两个槽位共用同一套「录制 → 注册 → 注销」的流程，
 * 差别只在按下去之后做什么（见 main/system.js 的 hotkeyActions）。
 *
 * 清单放在 shared/ 是因为**两边都要知道它**：
 * 设置文件用它决定默认值与校验规则，主进程用它决定注册哪一个键。
 * 抄一份的后果是设置里多出一个字段、主进程却不知道要注册它——
 * 界面上写着「已设置」，按下去什么也不发生。
 */

/**
 * 槽位清单。
 *
 * `allowEmpty` 表示「空值是合法的」：空 = 这个快捷键**不设**。
 * 「呼出 / 隐藏桌宠」那个不允许空——空了等于没有召回手段。
 */
export const HOTKEY_SLOTS = Object.freeze([
  Object.freeze({
    key: 'hotkey',
    label: '呼出 / 隐藏桌宠',
    defaultValue: 'Control+Shift+D',
    allowEmpty: false,
  }),
  Object.freeze({
    key: 'panelHotkey',
    label: '唤醒输入框',
    // 默认**不设**：多抢一个全局组合不是用户要求的行为，
    // 要用的时候自己去设置里录一个。
    defaultValue: '',
    allowEmpty: true,
  }),
]);

/** 槽位的字段名清单。 */
export const HOTKEY_SLOT_KEYS = Object.freeze(HOTKEY_SLOTS.map((s) => s.key));

/**
 * 按字段名取槽位。
 *
 * 认不出来就返回 null：槽位名是**从渲染层传进来的**（录快捷键时带的），
 * 不能因为一个陌生名字就把设置写坏。
 */
export function getHotkeySlot(key) {
  if (typeof key !== 'string') return null;
  return HOTKEY_SLOTS.find((s) => s.key === key) || null;
}
