/**
 * 「工具」页的批量操作。
 *
 * 这里只放**纯逻辑**：算新的名单，不碰 DOM。
 *
 * 界面（src/settings/main.js）负责画与存，纯函数负责算——
 * 这样「批量改完名单变成什么样」这件事能单独测，
 * 不用为了验一个名单的变化去开整个设置窗口。
 */

/**
 * 审批等级的两个取值。
 *
 * 与抽屉里的下拉框一致：`ask` = 每次都问，
 * `always` = 以后不问（进「永久放行」的名单）。
 */
export const TOOL_APPROVAL = Object.freeze({
  /** 每次都问。 */
  ASK: 'ask',
  /** 以后不问。 */
  ALWAYS: 'always',
});

/**
 * 批量开关工具。
 *
 * @param {Iterable<string>} selected 选中的工具名
 * @param {boolean} enabled true = 批量开启，false = 批量关闭
 * @param {Iterable<string>} disabled 现在被关掉的工具名
 * @returns {Set<string>} 新的「关掉的工具」名单
 */
export function applyBatchEnabled(selected, enabled, disabled) {
  const out = new Set(disabled);
  for (const name of selected) {
    if (enabled) out.delete(name);
    else out.add(name);
  }
  return out;
}

/**
 * 批量设审批等级。
 *
 * 名单只记「以后不问」的那些工具，所以设成「每次询问」
 * 就是把它从名单里去掉——两件事是同一个名单的正反面。
 *
 * @param {Iterable<string>} selected 选中的工具名
 * @param {string} value `always` = 以后不问，其余一律当「每次询问」
 * @param {Iterable<string>} allowAlways 现在「以后不问」的工具名
 * @returns {Set<string>} 新的「以后不问」名单
 */
export function applyBatchApproval(selected, value, allowAlways) {
  const out = new Set(allowAlways);
  const always = String(value) === TOOL_APPROVAL.ALWAYS;
  for (const name of selected) {
    if (always) out.add(name);
    else out.delete(name);
  }
  return out;
}

/**
 * 「全选」那个勾选框现在该是什么样子。
 *
 * `all` 为真时打勾，为假但有人选过时打半勾（indeterminate）——
 * 只显示成「没勾」的话，用户不知道自己已经选了一部分。
 *
 * @param {string[]} names 当前看得见的工具名
 * @param {Set<string>} selected 选中的工具名
 */
export function selectAllState(names, selected) {
  const list = Array.from(names);
  const picked = list.filter((n) => selected.has(n)).length;
  return {
    total: list.length,
    picked,
    all: list.length > 0 && picked === list.length,
    some: picked > 0 && picked < list.length,
  };
}
