import { readJson, writeJson } from '../store.js';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
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
import { canDetach, hasWidget, PLUGIN_WINDOW_MODE } from '../../shared/plugin.js';
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
}) {
  /** id → 插件记录。 */
  const records = new Map();
  /** 插件启用状态的变化（有人把某个插件关了/开了）。 */
  const listeners = new Set();
  /** 打开独立窗口的入口（window.js 装上来）。 */
  let windowOpener = null;

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
      },
    };
  }

  /** 插件有没有被关掉。 */
  function isEnabled(id) {
    return records.has(id) && !disabled.has(id);
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
      const page = await record.instance.page?.(ctx);
      return page || null;
    } catch (err) {
      console.warn(`[desk-pet] 插件「${id}」打开失败：`, err?.message);
      return null;
    }
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
      } catch (err) {
        console.warn(`[desk-pet] 插件「${record.manifest.id}」加载失败：`, err?.message);
      }
    }
    console.log(
      `[desk-pet] 已加载 ${records.size} 个插件：${[...records.keys()].join('、')}`
    );
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
    /** 窗口/小部件的规格（尺寸、刷新间隔……）。 */
    spec: (id, mode) => {
      const record = records.get(id);
      if (!record) return null;
      const m = record.manifest;
      return mode === PLUGIN_WINDOW_MODE.WIDGET ? m.widget : m.window;
    },
  };
}
