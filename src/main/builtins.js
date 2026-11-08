/**
 * 内置功能。
 *
 * 「设置」**不是插件**：它是程序自带的一块功能，不能被关掉、
 * 也不住在插件目录里——所以它不进插件宿主，
 * 而是直接待在面板的搜索清单里。
 *
 * 「聊天记录」原来也是内置功能，现在**改成插件**了
 * （见 `plugins/chat-history/`）：它要按分类显示、要实时更新、
 * 还要能分离成独立窗口——这些用插件才做得出来。
 */
export const BUILTIN_SETTINGS = 'settings';

const FEATURES = Object.freeze([
  {
    id: BUILTIN_SETTINGS,
    name: '设置',
    icon: '⚙️',
    description: '桌宠的偏好与语音配置',
    keywords: ['settings', 'setting', 'shezhi', 'sz', '设置', '偏好', '配置'],
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
