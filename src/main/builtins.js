import { makePage, messagesBlock, emptyBlock, buttonsBlock } from '../shared/panel.js';

/**
 * 内置功能。
 *
 * 「设置」与「聊天记录」**不是插件**：它们是程序自带的两块功能，
 * 不能被关掉、也不住在插件目录里——所以它们不进插件宿主，
 * 而是直接待在面板的搜索清单里。
 *
 * 界面仍然用同一套声明式块：聊天记录画在面板里，
 * 设置开的是另一个窗口（设置窗口本身）。
 */
export const BUILTIN_SETTINGS = 'settings';
export const BUILTIN_HISTORY = 'history';

const FEATURES = Object.freeze([
  {
    id: BUILTIN_SETTINGS,
    name: '设置',
    icon: '⚙️',
    description: '桌宠的偏好与语音配置',
    keywords: ['settings', 'setting', 'shezhi', 'sz', '设置', '偏好', '配置'],
  },
  {
    id: BUILTIN_HISTORY,
    name: '聊天记录',
    icon: '📜',
    description: '和桌宠说过的话',
    keywords: ['history', 'chat', 'record', 'duihua', 'liaotian', 'jl', '聊天', '记录', '对话', '记忆'],
  },
]);

/**
 * 搜索清单用的形状。
 *
 * 字段与插件的元数据**刻意一致**（多出来的 builtin/canDetach/hasWidget
 * 是显式的「false」）：面板画结果时不分插件与内置功能，
 * 一视同仁地画，用户也分不出差别——本来就不该分得出。
 */
export function builtinFeatures() {
  return FEATURES.map((f) => ({
    ...f,
    canDetach: false,
    hasWidget: false,
    builtin: true,
  }));
}

/** 这个 id 是不是内置功能。 */
export function isBuiltin(id) {
  return FEATURES.some((f) => f.id === id);
}

/**
 * 内置功能的页面。
 *
 * 「设置」没有页面——它开的是另一个窗口；这里返回 null。
 */
export function builtinPage(id, assistant) {
  if (id !== BUILTIN_HISTORY) return null;
  const view = assistant?.chatHistoryView?.() || { messages: [], total: 0 };
  return makePage({
    pluginId: BUILTIN_HISTORY,
    title: '聊天记录',
    subtitle: view.total ? `${view.total} 条记录` : '还没聊过',
    blocks: [
      view.total === 0
        ? emptyBlock('还没和桌宠聊过天')
        : messagesBlock(view.messages),
      buttonsBlock([{ id: 'clear', label: '清空记录' }]),
    ],
  });
}

/** 内置功能里的一个动作。 */
export function builtinAction(id, actionId, assistant) {
  if (id !== BUILTIN_HISTORY) return null;
  if (actionId === 'clear') {
    const r = assistant?.clearChatHistory?.();
    return { ...builtinPage(id, assistant), status: r?.message || '记录清空了' };
  }
  return builtinPage(id, assistant);
}
