// plugins/screen-recorder/lib/targets.js
/**
 * 可录目标的缓存。
 *
 * **模式有三个，目标只有两类**：全屏与选区用的是显示器，
 * 窗口模式用的是窗口。选区是在**某块显示器**上框一块，
 * 它用的就是显示器那一类目标。
 *
 * 所以「模式」不能直接拿去当下标。早先就是直接拿模式下标，
 * 于是选区模式去找一个根本不存在的 targets.region——
 * 一取数据就炸（Cannot read properties of undefined (reading 'length')），
 * 界面一片空白，而配置里的模式还停在选区，于是**每次打开都炸**。
 *
 * 映射收在这里：别处只说「我要哪个模式的目标」，
 * 由这里决定它落在哪个桶里。
 */

/**
 * 某个模式用的是哪一类目标。
 *
 * @param {string} mode 'screen' | 'region' | 'window'
 * @returns {'screen'|'window'}
 */
export function targetKind(mode) {
  return mode === 'window' ? 'window' : 'screen';
}

/**
 * 目标的缓存。
 *
 * 列一次要半秒上下，所以列了就存着：切 tab 不重新列，
 * 用户要最新的自己点「刷新」。
 */
export function createTargetCache() {
  /** 两个桶：显示器与窗口。 */
  const buckets = { screen: [], window: [] };
  /**
   * 正在跑的那次列目标（按种类分）。
   *
   * **同一类的两次列，共享一次**：面板与独立窗口可能同时打开这个插件，
   * 两边各列一遍就是白花的半秒（列目标要 0.4 秒上下）。
   * 缓存是「列完了才有」，所以并发的两次都会看到空桶、都去列。
   */
  const pending = { screen: null, window: null };

  /**
   * 某个模式当前的目标列表（没列过就是空的）。
   *
   * @param {string} mode
   * @returns {Array}
   */
  function get(mode) {
    return buckets[targetKind(mode)];
  }

  /**
   * 列目标；列过了就不再列（除非 force）。
   *
   * 列不出来不算错误：界面上就是空列表，用户可以再点「刷新」。
   *
   * @param {string} mode
   * @param {(kind: 'screen'|'window') => Promise<Array>} listTargets 列目标的函数
   * @param {{force?: boolean}} [options]
   * @returns {Promise<{list: Array, listed: boolean}>} list 是目标列表；
   *   listed 是「这一次真的列了」（没列就是拿缓存，或是等着别人列）。
   */
  async function load(mode, listTargets, { force = false } = {}) {
    const kind = targetKind(mode);
    if (!force && buckets[kind].length) return { list: buckets[kind], listed: false };
    // **已经在列了**：等那一次，不另起一次。
    if (pending[kind]) {
      const list = await pending[kind];
      return { list, listed: false };
    }
    const task = (async () => {
      let list = [];
      try {
        const found = await listTargets(kind);
        list = Array.isArray(found) ? found : [];
      } catch (err) {
        console.warn('[录屏] 列目标失败：', err?.message);
        list = [];
      }
      buckets[kind] = list;
      return list;
    })();
    pending[kind] = task;
    try {
      const list = await task;
      return { list, listed: true };
    } finally {
      if (pending[kind] === task) pending[kind] = null;
    }
  }

  return { get, load };
}
