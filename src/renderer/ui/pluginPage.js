/**
 * 插件页面的助手。
 *
 * 插件自带的页面**同一份**要能在两个地方跑：
 *
 * - 独立窗口里（壳的 iframe）：能力在壳上 → `parent.plugin`；
 * - 面板工作台里（面板的 iframe）：能力在面板上 → `parent.panel.surface`；
 * - 小部件里（页面被原样加载）：preload 就在自己身上 → `window.plugin`。
 *
 * 插件页面分不出自己身处哪种情况，也**不该**分——所以这里统一认一次，
 * 插件只管 `import { bindSurface } from '/src/renderer/ui/pluginPage.js'`。
 *
 * 同源假设：iframe 与父页面都是 `app://bundle`，所以能直接读父页面的全局对象。
 */

/** 从查询参数里读插件自己的 id。 */
function readPluginId() {
  try {
    return new URLSearchParams(location.search).get('plugin') || '';
  } catch {
    return '';
  }
}

/**
 * 找到「能用的那条通道」。
 *
 * 顺序有讲究：先看自己身上（顶层被直接加载的情况），
 * 再看父页面上的插件壳，最后看面板。
 */
function findApi() {
  if (typeof window.plugin?.data === 'function') return window.plugin;
  const parent = window.parent;
  if (parent && parent !== window && typeof parent.plugin?.data === 'function') {
    return parent.plugin;
  }
  if (parent && parent !== window && typeof parent.panel?.surface?.data === 'function') {
    return parent.panel.surface;
  }
  return null;
}

/** 把消息发给父页面（状态、内容高度）。 */
function postToParent(type, payload) {
  const parent = window.parent;
  if (!parent || parent === window) return;
  parent.postMessage({ type, pluginId: readPluginId(), ...payload }, '*');
}

/**
 * 绑上界面。
 *
 * @returns {object} 一套统一的界面 API；通道找不到时各项都是空操作。
 */
export function bindSurface() {
  const api = findApi();
  const id = readPluginId();

  /** 推来的数据是不是发给自己的（面板可能在两个插件之间来回切）。 */
  function isMine(payload) {
    if (!payload || typeof payload !== 'object') return true;
    if (!payload.pluginId || !id) return true;
    return payload.pluginId === id;
  }

  /**
   * 拆包：宿主推来的东西统一是 `{ pluginId, data }`。
   *
   * 拆出 `data` 给回调，顺带按 pluginId 过滤——
   * 面板可能在两个插件之间来回切，推迟了的数据不能串到别的插件那里。
   */
  function unwrap(payload) {
    const mine = isMine(payload);
    // **只认真正的信封**：pluginId 与 data 两个键都在才算。
    // 只看 'data' in payload 的话，插件自己的裸数据里带一个叫 data 的字段
    // 就会被拆坏（Task 7 之前独立窗口推的还是裸数据）。
    const isEnvelope =
      payload && typeof payload === 'object' && 'pluginId' in payload && 'data' in payload;
    if (isEnvelope) return { mine, data: payload.data };
    return { mine, data: payload };
  }

  return {
    id,
    mode: api?.mode || 'window',

    /** 打开时的第一份数据。 */
    data: () => (api ? api.data() : Promise.resolve(null)),

    /** 首份数据到了（宿主推过来的）。 */
    onData(cb) {
      api?.onData?.((payload) => {
        const item = unwrap(payload);
        if (!item.mine) return;
        cb(item.data);
      });
    },

    /** 周期数据到了。 */
    onTick(cb) {
      api?.onTick?.((payload) => {
        const item = unwrap(payload);
        if (!item.mine) return;
        cb(item.data);
      });
    },

    /** 自带页面里的一个动作。 */
    act: (actionId, payload) => (api ? api.act(actionId, payload) : Promise.resolve(null)),

    /** 声明式页面里的一个动作（老插件的积木页走这条）。 */
    // **一定是 Promise**：面板那边的通道将来用 invoke，
    // 但万一某个通道是 send（没有回执），页面那边 .then() 会炸。
    action: (actionId, value) =>
      api ? Promise.resolve(api.action(actionId, value)) : Promise.resolve(null),

    /** 底部那行字。 */
    setStatus(text) {
      postToParent('desk-pet:surface:status', { text: String(text ?? '') });
    },

    /**
     * 报告内容高度。
     *
     * **只对面板有意义**：面板窗口的高度是内容撑开的。
     * 独立窗口的高度是用户拖出来的，插件说了也没用。
     */
    setHeight(px) {
      postToParent('desk-pet:surface:height', { height: Number(px) || 0 });
    },
  };
}
