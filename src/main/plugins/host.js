import { readJson, writeJson } from '../store.js';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  makePage,
  textBlock,
  listBlock,
  inputBlock,
  buttonsBlock,
  toggleBlock,
  emptyBlock,
  messagesBlock,
} from '../../shared/panel.js';
import { canDetach, hasWidget, resolveWindowSpec, PLUGIN_WINDOW_MODE } from '../../shared/plugin.js';
import { createAgentFacade } from '../assistant/agent/facade.js';
import { appUrl } from '../protocol.js';
import { discoverPlugins, loadPluginFactory } from './loader.js';
import { bundledPluginsDir, userPluginsDir as userPluginsPath } from './paths.js';

/**
 * 插件宿主。
 *
 * 宿主做三件事：
 *
 * 1. **发现**：扫插件根目录，把每个子目录读成一个插件
 *    （发现与加载的细节在 loader.js）。
 * 2. **注册**：把插件的清单交给面板去搜索，把插件的页面交给面板去画。
 * 3. **开窗**：插件可以分离成独立窗口，或者变成桌面上的小部件
 *    （开窗的细节在 window.js）。
 *
 * 插件自己**不知道**宿主的存在：它拿到的是一个上下文（ctx），
 * 里面只有它该用到的东西（助理、界面积木、宿主能力）。
 * 这样插件既可以被面板调用，也可以被自己的窗口调用，两条路共用一份实现。
 */

/** 插件的启用状态存在哪。 */
const PREFS_FILE = 'plugins.json';

/** 界面积木：插件用它拼出自己的页面。 */
const UI = Object.freeze({
  makePage,
  textBlock,
  listBlock,
  inputBlock,
  buttonsBlock,
  toggleBlock,
  emptyBlock,
  messagesBlock,
});

export async function createPluginHost({
  rootDir,
  userDataDir,
  userPluginsDir,
  assistant,
  openSettings,
  /**
   * agent 的工具表：插件提供的工具挂进这里。
   *
   * 省略时用 `assistant.agentTools`——助理是 agent 子系统的所在地，
   * 工具表自然也在它那儿。
   */
  toolRegistry = null,
  /**
   * agent 的对外接口（插件用它反向提交任务、读历史、订阅事件）。
   *
   * 省略时用 `assistant.agent`。
   */
  agent = null,
}) {
  /** id → 插件记录。 */
  const records = new Map();
  /** 插件启用状态的变化（有人把某个插件关了/开了）。 */
  const listeners = new Set();
  /** 打开独立窗口的入口（window.js 装上来）。 */
  let windowOpener = null;
  /** 插件界面开合的回调（插件想知道「我的界面开着吗」）。 */
  const surfaceListeners = new Set();
  /** 真正在用的工具表：注入的优先，其次助理的。 */
  const tools = toolRegistry || assistant?.agentTools || null;
  /**
   * 插件拿到的 agent 接口：注入的优先，其次助理的。
   *
   * 都没有时给一个**空壳**（提交任务会明确说「还没上线」）：
   * 插件代码里不用到处判空——`ctx.agent.run(...)` 永远能调。
   */
  const agentApi = agent || assistant?.agent || createAgentFacade({});
  /** 插件 id → 它的工具实现（name → 实现）。取过了就不重复问插件。 */
  const toolImplCache = new Map();

  /**
   * 订阅界面开合。返回取消订阅的函数。
   *
   * 插件通过 `ctx.host.onSurfaceChange()` 用它——
   * 录屏的快捷键只在界面开着时才生效（见第二期计划）。
   */
  function onSurfaceChange(cb) {
    surfaceListeners.add(cb);
    return () => surfaceListeners.delete(cb);
  }

  let prefs = await readJson(userDataDir, PREFS_FILE, { disabled: [] }, '插件启用状态');
  const disabled = new Set(
    Array.isArray(prefs?.disabled) ? prefs.disabled.filter((x) => typeof x === 'string') : []
  );

  /**
   * 插件的上下文。
   *
   * `update` 是「异步动作完成后再刷新一次页面」的回调：
   * 天气查询要联网，返回之前页面已经画出来了，结果到了再刷新。
   */
  function makeContext(record, update) {
    return {
      plugin: {
        id: record.manifest.id,
        manifest: record.manifest,
        dir: record.dir,
        source: record.source,
      },
      assistant,
      /**
       * agent 的对外接口（规格 §5.5）：插件能提交后台任务、取消任务、
       * 读聊天记录、订阅 agent 事件。
       *
       * 插件跑在主进程里，与 agent 运行时同处一个进程，所以这是**直接调用**，
       * 不需要 IPC。
       */
      agent: agentApi,
      openSettings,
      update: typeof update === 'function' ? update : () => {},
      ui: UI,
      host: {
        /** 全部插件（含被关掉的）与它们的启用状态：设置窗口的「插件」分区要用。 */
        listAll: () => listAll(),
        /** 开/关一个插件。 */
        setEnabled: (id, enabled) => setEnabled(id, enabled),
        isEnabled: (id) => isEnabled(id),
        /** 把插件分离成独立窗口 / 小部件。 */
        openWindow: (id, mode) => windowOpener?.open(id, mode) || { ok: false },
        closeWindow: (id) => windowOpener?.close(id) || { ok: false },
        /**
         * 插件的界面开合了：第一个界面挂上来 / 最后一个摘掉。
         *
         * 插件靠它知道「我的界面现在开着吗」——
         * 录屏的快捷键只在界面开着时才生效。
         * 返回取消订阅的函数。
         */
        onSurfaceChange: (cb) => onSurfaceChange(cb),
      },
    };
  }

  /** 插件有没有被关掉。 */
  function isEnabled(id) {
    return records.has(id) && !disabled.has(id);
  }

  /**
   * 插件自带页面的 URL 缓存。
   *
   * `pageUrl()` 要查磁盘（statSync）：面板的插件清单**每次刷新都会重建**
   * （开关一个插件、面板重新打开……），清单里带上页面地址就意味着
   * 每次刷新都要查一遍盘。
   *
   * 缓存按插件 id 存，插件清单变了（加载了新的插件、开关了插件）就整个丢掉。
   */
  const pageUrlCache = new Map();

  /** 插件清单变了：缓存里的页面地址不再可信。 */
  function invalidatePageUrls() {
    pageUrlCache.clear();
  }

  /** 插件的公开元数据（面板搜索用）。 */
  function toMeta(record) {
    const m = record.manifest;
    return {
      id: m.id,
      name: m.name,
      icon: m.icon,
      description: m.description,
      keywords: m.keywords,
      // 面板据此显示「在新窗口打开 / 变成小部件」两个按钮。
      canDetach: canDetach(m),
      hasWidget: hasWidget(m),
      // 插件自带页面时：面板工作台与独立窗口装的是**同一份**。
      // 页面**不存在**时 pageUrl 是空串 → 面板退回积木界面，不开白窗口。
      hasPage: Boolean(m.window?.page),
      pageUrl: pageUrlOf(m.id),
      source: record.source,
    };
  }

  /** 面板搜索用的清单：**只含启用的**插件。 */
  function list() {
    return [...records.values()].filter((r) => isEnabled(r.manifest.id)).map(toMeta);
  }

  /** 全部插件与启用状态（设置窗口的「插件」分区用）。 */
  function listAll() {
    return [...records.values()].map((r) => ({
      ...toMeta(r),
      enabled: isEnabled(r.manifest.id),
    }));
  }

  /** 开/关一个插件，并落盘。 */
  async function setEnabled(id, enabled) {
    if (!records.has(id)) return { ok: false, message: '没有这个插件' };
    const on = Boolean(enabled);
    if (on) disabled.delete(id);
    else disabled.add(id);
    prefs = { ...prefs, disabled: [...disabled] };
    try {
      await writeJson(userDataDir, PREFS_FILE, prefs);
    } catch (err) {
      console.warn('[desk-pet] 插件启用状态保存失败：', err?.message);
    }
    // 关掉的插件，它的窗口也要跟着关：窗口还开着、插件却「不在」了。
    if (!on) windowOpener?.close(id);
    // 插件开关 → 它提供的工具也要跟着进出 agent 的工具表。
    await syncPluginTools();
    // 插件清单变了：缓存里的页面地址不再可信（下次查盘重算）。
    invalidatePageUrls();
    notifyChange();
    return { ok: true, enabled: on };
  }

  function notifyChange() {
    const meta = list();
    for (const cb of listeners) {
      try {
        cb(meta);
      } catch (err) {
        console.warn('[desk-pet] 插件清单变更的回调出错：', err?.message);
      }
    }
  }

  /**
   * 打开一个插件：返回它的页面；返回 null 表示「关掉面板」。
   *
   * 插件的界面是**无状态**的：动作 → 重新算一次页面 → 新的页面。
   * 这样每个插件都只有一份「我现在长什么样」的代码，
   * 不会出现「改了数据但界面没跟着变」的第二套同步逻辑。
   */
  async function open(id, update) {
    const record = records.get(id);
    if (!record || !isEnabled(id)) return null;
    const ctx = makeContext(record, update);
    try {
      const instance = record.instance;
      // 插件自带页面时，宿主只要标题那几个字段——
      // 让插件写一份**便宜**的 meta()，别在这儿把整个界面重算一遍
      // （有的插件的 page() 要列系统窗口，那一下要几百毫秒）。
      //
      // 页面**不在磁盘上**时不算：那种情况宿主要退回积木界面，
      // 积木还得靠 page() 画出来（否则面板上是一片空白）。
      if (pageUrlOf(id) && typeof instance.meta === 'function') {
        const meta = (await instance.meta(ctx)) || {};
        return {
          pluginId: record.manifest.id,
          title: String(meta.title || ''),
          subtitle: String(meta.subtitle || ''),
          status: String(meta.status || ''),
          blocks: [],
        };
      }
      const page = await instance.page?.(ctx);
      return page || null;
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」打开失败：`, err?.message);
      return null;
    }
  }

  /**
   * 界面落点的周期刷新：这一轮推什么。
   *
   * - **自带页面**的插件：推**数据**（插件自己的 tick()）。
   *   插件没写 tick() 就没有推送——它的界面自己管。
   * - **声明式界面**的插件：推**重算过的页面**。它的界面是宿主画的，
   *   要动起来就得重算一次（番茄钟的倒计时就靠它）。
   *
   * 两种形态的刷新**周期**一样（清单里的 refreshMs），要的东西不一样。
   *
   * @param {string} id 插件 id
   * @param {string} mode 这个界面的形态（window / widget）
   */
  async function refresh(id, mode = PLUGIN_WINDOW_MODE.WINDOW) {
    const record = records.get(id);
    if (!record) return null;
    // 自带页面的插件：界面是插件自己画的，宿主只负责喂数据。
    // 小部件的页面也是插件自己的（widget 段），它按 widget 段算。
    const spec = resolveWindowSpec(record.manifest, mode);
    const ownPage =
      mode === PLUGIN_WINDOW_MODE.WIDGET
        ? Boolean(spec?.page)
        : // 窗口形态：**文件真的在磁盘上**才算自带页面。
          // 清单里写了 page 但文件没了 → 退回积木界面。
          pageUrlOf(id) !== '';
    if (ownPage) {
      const data = await tick(id);
      return data === undefined ? null : { kind: 'tick', data };
    }
    const page = await open(id, null);
    return page ? { kind: 'page', data: page } : null;
  }

  /**
   * 处理插件里的一个动作：返回新的页面；返回 null 表示「关掉面板」。
   *
   * 动作可以返回 undefined（插件自己刷了页面）——那就不发新页面。
   */
  async function action(id, actionId, value, update) {
    const record = records.get(id);
    if (!record || !isEnabled(id)) return null;
    const ctx = makeContext(record, update);
    try {
      const page = await record.instance.action?.(ctx, actionId, value);
      return page ?? null;
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」的动作失败：`, err?.message);
      return null;
    }
  }

  /** 插件的窗口/小部件要用的数据（自定义页面用）。 */
  async function data(id) {
    const record = records.get(id);
    if (!record) return null;
    const ctx = makeContext(record, null);
    try {
      return (await record.instance.data?.(ctx)) ?? null;
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」取数据失败：`, err?.message);
      return null;
    }
  }

  /** 插件的窗口/小部件的周期刷新（自定义页面用）。 */
  async function tick(id) {
    const record = records.get(id);
    if (!record || typeof record.instance.tick !== 'function') return undefined;
    const ctx = makeContext(record, null);
    try {
      return await record.instance.tick(ctx);
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」刷新失败：`, err?.message);
      return undefined;
    }
  }

  /** 自定义页面里的一个动作。 */
  async function act(id, actionId, payload) {
    const record = records.get(id);
    if (!record) return null;
    const ctx = makeContext(record, null);
    try {
      return (await record.instance.act?.(ctx, actionId, payload)) ?? null;
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」的动作失败：`, err?.message);
      throw err;
    }
  }

  /**
   * 插件页面的 URL 前缀。
   *
   * 内置插件在项目目录里（`/plugins/<id>/…`），
   * 用户自己的插件在 userData 里（`/__plugins__/<id>/…`）——
   * 后者由 app:// 协议的一个虚拟根提供。
   */
  function baseUrl(id) {
    const record = records.get(id);
    if (!record) return '';
    const prefix = record.source === 'user' ? '/__plugins__' : '/plugins';
    return `${prefix}/${record.manifest.id}`;
  }

  /**
   * 插件自带的那个页面，它**在不在**。
   *
   * 清单里写的路径可能指向一个不存在的文件（作者写错了、或者文件被删了）。
   * 这种情况**不能白屏**：宿主要退回积木界面，插件照样能用。
   *
   * 查的是磁盘上的真实路径（`record.dir` + 相对路径）——
   * 内置插件与用户插件都适用（用户插件的目录在 userData 里，也是真实路径）。
   */
  function pageExists(record, page) {
    if (!record || !page) return false;
    try {
      return statSync(join(record.dir, page)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 插件自带页面的完整 URL（**带缓存**）。
   *
   * 页面不在磁盘上时给空串：调用方据此退回积木界面，不开白窗口。
   *
   * 为什么要缓存：查盘要 statSync，而插件清单**每次刷新都会重建**
   * （面板打开、开关了插件……）——清单里带上页面地址就意味着
   * 每次刷新都要 statSync 一遍。缓存按插件 id 存，
   * 插件清单变了（加载了插件、开关了插件）就整个丢掉。
   */
  function pageUrlOf(id) {
    if (pageUrlCache.has(id)) return pageUrlCache.get(id);
    const record = records.get(id);
    if (!record) return '';
    const page = record.manifest.window?.page;
    if (!page || !pageExists(record, page)) {
      pageUrlCache.set(id, '');
      return '';
    }
    const url = appUrl(`${baseUrl(id)}/${page}?plugin=${encodeURIComponent(id)}`);
    pageUrlCache.set(id, url);
    return url;
  }

  /**
   * 让用户插件目录里的 `.js` 按 **ESM** 解析。
   *
   * userData 下没有 package.json，Node 会把 `.js` 当成 CommonJS——
   * 插件里那句 `export default` 就成了语法错误，而报错信息
   * （"Unexpected token 'export'"）完全指不出真正的原因。
   *
   * 给插件目录写一个 `{"type":"module"}` 标记就解决了。
   * **只在目录里真的有东西时才写**：没人装插件时不该在 userData 里
   * 多造一个目录。用户自己已经放了 package.json 的不动它——
   * 那说明他知道自己在干什么。
   */
  async function ensureUserPluginsAreEsm(dir) {
    let entries = [];
    try {
      entries = await readdir(dir);
    } catch {
      return; // 目录还没建：没有用户插件，也就没什么要标记的。
    }
    if (entries.length === 0) return;
    const marker = join(dir, 'package.json');
    try {
      await readFile(marker, 'utf8');
      return; // 已经有标记（或用户自己的）：不碰。
    } catch {
      // 没有 → 写一个。
    }
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(marker, JSON.stringify({ type: 'module' }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[desk-pet] 用户插件目录的模块标记写不了：', err?.message);
    }
  }

  /**
   * 插件提供的工具实现：name → 实现。
   *
   * `tools()` 是插件实例上的钩子（规格 §5.4）：它返回与清单**同名**的实现。
   * 插件没写这个钩子就没有工具。
   *
   * 插件的 `tools()` 抛错只影响它自己——记一行日志，
   * 不让一个插件的异常掀翻整个宿主。
   */
  async function collectToolImpls(record) {
    const instance = record.instance;
    if (!instance || typeof instance.tools !== 'function') return new Map();
    let list;
    try {
      list = await instance.tools(makeContext(record, null));
    } catch (err) {
      console.warn(`[desk-pet] 插件「${record.manifest.id}」的工具列表取不到：`, err?.message);
      return new Map();
    }
    const map = new Map();
    for (const impl of Array.isArray(list) ? list : []) {
      const name = String(impl?.name || '').trim();
      if (!name || typeof impl?.run !== 'function') {
        console.warn(`[desk-pet] 插件「${record.manifest.id}」给了一个不像工具的实现，丢掉`);
        continue;
      }
      map.set(name, impl);
    }
    return map;
  }

  /**
   * 把当前**启用**的插件提供的工具挂进工具表。
   *
   * 插件被关掉时它的工具要消失——「渐进式加载」就是这么自然：
   * agent 的系统提示词里只列当前启用的插件提供的工具，
   * 插件没开，模型就看不见它的工具，也不会去调它。
   *
   * **清单是契约**：清单里声明了但实例没实现同名实现 → 不注册；
   * 实例实现了但清单里没声明 → 也不注册（两边必须一致）。
   * 两种情况都留一行日志，插件作者还能继续跑。
   */
  async function syncPluginTools() {
    if (!tools) return;
    // 先把插件这一族全摘掉，再按启用状态重新挂上。
    // （内置工具没有 owner，摘不掉。）
    for (const id of records.keys()) tools.unregister(id);
    for (const record of records.values()) {
      const id = record.manifest.id;
      if (!isEnabled(id)) continue;
      const declared = record.manifest.tools || [];
      if (!declared.length) continue;
      let impls = toolImplCache.get(id);
      if (!impls) {
        impls = await collectToolImpls(record);
        toolImplCache.set(id, impls);
      }
      for (const decl of declared) {
        const impl = impls.get(decl.name);
        if (!impl) {
          console.warn(
            `[desk-pet] 插件「${id}」声明了工具「${decl.name}」但没有提供实现，这个工具不注册`
          );
          continue;
        }
        tools.register({ ...decl, run: impl.run }, { owner: id });
      }
      for (const name of impls.keys()) {
        if (!declared.some((d) => d.name === name)) {
          console.warn(
            `[desk-pet] 插件「${id}」实现了工具「${name}」但清单里没有声明，不注册`
          );
        }
      }
    }
  }

  /**
   * 发现并加载全部插件。
   *
   * 一个插件加载失败（清单坏了、入口抛错）只影响它自己：
   * 记一行日志，其余插件照常可用。
   */
  async function load() {
    const userDir = userPluginsDir || userPluginsPath(userDataDir);
    await ensureUserPluginsAreEsm(userDir);
    const roots = [
      { dir: bundledPluginsDir(rootDir), source: 'bundled' },
      { dir: userDir, source: 'user' },
    ];
    const discovered = await discoverPlugins(roots);
    for (const record of discovered) {
      try {
        const factory = await loadPluginFactory(record);
        const instance = factory(makeContext(record, null));
        if (!instance || typeof instance !== 'object') {
          throw new Error('工厂函数没有返回插件实例');
        }
        records.set(record.manifest.id, { ...record, instance });
        // 清单里的工具声明有毛病：记一行，插件本身照常加载。
        const toolErrors = record.manifest.toolErrors || [];
        if (toolErrors.length) {
          console.warn(
            `[desk-pet] 插件「${record.manifest.id}」的工具声明有问题：${toolErrors.join('；')}`
          );
        }
      } catch (err) {
        console.warn(`[desk-pet] 插件「${record.manifest.id}」加载失败：`, err?.message);
      }
    }
    console.log(
      `[desk-pet] 已加载 ${records.size} 个插件：${[...records.keys()].join('、')}`
    );
    // 插件提供的工具挂进 agent 的工具表。
    await syncPluginTools();
    // 插件刚加载出来：之前算过的页面地址（如果有）全部作废。
    invalidatePageUrls();
    return records.size;
  }

  return {
    load,
    list,
    listAll,
    open,
    action,
    data,
    tick,
    /**
     * 周期刷新：这一轮推什么（kind + 载荷）。
     *
     * 自带页面的插件推**数据**，声明式界面推**重算过的页面**——
     * 界面路由这一层只管「推给谁」，推什么由插件的形态决定。
     */
    refresh,
    act,
    baseUrl,
    isEnabled,
    setEnabled,
    /** 把插件分离成独立窗口 / 桌面小部件。 */
    openWindow: (id, mode) => windowOpener?.open(id, mode) || { ok: false, message: '窗口还没准备好' },
    /** 关掉某个插件的窗口。 */
    closeWindow: (id) => windowOpener?.close(id) || { ok: false },
    get: (id) => records.get(id) || null,
    /** 插件清单变了（有人开关了插件）：回调收到新的清单。 */
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** 把「开独立窗口」的能力接上（window.js 晚一步创建）。 */
    attachWindows: (opener) => {
      windowOpener = opener;
    },
    /**
     * 某个插件的界面开合了。
     *
     * 「开」= 第一个界面挂上来，「关」= 最后一个界面摘掉。
     * 录屏的快捷键靠它决定生不生效（见第二期计划）。
     */
    surfaceChanged: (pluginId, open) => {
      for (const cb of surfaceListeners) {
        try {
          cb(pluginId, open);
        } catch (err) {
          console.warn('[desk-pet] 界面开合的回调出错：', err?.message);
        }
      }
    },
    /** 订阅界面开合。返回取消订阅的函数。 */
    onSurfaceChange: (cb) => onSurfaceChange(cb),
    /**
     * 某个形态实际生效的窗口规格（尺寸、刷新间隔……）。
     *
     * 已经**解析**过了：清单里没写 `window` 段也会合成出一份默认的
     * ——「在新窗口打开」是所有插件都有的能力。
     */
    spec: (id, mode) => {
      const record = records.get(id);
      if (!record) return null;
      return resolveWindowSpec(record.manifest, mode);
    },
    /**
     * 插件自带的页面的完整 URL。
     *
     * 页面**不存在**时返回空串——调用方（窗口控制器、面板元数据）
     * 据此退回积木界面，而不是开一个白窗口。
     *
     * 带缓存：查盘一次就够，别在清单刷新的热路径上 statSync。
     */
    pageUrl: (id) => pageUrlOf(id),
  };
}
