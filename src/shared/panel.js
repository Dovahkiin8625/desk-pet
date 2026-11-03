/**
 * 主进程与面板渲染层共用的契约。
 *
 * 面板消息的形状放在这里：主进程负责**造**消息，
 * 面板页面负责**画**它——两边对「一条消息长什么样」的理解必须一致，
 * 所以定义只有一份（与 `shared/assistant.js` 里气泡消息的约定同理）。
 */

/** 面板视图的两种形态。 */
export const PANEL_VIEW = Object.freeze({
  /** 搜索视图：一个输入框 + 一列模糊匹配的结果。 */
  SEARCH: 'search',
  /** 插件视图：某个插件自己的界面。 */
  PLUGIN: 'plugin',
});

/**
 * 搜索视图的**固定**高度（像素）。
 *
 * 固定而不是跟着结果条数变：打字时窗口一高一低会让人晕。
 * 插件视图则按内容收缩——那里内容的长度是插件自己决定的。
 */
export const SEARCH_VIEW_HEIGHT = 380;

/** 面板高度的上限：内容再长也在面板内部滚动，不让窗口顶出屏幕。 */
export const MAX_VIEW_HEIGHT = 560;

/** 插件页面里块的类型。 */
export const BLOCK_KIND = Object.freeze({
  /** 一段文字。 */
  TEXT: 'text',
  /** 一列可点击的条目。 */
  LIST: 'list',
  /** 一个输入框（回车或点提交）。 */
  INPUT: 'input',
  /** 一组按钮。 */
  BUTTONS: 'buttons',
  /** 一个开关。 */
  TOGGLE: 'toggle',
  /** 空态提示。 */
  EMPTY: 'empty',
  /** 一段对话记录：带角色与时间，**不可点**。 */
  MESSAGES: 'messages',
});

/**
 * 插件页面的形状：
 *
 * ```
 * { pluginId, title, subtitle, status, blocks: [...] }
 * ```
 *
 * `status` 是插件页面底部的一行提示（刚做完某个动作的结果），
 * `blocks` 里每块的 `kind` 决定它怎么画。
 */

/** 一段文字。 */
export function textBlock(text) {
  return { kind: BLOCK_KIND.TEXT, text: String(text ?? '') };
}

/** 一列可点击的条目。 */
export function listBlock(items) {
  return {
    kind: BLOCK_KIND.LIST,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      id: String(item?.id ?? ''),
      label: String(item?.label ?? ''),
      done: Boolean(item?.done),
      hint: String(item?.hint ?? ''),
      // 点条目本身做什么。
      actionId: String(item?.actionId ?? item?.id ?? ''),
      // 条目右边的「×」做什么（空字符串 = 没有这个按钮）。
      removeId: String(item?.removeId ?? ''),
    })),
  };
}

/** 一个输入框。 */
export function inputBlock(id, placeholder = '', submitLabel = '确定', value = '') {
  return {
    kind: BLOCK_KIND.INPUT,
    id: String(id ?? ''),
    placeholder: String(placeholder ?? ''),
    submitLabel: String(submitLabel ?? '确定'),
    value: String(value ?? ''),
  };
}

/** 一组按钮。 */
export function buttonsBlock(items) {
  return {
    kind: BLOCK_KIND.BUTTONS,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      id: String(item?.id ?? ''),
      label: String(item?.label ?? ''),
      primary: Boolean(item?.primary),
    })),
  };
}

/** 一个开关。 */
export function toggleBlock(id, label, checked = false) {
  return {
    kind: BLOCK_KIND.TOGGLE,
    id: String(id ?? ''),
    label: String(label ?? ''),
    checked: Boolean(checked),
  };
}

/** 空态提示。 */
export function emptyBlock(text) {
  return { kind: BLOCK_KIND.EMPTY, text: String(text ?? '') };
}

/**
 * 一段对话记录。
 *
 * 与 `list` 的区别：这一块**不可点**（聊天记录不是菜单），
 * 而且每条都带角色（用户 / 桌宠）与时间。
 */
export function messagesBlock(items) {
  return {
    kind: BLOCK_KIND.MESSAGES,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      role: item?.role === 'user' ? 'user' : 'assistant',
      text: String(item?.text ?? ''),
      at: Number.isFinite(item?.at) ? item.at : 0,
      proactive: Boolean(item?.proactive),
    })),
  };
}

/** 造一个插件页面。 */
export function makePage({ pluginId = '', title = '', subtitle = '', status = '', blocks = [] } = {}) {
  return {
    pluginId: String(pluginId),
    title: String(title),
    subtitle: String(subtitle),
    status: String(status),
    blocks: Array.isArray(blocks) ? blocks : [],
  };
}

/**
 * 造一个搜索视图。
 *
 * 插件清单不在这里：它是一次性下发的（`panel:plugins`），
 * 页面拿在本地做模糊搜索——每敲一个字不必过一次 IPC。
 */
export function makeSearchView() {
  return { view: PANEL_VIEW.SEARCH };
}

/** 造一个插件视图。 */
export function makePluginView(page) {
  return {
    view: PANEL_VIEW.PLUGIN,
    page: page || makePage({}),
  };
}
