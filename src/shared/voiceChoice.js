/**
 * 「音色」这个设置有两个来源：下拉框里的常用音色，和用户自己填的 id。
 *
 * 规则只有一条，但**必须只写一遍**：
 * 下拉框和输入框各判一次，早晚写出「两个都填了算哪个」的岔路。
 *
 * 放在 shared/ 是因为这条规则不只设置窗口用：
 * 主进程算缓存键、算「要不要重新生成台词语音」时都得知道
 * 当前到底是哪一个音色生效。
 */

/**
 * 当前生效的音色 id。
 *
 * 自定义输入框填了就用它，否则用下拉框选的。
 * 全空就是空——没有音色可念，主进程那边会自己兜住。
 */
export function resolveVoiceId(customValue, selectValue) {
  const custom = String(customValue ?? '').trim();
  if (custom) return custom;
  return String(selectValue ?? '').trim();
}

/**
 * 把存下来的音色 id 回填到两个控件上。
 *
 * @param {string} voiceId 存着的音色 id
 * @param {string[]} knownIds 常用音色清单里的 id
 * @returns {{custom: string, select: string}} custom = 自定义框里显示什么；select = 下拉框该选中什么
 */
export function applyVoiceChoice(voiceId, knownIds) {
  const id = String(voiceId ?? '').trim();
  const ids = Array.isArray(knownIds) ? knownIds : [];

  // 在清单里：下拉框选它，自定义框留空。
  // 两个控件不同时指着一个东西——否则用户会以为自己填的那串才是生效的。
  if (id && ids.includes(id)) return { custom: '', select: id };

  // 不在清单里（用户自己填的）：自定义框显示它。
  // 下拉框只能选清单里的，就让它待在第一项；自定义框非空时以它为准。
  return { custom: id, select: ids[0] ?? '' };
}
