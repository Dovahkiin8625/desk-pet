/**
 * 双击判定。
 *
 * 桌宠的**单击**是「摸头」，弹出输入框（插件面板）改成**双击**。
 * 为什么分开：摸头是桌宠最常用的互动，每点一下都弹一个搜索框太吵；
 * 把入口挪到双击上，常用的那一下就还回来了。
 *
 * 判定看两下之间的**时间**与**距离**：
 * - 时间太长：那是两次单独的点击（用户在点点点，不是在双击）；
 * - 距离太远：那是点了两个地方（手滑，或者用户确实想点两处）。
 *
 * 这是一个纯状态机：不碰 DOM，也不自己挂监听器。
 * 监听器由 pet/interaction.js 统一挂载（理由见那里的说明）。
 */

/**
 * 两下之间最长隔多久还算双击（毫秒）。
 *
 * 取 500：这是 Windows 的双击间隔（系统设置里的默认值），
 * 也跟浏览器自己认双击的门槛一致。用系统的那个数字，
 * 用户在别处双击的习惯在这儿也成立。
 */
export const DOUBLE_TAP_INTERVAL_MS = 500;

/** 两下之间最远能差多远（像素）。 */
export const DOUBLE_TAP_DISTANCE_PX = 32;

/**
 * 「刚刚点过」吗？——双击的第二下还在等着落下来。
 *
 * 桌宠窗口在透明处会变成「不吃鼠标事件」（Windows 没有逐像素命中测试）。
 * 而摸头之后头会动，刚才点中的那个像素可能已经不是形象了——
 * 窗口随即变成穿透，双击的第二下就丢了，面板永远弹不出来。
 *
 * 所以点过之后的一小段时间里，窗口**保持可点**：
 * 宁可多挡一下桌面的点击，也别把双击吃掉。
 *
 * @param {number} lastTapAt 上一次点击的时刻（毫秒；0 = 从没点过）
 * @param {number} [now] 当前时刻（毫秒）
 * @param {number} [intervalMs] 宽限期多长
 * @returns {boolean}
 */
export function inDoubleTapWindow(lastTapAt, now = Date.now(), intervalMs = DOUBLE_TAP_INTERVAL_MS) {
  // 从没点过（0）时不算：0 离 1970 年太远，差值远大于任何宽限期。
  if (!lastTapAt) return false;
  return now - lastTapAt < intervalMs;
}

/**
 * 造一个双击判定器。
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs] 两下之间的最长间隔
 * @param {number} [options.distance] 两下之间的最大距离
 */
export function createDoubleTapDetector({
  intervalMs = DOUBLE_TAP_INTERVAL_MS,
  distance = DOUBLE_TAP_DISTANCE_PX,
} = {}) {
  /** 上一下的位置与时刻（null = 还没有上一记）。 */
  let last = null;

  return {
    /**
     * 这一下是不是「双击的后一下」。
     *
     * @param {number} x 画布坐标
     * @param {number} y 画布坐标
     * @param {number} [now] 当前时刻（毫秒）
     * @returns {boolean}
     */
    isDoubleTap(x, y, now = Date.now()) {
      const prev = last;
      last = { x, y, at: now };
      if (!prev) return false;
      if (now - prev.at > intervalMs) return false;
      if (Math.hypot(x - prev.x, y - prev.y) > distance) return false;
      // 成对了，从头算起。
      // 不清掉的话，第三下会被当成「第二下的后一下」——
      // 连点三下就成了「双击 + 又一次双击」，摸头的手感全乱了。
      last = null;
      return true;
    },

    /** 忘掉上一记（拖拽之后用得上：拖着走了一段再点，不该算双击）。 */
    reset() {
      last = null;
    },
  };
}
