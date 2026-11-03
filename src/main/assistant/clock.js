/**
 * 报时与问候语。
 *
 * 全是纯函数：给定一个时间，得出「要不要报」「报什么」。
 * 时间本身由主进程提供（渲染层没有可靠的时钟），
 * 而「整点」「早上好」这类规则要能被单测钉住，所以不散落在定时器里。
 */

/** 问候语的时段划分。 */
export const GREETING_BANDS = Object.freeze([
  { until: 5, text: '夜深了，早点休息呀', emotion: 'tired' },
  { until: 9, text: '早上好，今天也要加油哦', emotion: 'happy' },
  { until: 12, text: '上午好，喝口水休息一下吧', emotion: 'neutral' },
  { until: 14, text: '中午好，吃过饭了吗', emotion: 'happy' },
  { until: 18, text: '下午好，继续加油', emotion: 'happy' },
  { until: 22, text: '晚上好，今天辛苦啦', emotion: 'neutral' },
  { until: 24, text: '夜深了，早点休息呀', emotion: 'tired' },
]);

/** 按小时数给出问候语。 */
export function greetingFor(date) {
  const hour = date.getHours();
  const band = GREETING_BANDS.find((b) => hour < b.until);
  return band
    ? { text: band.text, emotion: band.emotion }
    : { text: '你好呀', emotion: 'neutral' };
}

/** 整点报时的话。 */
export function chimeText(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (m === 0) return `现在 ${h} 点整`;
  return `现在 ${h} 点 ${m} 分`;
}

/** 这一分钟是不是整点。 */
export function isOnTheHour(date) {
  return date.getMinutes() === 0;
}

/**
 * 距离下一个整点还有多少毫秒。
 *
 * 定时器要是对齐到「整点」而不是「整点 + 1 分钟」，
 * 就会在 14:00:00 报一次、14:01:00 又报一次。
 * 所以对齐到整点的**那一秒**，让「整点判定」自己去做最后一步。
 */
export function msUntilNextHour(date) {
  const next = new Date(date.getTime());
  next.setHours(next.getHours() + 1, 0, 1, 0);
  return Math.max(1000, next.getTime() - date.getTime());
}

/** 现在是星期几的中文说法。 */
export function weekdayText(date) {
  return ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
}
