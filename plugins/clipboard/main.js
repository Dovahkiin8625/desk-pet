// plugins/clipboard/main.js
/**
 * 剪贴板：一个 CopyQ 式的剪贴板管理器。
 *
 * 三件事：
 *
 * 1. **记历史**：复制什么就记什么（可以关），历史**落盘**——
 *    `userData/clipboard-history.json`，重启还在。
 * 2. **列出来**：固定的在最上面，其余按时间倒序。列表画在**自己的页面**里
 *    （pages/history.html），面板工作台与独立窗口装的是同一份。
 * 3. **贴出去**：双击一条 → 内容写回剪贴板 + 给刚才在用的那个窗口发 Ctrl+V。
 *
 * 设置（记录开关、留多少条、两个快捷键）都在**它自己的页面**里改，
 * 值交给宿主存（`ctx.host.setConfig`）——插件的配置不进设置窗口。
 *
 * 插件跑在**主进程**里（宿主用动态 import 加载它），所以 electron 的 API
 * 直接就能用：剪贴板、全局快捷键都在这儿。
 */
import { app, clipboard } from 'electron';
import { join } from 'node:path';
import { readHistory, writeHistory } from './lib/store.js';
import { createRecorder } from './lib/recorder.js';
import {
  addEntry,
  clearEntries,
  listEntries,
  newestEntry,
  removeEntry,
  sameEntries,
  togglePin,
  trimEntries,
  DEFAULT_MAX_ENTRIES,
} from './lib/history.js';
import { isValidAccel } from './lib/accelerator.js';
import { pasteToTarget, disposePasteHelper } from './lib/paste.js';
import { setHotkeys, clearHotkeys } from './lib/hotkey.js';

/** 界面上显示时，一条内容最多显示多少字（贴出去时还是全文）。 */
const DISPLAY_CHARS = 500;

/** 积木页面（自己的页面不在磁盘上时的退路）里最多列几条。 */
const FALLBACK_LIMIT = 30;

export default function createClipboardPlugin(ctx) {
  const pluginDir = ctx.plugin.dir;
  const userDataDir = app.getPath('userData');
  const pasteScript = join(pluginDir, 'lib', 'paste.ps1');

  /** 历史条目（内存里一份，磁盘上还有一份）。 */
  let entries = [];
  /** 历史读盘了吗。 */
  let loaded = false;
  /** 底部那行提示：做完某个动作的结果。 */
  let status = '';
  /** 快捷键注册不成功的理由（界面上显示）。 */
  let hotkeyError = '';
  /**
   * 用户打开过界面吗。
   *
   * 没打开过就**不抢**快捷键：一个从来没人用过的插件，
   * 一开机就占着 Ctrl+Shift+V，很讨人厌。
   */
  let hotkeyArmed = false;
  /** 现在注册着的快捷键（变了才重注册）。 */
  let hotkeyState = { active: false, show: '', paste: '' };
  /** 写盘的队列：两个写同时来会抢同一个 .tmp 文件，内容可能串。 */
  let chain = Promise.resolve();

  const recorder = createRecorder({
    // electron 的 clipboard.readText 在 45 里是异步的，返回 Promise。
    readText: () => clipboard.readText(),
    onText: (text) => {
      // 记历史是**后台**的事：失败了也不该把主进程带崩。
      void record(text).catch((err) => {
        console.warn('[剪贴板] 记历史失败：', err?.message || err);
      });
    },
  });

  // -------------------------------------------------------------------------
  // 存与取
  // -------------------------------------------------------------------------

  /** 读盘（只读一次，之后走内存）。 */
  async function ensureHistory() {
    if (loaded) return entries;
    entries = await readHistory(userDataDir);
    loaded = true;
    return entries;
  }

  /** 写盘。排队：两个写同时来会抢同一个 .tmp 文件。 */
  function save() {
    const snapshot = entries;
    return enqueue(() => writeHistory(userDataDir, snapshot));
  }

  /** 排队：一个没做完，下一个别开始。 */
  function enqueue(task) {
    const result = chain.then(task, task);
    // 链子自己不能断：前一个失败了，后一个照样要能做。
    chain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  /**
   * 当前设置。
   *
   * 值在宿主那边（plugins.json 的 config 段）——插件自己不存，
   * 于是「设置窗口」与「插件页面」看到的是同一份，不会各说各话。
   *
   * 清单里声明的默认值兜底：宿主还没登记这个插件时
   * （工厂函数跑的那一刻就是如此），读配置读不到东西。
   */
  function settings() {
    const cfg = ctx.config || {};
    const defaults = {};
    for (const item of ctx.plugin.manifest?.settings || []) {
      defaults[item.key] = item.default;
    }
    const value = (key) => (cfg[key] === undefined ? defaults[key] : cfg[key]);
    const max = Number(value('maxEntries'));
    return {
      record: value('record') !== false,
      maxEntries: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_ENTRIES,
      showHotkey: String(value('showHotkey') ?? '').trim(),
      pasteHotkey: String(value('pasteHotkey') ?? '').trim(),
    };
  }

  // -------------------------------------------------------------------------
  // 记录
  // -------------------------------------------------------------------------

  /** 复制到东西了：记一条。 */
  async function record(text) {
    await ensureHistory();
    const next = addEntry(entries, text, { max: settings().maxEntries });
    // 内容与上一条一样时，列表其实没变——不必写盘、不必重画。
    if (sameEntries(next, entries)) return;
    entries = next;
    await save();
    pushData();
  }

  // -------------------------------------------------------------------------
  // 快捷键
  // -------------------------------------------------------------------------

  /** 快捷键什么时候生效。 */
  function syncHotkeys() {
    const cfg = settings();
    const want = hotkeyArmed && ctx.host.isEnabled('clipboard');
    if (!want) {
      if (hotkeyState.active) {
        clearHotkeys();
        hotkeyState = { active: false, show: '', paste: '' };
      }
      hotkeyError = '';
      return;
    }
    // 状态没变就别重注册：重注册要把快捷键让出去再抢回来，
    // 中间那一下按键是按不上的。
    if (hotkeyState.active && hotkeyState.show === cfg.showHotkey && hotkeyState.paste === cfg.pasteHotkey) {
      return;
    }
    hotkeyState = { active: true, show: cfg.showHotkey, paste: cfg.pasteHotkey };

    const wanted = [];
    const invalid = [];
    if (cfg.showHotkey) {
      if (isValidAccel(cfg.showHotkey)) {
        wanted.push({ accel: cfg.showHotkey, onTrigger: () => void showWindow() });
      } else {
        invalid.push(cfg.showHotkey);
      }
    }
    if (cfg.pasteHotkey) {
      if (isValidAccel(cfg.pasteHotkey)) {
        wanted.push({ accel: cfg.pasteHotkey, onTrigger: () => void pasteLatest() });
      } else {
        invalid.push(cfg.pasteHotkey);
      }
    }

    const result = setHotkeys(wanted);
    const failed = [...invalid, ...result.failed];
    hotkeyError = failed.length
      ? `快捷键 ${failed.join('、')} 用不了——要么写法不对，要么已经被别的程序占着了`
      : '';
  }

  /** 打开（或叫到前台）剪贴板自己的窗口。 */
  function showWindow() {
    const result = ctx.host.openWindow(ctx.plugin.id, 'window');
    if (!result?.ok) {
      status = result?.message || '窗口开不出来';
      pushData();
    }
  }

  /**
   * 贴最近复制的那一条。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.push] 贴完推一份状态（快捷键触发的要推，
   *   界面上点的不用——动作的包已经带着新状态了）。
   */
  async function pasteLatest({ push = true } = {}) {
    await ensureHistory();
    const item = newestEntry(entries);
    if (!item) {
      status = '还没有复制过东西';
      if (push) pushData();
      return;
    }
    await pasteEntry(item);
    if (push) pushData();
  }

  /**
   * 把一条贴出去：写回剪贴板 + 给刚才在用的那个窗口发 Ctrl+V。
   *
   * @param {object} item 历史里的一条
   */
  async function pasteEntry(item) {
    const text = item.text;
    // **先给记录器开后门**：内容写回剪贴板的那一下，
    // 不能被当成「用户刚复制的东西」又记一遍。
    recorder.ignore(text);
    await clipboard.writeText(text);
    const result = await pasteToTarget({ scriptPath: pasteScript, ourPid: process.pid });
    status = result.ok
      ? `已粘贴到「${result.title || '刚才那个窗口'}」`
      : result.error || '贴不了';
    return result;
  }

  // -------------------------------------------------------------------------
  // 开着还是关着
  // -------------------------------------------------------------------------

  /** 记录开关：关了就不再往历史里存。 */
  function syncRecorder() {
    // **插件被关掉了就不记**：用户把它关掉，就是不想要它记。
    const want = settings().record && ctx.host.isEnabled('clipboard');
    if (want && !recorder.isRunning()) recorder.start();
    else if (!want && recorder.isRunning()) recorder.stop();
  }

  /**
   * 盯着「插件是不是被关掉了」。
   *
   * 设置窗口里把插件关掉时，宿主会关掉**它自己**的插件窗口；
   * 我们自己起的记录器它管不着——插件关了就该真的什么都不干。
   */
  const watchTimer = setInterval(() => {
    syncRecorder();
    syncHotkeys();
  }, 2000);
  watchTimer.unref?.();

  // 界面开合：用户打开过剪贴板，快捷键就一直有效
  //（面板失焦会自己收起来——「不开界面也能按」正是快捷键的意义）。
  ctx.host.onSurfaceChange?.((pluginId, open) => {
    if (pluginId !== 'clipboard') return;
    if (open) hotkeyArmed = true;
    syncHotkeys();
  });

  app.on('before-quit', () => {
    recorder.stop();
    clearHotkeys();
    clearInterval(watchTimer);
    void disposePasteHelper();
  });

  // 一装上就开始记（插件开着才记）。
  //
  // **等一拍再开始**：工厂函数跑的时候，宿主还没把这个插件登记进去
  // （`ctx.host.isEnabled` 那会儿问不到），登记好了才知道自己开着没有。
  // 晚一拍开始，剪贴板的「基准」才取对——取晚了就把用户刚复制的那条
  // 当成了旧内容（于是它永远不会被记下来）。
  setTimeout(() => syncRecorder(), 0);

  // -------------------------------------------------------------------------
  // 界面
  // -------------------------------------------------------------------------

  /** 给界面的一份完整状态。 */
  function payload() {
    const cfg = settings();
    const list = listEntries(entries);
    return {
      entries: list.map((item) => ({
        id: item.id,
        // 显示时截断：贴出去时按 id 找回来，用的是**全文**。
        text: item.text.length > DISPLAY_CHARS ? `${item.text.slice(0, DISPLAY_CHARS)}…` : item.text,
        len: item.text.length,
        at: item.at,
        pinned: Boolean(item.pinned),
      })),
      total: entries.length,
      pinnedCount: entries.filter((item) => item.pinned).length,
      settings: cfg,
      // 助手那边开着吗（复制时它会提示一句）。
      assistantEnabled: Boolean(ctx.assistant?.clipboardView?.()?.enabled),
      hotkeyError,
      status,
    };
  }

  /** 把最新的一份状态推给所有开着这个插件的界面。 */
  function pushData() {
    ctx.push(payload());
  }

  /** 标题那几个字段（自己的页面用）。**要便宜**：别在这儿读盘。 */
  async function meta() {
    await ensureHistory();
    return {
      title: '剪贴板',
      // **不写条数**：标题栏那行字只在打开时算一次，
      // 写着「12 条历史」过一会儿就变成假的了。
      subtitle: '复制过的东西都在这儿',
      // **不带状态**：自己的页面底部已经有一行提示了，
      // 再给宿主一行，同一句话会在面板里出现两次。
    };
  }

  /** 自己页面的首份数据。 */
  async function data() {
    await ensureHistory();
    return payload();
  }

  /**
   * 自己页面里的一个动作。
   *
   * 回的是**动作之后的新状态**：界面照着它重画，
   * 不用自己猜该变成什么样（也就不会有两套同步逻辑）。
   */
  async function act(currentCtx, actionId, body) {
    await ensureHistory();
    const payloadIn = body && typeof body === 'object' ? body : {};
    switch (String(actionId)) {
      case 'paste': {
        const item = entries.find((entry) => entry.id === String(payloadIn.id || ''));
        if (!item) {
          status = '这条已经不在了';
          break;
        }
        await pasteEntry(item);
        break;
      }
      case 'paste-latest': {
        await pasteLatest({ push: false });
        break;
      }
      case 'pin': {
        entries = togglePin(entries, String(payloadIn.id || ''));
        await save();
        break;
      }
      case 'remove': {
        entries = removeEntry(entries, String(payloadIn.id || ''));
        await save();
        break;
      }
      case 'clear': {
        entries = clearEntries();
        await save();
        status = '历史清空了';
        break;
      }
      case 'setting': {
        await setSetting(String(payloadIn.key || ''), payloadIn.value);
        break;
      }
      case 'assistant': {
        // 助手那边「复制时提示一句」的开关（与历史记录是**两件事**）。
        const on = payloadIn.on === true || payloadIn.on === 'true';
        const result = ctx.assistant?.setClipboardEnabled?.(on);
        if (result && result.message) status = result.message;
        break;
      }
      default:
        break;
    }
    const next = payload();
    // 推一份：别的界面（面板里改的、独立窗口里看的）也要跟着变。
    pushData();
    return next;
  }

  /**
   * 改一个设置。
   *
   * 值交给宿主存（plugins.json）——插件不自己存一份，
   * 于是「设置窗口」与「插件页面」看到的是同一份。
   */
  async function setSetting(key, value) {
    if (key === 'record') {
      const result = await ctx.host.setConfig({ record: value === true || value === 'true' });
      if (result && !result.ok) status = result.message || '设置没存上';
      syncRecorder();
      return;
    }
    if (key === 'maxEntries') {
      const n = Number(value);
      const max = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ENTRIES;
      const result = await ctx.host.setConfig({ maxEntries: max });
      if (result && !result.ok) {
        status = result.message || '设置没存上';
        return;
      }
      // 立刻按新的上限裁一遍：留着 300 条而上限改成 50 时，
      // 不裁的话界面上还是 300 条。
      entries = trimEntries(entries, max);
      await save();
      return;
    }
    if (key === 'showHotkey' || key === 'pasteHotkey') {
      const accel = String(value ?? '').trim();
      const result = await ctx.host.setConfig({ [key]: accel });
      if (result && !result.ok) {
        status = result.message || '设置没存上';
        return;
      }
      // 用户刚设的快捷键：得**立刻**能用（不然得再开一次界面才生效）。
      hotkeyArmed = true;
      syncHotkeys();
    }
  }

  // -------------------------------------------------------------------------
  // 积木页面（自己的页面不在磁盘上时的退路）
  // -------------------------------------------------------------------------

  /** 积木页面里的一个动作。 */
  async function action(currentCtx, actionId, value) {
    await ensureHistory();
    switch (String(actionId)) {
      case 'paste': {
        const item = entries.find((entry) => entry.id === String(value || ''));
        if (item) await pasteEntry(item);
        else status = '这条已经不在了';
        break;
      }
      case 'paste-latest': {
        await pasteLatest({ push: false });
        break;
      }
      case 'pin': {
        entries = togglePin(entries, String(value || ''));
        await save();
        break;
      }
      case 'remove': {
        entries = removeEntry(entries, String(value || ''));
        await save();
        break;
      }
      case 'clear': {
        entries = clearEntries();
        await save();
        status = '历史清空了';
        break;
      }
      default:
        break;
    }
    return page(currentCtx);
  }

  /** 积木页面：页面文件不在时的退路（不会白屏）。 */
  async function page(currentCtx) {
    await ensureHistory();
    const list = listEntries(entries).slice(0, FALLBACK_LIMIT);
    return ctx.ui.makePage({
      pluginId: 'clipboard',
      title: '剪贴板',
      subtitle: entries.length ? `${entries.length} 条历史` : '还没有复制过东西',
      status,
      blocks: [
        list.length
          ? ctx.ui.listBlock(
              list.map((item) => ({
                id: item.id,
                label: item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text,
                hint: item.pinned ? '固定' : timeLabel(item.at),
                actionId: 'paste',
                removeId: 'remove',
              }))
            )
          : ctx.ui.emptyBlock('还没有复制过东西'),
        ctx.ui.buttonsBlock([
          { id: 'paste-latest', label: '粘贴最近一条', primary: true },
          { id: 'clear', label: '清空历史' },
        ]),
      ],
    });
  }

  return { page, action, meta, data, act };
}

/** 一个时间戳显示成「14:32」（今天）或「11-08 14:32」（别的日子）。 */
function timeLabel(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${mmdd} ${hh}:${mm}`;
}
