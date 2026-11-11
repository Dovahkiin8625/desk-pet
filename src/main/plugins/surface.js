// src/main/plugins/surface.js

/**
 * 界面路由。
 *
 * 一个插件的界面可以同时挂在好几处：面板的工作台里一份，
 * 独立窗口里一份。这一层管的是：
 *
 * 1. **谁挂着**：哪个插件的界面挂在哪些地方；
 * 2. **推给谁**：周期数据要送到所有挂着的地方（两处看到的数据必须一致）；
 * 3. **什么时候推**：tick 定时器**第一个 surface 挂上来时起，
 *    最后一个摘掉时停**——界面都没了还按秒推，那是白烧 CPU。
 *    挂着好几个时按**最快的那个**周期推（面板慢不该拖慢小部件）。
 *
 * 这里**不碰 Electron**：surface 自己知道怎么把数据送出去
 * （`deliver(kind, payload)`），这一层只管「该送给谁」。
 */

/** 一个 surface 至少要有这两样。 */
function isSurface(value) {
  return Boolean(value) && typeof value.deliver === 'function';
}

export function createSurfaceController({ host, onChange }) {
  /** pluginId → Set<surface> */
  const attached = new Map();
  /** pluginId → 定时器 */
  const timers = new Map();

  /**
   * 界面开合了：第一个挂上来 / 最后一个摘掉。
   *
   * 插件靠它知道「我的界面现在开着吗」——
   * 录屏的快捷键只在界面开着时才生效（见第二期计划）。
   */
  function notify(pluginId, open) {
    try {
      onChange?.(pluginId, open);
    } catch (err) {
      console.warn('[desk-pet] 界面开合的回调出错：', err?.message);
    }
  }

  /** 这个插件现在挂着哪些 surface。 */
  function surfacesOf(pluginId) {
    let set = attached.get(pluginId);
    if (!set) {
      set = new Set();
      attached.set(pluginId, set);
    }
    return set;
  }

  /** 插件的刷新间隔（毫秒）。0 = 不刷。 */
  function refreshMsOf(pluginId, mode) {
    const spec = host?.spec?.(pluginId, mode || 'window');
    const ms = Number(spec?.refreshMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  /** 推一次周期数据。 */
  async function pushTick(pluginId, mode) {
    // 这里**不能**用 surfacesOf()：它会把不存在的插件塞进 attached，
    // 留下一个空集合——那个空集合会让后面的 detach() 误报一次「界面关了」。
    if (!attached.get(pluginId)?.size) return;
    let payload;
    try {
      // 推什么由插件的形态决定（宿主知道）：
      // 自带页面的插件推**数据**，声明式界面推**重算过的页面**。
      payload = await host?.refresh?.(pluginId, mode);
    } catch (err) {
      console.warn(`[desk-pet] 插件「${pluginId}」刷新失败：`, err?.message);
      return;
    }
    if (!payload) return;
    broadcast(pluginId, payload.kind, payload.data);
  }

  /**
   * 把一份数据推给某个插件的所有 surface。
   *
   * **统一包成 `{ pluginId, data }`**：面板可能在两个插件之间来回切，
   * 收到的数据得带得清是给谁的。各 surface **不拆包**——
   * 拆包的是宿主壳（plugin-window/main.js）与插件页面助手（pluginPage.js）。
   */
  function broadcast(pluginId, kind, payload) {
    const set = attached.get(pluginId);
    if (!set || !set.size) return;
    for (const surface of set) {
      try {
        surface.deliver(kind, { pluginId, data: payload });
      } catch (err) {
        console.warn(`[desk-pet] 插件「${pluginId}」的界面收数据失败：`, err?.message);
      }
    }
  }

  /**
   * 挂着的界面里，最快的那个刷新周期。
   *
   * **取最快的**：面板开着（慢）不该把小部件（快）拖慢——
   * 它们看的是同一份数据，推给谁都一样快。
   */
  function fastestSurface(pluginId, set) {
    let best = null;
    for (const surface of set) {
      // 刷新周期按**这个界面的形态**算：小部件与独立窗口的清单段不一样。
      const mode = surface.mode || 'window';
      const ms = refreshMsOf(pluginId, mode);
      if (ms > 0 && (!best || ms < best.ms)) best = { mode, ms };
    }
    return best;
  }

  /** 按挂着的界面重设定时器。 */
  function retime(pluginId) {
    const set = attached.get(pluginId);
    const best = set?.size ? fastestSurface(pluginId, set) : null;
    if (!best) {
      stopTimer(pluginId);
      return;
    }
    const current = timers.get(pluginId);
    if (current && current.refreshMs === best.ms) return;
    if (current) clearInterval(current.id);
    timers.set(pluginId, {
      id: setInterval(() => void pushTick(pluginId, best.mode), best.ms),
      refreshMs: best.ms,
    });
  }

  /** 挂上一个界面。 */
  function attach(pluginId, surface) {
    if (!pluginId || !isSurface(surface)) return;
    const set = surfacesOf(pluginId);
    const wasEmpty = set.size === 0;
    set.add(surface);
    if (wasEmpty) notify(pluginId, true);
    retime(pluginId);
  }

  /** 摘下一个界面。 */
  function detach(pluginId, surface) {
    const set = attached.get(pluginId);
    if (!set) return;
    set.delete(surface);
    if (set.size === 0) {
      attached.delete(pluginId);
      stopTimer(pluginId);
      notify(pluginId, false);
      return;
    }
    // 还有界面挂着：周期按剩下的界面重算（快的那个走了就慢下来）。
    retime(pluginId);
  }

  function stopTimer(pluginId) {
    const timer = timers.get(pluginId);
    if (timer) {
      clearInterval(timer.id);
      timers.delete(pluginId);
    }
  }

  return {
    attach,
    detach,
    broadcast,
    isAttached: (pluginId) => Boolean(attached.get(pluginId)?.size),
    /** 退出前把定时器全停掉。 */
    stopAll() {
      for (const pluginId of [...timers.keys()]) stopTimer(pluginId);
      attached.clear();
    },
  };
}
