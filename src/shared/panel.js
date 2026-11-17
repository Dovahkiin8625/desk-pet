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

/**
 * 面板高度的**兜底**上限（像素）。
 *
 * 真正的上限是**屏幕的工作区高度**（见 src/main/panelHeight.js 的
 * maxPanelHeight）：屏幕装得下，面板就长到内容那么高；
 * 装不下才收——多出来的那一截在面板内部滚动。
 *
 * 这个数只在**拿不到显示器信息**时用（测试里就是这种情况）。
 *
 * 别把它当成「面板就该这么高」：写死上限的话，插件页面一长，
 * 底部就被裁掉了（用户看到的正是这个）。
 */
export const FALLBACK_VIEW_HEIGHT = 560;

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
  /** 一组配置控件：插件自己的配置项（在插件自己的页面里）。 */
  SETTINGS: 'settings',
  /** 天气主卡：图标 + 大字温度 + 湿度/风等（天气插件用）。 */
  WEATHER: 'weather',
  /** 桌宠天气效果：开关 + 带小方框预览的效果选择（天气插件用）。 */
  EFFECTS: 'effects',
  /** 倒计时：圆环 + 大字剩余时间（番茄钟用）。 */
  TIMER: 'timer',
  /** 一组数据卡：图标 + 数值 + 进度条（系统状态用）。 */
  STATS: 'stats',
  /** 页面的主角：图标 + 大标题 + 一行小字（音乐/截图等用）。 */
  HERO: 'hero',
});

/**
 * 插件页面的形状：
 *
 * ```
 * { pluginId, title, subtitle, status, blocks: [...], drawer: [...] }
 * ```
 *
 * `status` 是插件页面底部的一行提示（刚做完某个动作的结果），
 * `blocks` 里每块的 `kind` 决定它怎么画。
 *
 * `drawer` 是**设置项**：它们不进正文，画在右边那个抽屉里
 * （清单里声明的配置项由宿主放进去，见 src/main/plugins/host.js）。
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
      // 图标是可选的：有就画成左侧的小图标块（图标名见 shared/icons.js）。
      icon: String(item?.icon ?? ''),
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
      // 图标是可选的：渲染层有就话在文字前面（图标名见 shared/icons.js）。
      icon: String(item?.icon ?? ''),
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

/** 空态提示；给 `icon` 时画成「大图标在上、文案在下」的空态卡。 */
export function emptyBlock(text, icon = '') {
  return { kind: BLOCK_KIND.EMPTY, text: String(text ?? ''), icon: String(icon ?? '') };
}

/**
 * 一组配置控件：插件自己的配置项。
 *
 * `items` 里的每一项是一个配置项：
 * `{ key, label, type, options, value, hint }`——
 * `type` 是 `text` / `number` / `boolean` / `select`。
 */
export function settingsBlock(items) {
  return {
    kind: BLOCK_KIND.SETTINGS,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      key: String(item?.key ?? ''),
      label: String(item?.label ?? ''),
      type: String(item?.type ?? 'text'),
      options: Array.isArray(item?.options) ? item.options.map((o) => String(o)) : [],
      value: item?.value ?? '',
      hint: String(item?.hint ?? ''),
    })),
  };
}

/** 一段对话记录：带角色与时间，**不可点**。 */
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

/**
 * 天气主卡：图标 + 大字温度 + 条件 + 湿度/风/更新时间。
 *
 * 数值缺多少认多少（磁盘上的旧数据可能缺字段）：没有的项界面上不画。
 * `icon` 是图标集里的名字（主进程按 WMO 代码算出来的）。
 */
export function weatherBlock({ city = '', text = '', icon = 'cloud', temperature = null, humidity = null, wind = null, at = 0 } = {}) {
  return {
    kind: BLOCK_KIND.WEATHER,
    city: String(city ?? ''),
    text: String(text ?? ''),
    icon: String(icon ?? 'cloud'),
    temperature: Number.isFinite(temperature) ? temperature : null,
    humidity: Number.isFinite(humidity) ? humidity : null,
    wind: Number.isFinite(wind) ? wind : null,
    at: Number.isFinite(at) ? at : 0,
  };
}

/**
 * 桌宠天气效果：开关 + 一排带小方框预览的效果选项。
 *
 * `options` 里的每一项：`{ value, label, icon, effect, sub }` ——
 * `value` 是写盘用的值（「自动」「下雨」……），
 * `effect` 是给小方框预览画粒子用的钥匙（'auto' / 'rain' / 'wind' / 'snow' / 'sun' / 'leaves'），
 * `sub` 是选项名下面的一行小字（可空；「自动」用它写「播落叶」）。
 *
 * `preview`：效果选择器底部那颗满宽按钮（`{ label, actionId }`）——
 * 预览是整个区域最想让人点的动作，收在效果选择器里正合适。传空 = 不画。
 */
export function effectsBlock({ enabled = false, choice = '自动', options = [], hint = '', preview = null } = {}) {
  return {
    kind: BLOCK_KIND.EFFECTS,
    enabled: Boolean(enabled),
    choice: String(choice ?? ''),
    hint: String(hint ?? ''),
    options: (Array.isArray(options) ? options : []).map((item) => ({
      value: String(item?.value ?? ''),
      label: String(item?.label ?? ''),
      icon: String(item?.icon ?? 'sparkles'),
      effect: String(item?.effect ?? 'auto'),
      sub: String(item?.sub ?? ''),
    })),
    preview:
      preview && preview.label
        ? { label: String(preview.label), actionId: String(preview.actionId ?? 'preview') }
        : null,
  };
}

/**
 * 倒计时圆环（番茄钟用）。
 *
 * `progress` 是已走掉的比例（0 表示刚开始，1 表示该结束了），
 * 圆环按它画；`remainingText` 是给人看的「18:24」；
 * `variant` 是 `focus`（专注，主题色）/ `break`（休息，绿色）/ `paused`（暂停，灰色）/ `idle`（没在跑）。
 */
export function timerBlock({ variant = 'idle', phase = '', remainingText = '--:--', progress = 0, sub = '' } = {}) {
  const p = Number(progress);
  return {
    kind: BLOCK_KIND.TIMER,
    variant: ['focus', 'break', 'paused', 'idle'].includes(variant) ? variant : 'idle',
    phase: String(phase ?? ''),
    remainingText: String(remainingText ?? '--:--'),
    progress: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0,
    sub: String(sub ?? ''),
  };
}

/**
 * 一组数据卡（系统状态用）。
 *
 * `items` 里的每一项：`{ icon, label, text, value, hot }` ——
 * `value` 是 0-100 的进度（`null` 表示不画进度条，只给文字），
 * `hot` 为真时进度条变红（与"过热"同色系），`text` 是主数值。
 */
export function statsBlock({ items = [] } = {}) {
  return {
    kind: BLOCK_KIND.STATS,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      icon: String(item?.icon ?? 'activity'),
      label: String(item?.label ?? ''),
      text: String(item?.text ?? ''),
      value: Number.isFinite(Number(item?.value)) ? Math.max(0, Math.min(100, Number(item.value))) : null,
      hot: Boolean(item?.hot),
    })),
  };
}

/** 页面的主角：图标 + 大标题 + 一行小字。 */
export function heroBlock({ icon = 'sparkles', title = '', subtitle = '' } = {}) {
  return {
    kind: BLOCK_KIND.HERO,
    icon: String(icon ?? 'sparkles'),
    title: String(title ?? ''),
    subtitle: String(subtitle ?? ''),
  };
}

/** 造一个插件页面。 */
export function makePage({ pluginId = '', title = '', subtitle = '', status = '', blocks = [], drawer = [] } = {}) {
  return {
    pluginId: String(pluginId),
    title: String(title),
    subtitle: String(subtitle),
    status: String(status),
    blocks: Array.isArray(blocks) ? blocks : [],
    // 设置项：画在右边的抽屉里，不占正文。
    drawer: Array.isArray(drawer) ? drawer : [],
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
