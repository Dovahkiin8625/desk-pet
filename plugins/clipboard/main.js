// plugins/clipboard/main.js
/**
 * 剪贴板：一个 CopyQ 式的剪贴板管理器。
 *
 * 四件事：
 *
 * 1. **记历史**：复制什么就记什么（可以关），历史**落盘**——
 *    `userData/clipboard-history.json`，图片字节单独放在 `userData/clipboard-images/`，
 *    重启还在。
 * 2. **不止文本**：纯文本、富文本（HTML / RTF）、**复制的文件**（Explorer 里
 *    Ctrl+C 的文件，粘贴时能在资源管理器里真贴出文件来）、**图片**（截个图直接进历史）。
 *    一条复制往往是多格式的（网页里复制一段话：text/plain + text/html 都有），
 *    全部存下来，贴出去时按原样写回去。
 * 3. **列出来**：固定的在最上面，其余按时间倒序。列表画在**自己的页面**里
 *    （pages/history.html），面板工作台与独立窗口装的是同一份。
 * 4. **贴出去**：双击一条 → 内容写回剪贴板 + 给刚才在用的那个窗口发 Ctrl+V。
 *
 * 设置（记录开关、留多少条、两个快捷键）都在**它自己的页面**里改，
 * 值交给宿主存（`ctx.host.setConfig`）——插件的配置不进设置窗口。
 *
 * 插件跑在**主进程**里（宿主用动态 import 加载它），所以 electron 的 API
 * 直接就能用：剪贴板、全局快捷键都在这儿。
 */
import { app, clipboard, ClipboardItem, nativeImage } from 'electron';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readHistory,
  writeHistory,
  imagesPath,
  writeImageFile,
  removeImageFiles,
  readImageFile,
  sweepImages,
} from './lib/store.js';
import { readSnapshot } from './lib/formats.js';
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
import { pasteToTarget, disposePasteHelper, warmPasteHelper } from './lib/paste.js';
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

  // ---------------------------------------------------------------------------
  // 读剪贴板（多格式）
  // ---------------------------------------------------------------------------

  /**
   * 读一次剪贴板，所有支持的格式都读出来。
   *
   * 给记录器的：返回值里既有**签名**（判断「是不是同一条内容」），
   * 也有完整的快照（新内容要记的东西都在里面：文本 / HTML / 文件列表 / 图片字节）。
   */
  async function grab() {
    let items;
    try {
      items = await clipboard.read();
    } catch {
      return { ok: false };
    }
    const item = (Array.isArray(items) ? items : []).find(
      (it) => it && Array.isArray(it.types) && it.types.length
    );
    if (!item) return { ok: true, signature: '' };
    const result = await readSnapshot(item, { nativeImage });
    if (result.empty) return { ok: true, signature: '' };
    if (result.tooBig) {
      // 签名照样给：记录器会把它记成「看过了」，不会每轮都重新读一遍大文件。
      return { ok: true, signature: result.signature, tooBig: true };
    }
    if (!result.ok) return { ok: false };
    return { ok: true, signature: result.snapshot.key, snapshot: result.snapshot, png: result.png };
  }

  const recorder = createRecorder({
    grab,
    // electron 的 clipboard.read 是异步的，返回 Promise。
    onEntry: (result) => {
      // 记历史是**后台**的事：失败了也不该把主进程带崩。
      void record(result).catch((err) => {
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
    // 顺手清扫一次没人认领的图片（「记了一半就崩了」的残骸）。
    void sweepImages(userDataDir, entries);
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

  /**
   * 换上一份新的列表并落盘。
   *
   * 淘汰（或删掉）的条目里如果有图片，它们的 PNG 要跟着删——
   * 否则图片目录会只进不出。
   */
  async function commit(next) {
    const before = entries;
    entries = next;
    const kept = new Set(next.map((entry) => entry.imageFile).filter(Boolean));
    const orphans = before
      .filter((entry) => entry.imageFile && !kept.has(entry.imageFile))
      .map((entry) => entry.imageFile);
    if (orphans.length) {
      // 删不掉也不碍事（下次启动 sweepImages 还会扫一遍）。
      void removeImageFiles(userDataDir, orphans);
    }
    await save();
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
  async function record(result) {
    if (result?.tooBig) {
      status = '复制的内容太大了（文本超过 256KB、图片超过 8MB），没记进历史';
      pushData();
      return;
    }
    const snap = result?.snapshot;
    if (!snap) return;
    await ensureHistory();
    // 内容和已有一条一模一样：图片字节不用重写（addEntry 会复用那条的 id）。
    const exists = entries.some((entry) => entry.key === snap.key);
    if (snap.kind === 'image' && result.png && snap.imageFile && !exists) {
      try {
        await writeImageFile(userDataDir, snap.imageFile, result.png);
      } catch (err) {
        console.warn('[剪贴板] 图片写不进磁盘，这条不记了：', err?.message || err);
        return;
      }
    }
    const next = addEntry(entries, snap, { max: settings().maxEntries });
    // 内容与上一条一样时，列表其实没变——不必写盘、不必重画。
    if (sameEntries(next, entries)) return;
    await commit(next);
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
   * @returns {Promise<object|null>} 贴的结果；一条都没有就是 null。
   */
  async function pasteLatest({ push = true } = {}) {
    await ensureHistory();
    const item = newestEntry(entries);
    if (!item) {
      status = '还没有复制过东西';
      if (push) pushData();
      return null;
    }
    const result = await pasteEntry(item);
    if (push) pushData();
    return result;
  }

  /**
   * 把一条贴出去：内容写回剪贴板（按原来的多格式写回去）+
   * 给刚才在用的那个窗口发 Ctrl+V。
   *
   * @param {object} item 历史里的一条
   */
  async function pasteEntry(item) {
    const data = {};
    if (item.text) data['text/plain'] = item.text;
    if (item.html) data['text/html'] = item.html;
    if (item.rtf) data['text/rtf'] = item.rtf;
    if (Array.isArray(item.files) && item.files.length) {
      // 资源管理器里 Ctrl+V 要的是 CF_HDROP：text/uri-list 就是它的 URI 形式。
      data['text/uri-list'] = item.files.map((file) => pathToFileURL(file).href).join('\r\n');
      // 兜底：不认 CF_HDROP 的应用（记事本、编辑器……）拿到的是路径文本，
      // 总比什么都贴不进去强。
      if (!item.text) data['text/plain'] = item.files.join('\r\n');
    }
    if (item.imageFile) {
      try {
        const bytes = await readImageFile(userDataDir, item.imageFile);
        data['image/png'] = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      } catch {
        status = '这条的图片文件读不到（可能被手动删了）';
      }
    }
    if (!Object.keys(data).length) {
      status = status || '这条的内容读不回来';
      return { ok: false, error: status };
    }
    // **先给记录器开后门**：写回剪贴板的那一下，
    // 不能被当成「用户刚复制的东西」又记一遍。
    recorder.ignore(item.key);
    recorder.muzzle?.(1200);
    try {
      await clipboard.write([new ClipboardItem(data)]);
    } catch (err) {
      status = `写不回剪贴板：${err?.message || err}`;
      return { ok: false, error: status };
    }
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
    if (open) {
      hotkeyArmed = true;
      // 用户多半是来贴东西的：趁界面开着把粘贴助手拉起来（预热），
      // 第一贴就不用付一遍 PowerShell 的启动 + C# 编译。
      warmPasteHelper(pasteScript);
    }
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

  /** 人类看的字节数。 */
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  /** 文件路径的最后一段。 */
  function fileName(file) {
    const parts = String(file || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(file || '');
  }

  /** 一条条目 → 给界面看的那份（正文截断、图片给 URL、格式给徽章）。 */
  function entryView(item) {
    const badges = [];
    if (item.html) badges.push('HTML');
    if (item.rtf) badges.push('RTF');
    const base = {
      id: item.id,
      kind: item.kind,
      badges,
      at: item.at,
      pinned: Boolean(item.pinned),
      len: item.kind === 'text' ? item.text.length : 0,
    };
    if (item.kind === 'image') {
      const size = formatBytes(item.imageBytes);
      const dims = item.imageWidth && item.imageHeight ? `${item.imageWidth}×${item.imageHeight}` : '';
      return {
        ...base,
        text: '',
        note: [dims, size].filter(Boolean).join(' · ') || '图片',
        image: `/__clipboard-images__/${item.imageFile}`,
      };
    }
    if (item.kind === 'files') {
      const names = item.files.map(fileName);
      const note =
        names.length <= 2
          ? names.join('、')
          : `${names[0]} 等 ${names.length} 个文件`;
      return {
        ...base,
        text: '',
        note,
        files: item.files,
      };
    }
    return {
      ...base,
      // 显示时截断：贴出去时按 id 找回来，用的是**全文**。
      text: item.text.length > DISPLAY_CHARS ? `${item.text.slice(0, DISPLAY_CHARS)}…` : item.text,
      note: item.text ? '' : badges.length ? '富文本片段' : '',
    };
  }

  /** 给界面的一份完整状态。 */
  function payload() {
    const cfg = settings();
    const list = listEntries(entries);
    return {
      entries: list.map((item) => entryView(item)),
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

  /**
   * 贴成功了就收起这个窗口（像 CopyQ：贴出去了，窗口也就没必要留着了）。
   *
   * 面板里没有独立窗口可关——closeWindow 那时什么都不做，面板照旧留着。
   */
  function dismissSelf() {
    ctx.host.closeWindow?.(ctx.plugin.id);
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
    // 贴成功了：界面（独立窗口）贴完就没必要留着，跟 CopyQ 一样收起来。
    // 贴不上（没找到目标窗口、写不回剪贴板……）就不动，
    // 底栏里那句提示语用户还得看得见。
    let pasted = false;
    switch (String(actionId)) {
      case 'paste': {
        const item = entries.find((entry) => entry.id === String(payloadIn.id || ''));
        if (!item) {
          status = '这条已经不在了';
          break;
        }
        // 只有真贴上去了才关窗：贴不上的话，窗口留着，
        // 底栏里那句「没有找到可以粘贴的窗口」用户还得看得见。
        const result = await pasteEntry(item);
        pasted = result?.ok === true;
        break;
      }
      case 'paste-latest': {
        const result = await pasteLatest({ push: false });
        pasted = result?.ok === true;
        break;
      }
      case 'pin': {
        await commit(togglePin(entries, String(payloadIn.id || '')));
        break;
      }
      case 'remove': {
        await commit(removeEntry(entries, String(payloadIn.id || '')));
        break;
      }
      case 'clear': {
        await commit(clearEntries());
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
    // 贴完就把独立窗口收起来（面板里是 no-op）。
    if (pasted) dismissSelf();
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
      await commit(trimEntries(entries, max));
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
    let pasted = false;
    switch (String(actionId)) {
      case 'paste': {
        const item = entries.find((entry) => entry.id === String(value || ''));
        if (item) {
          const result = await pasteEntry(item);
          pasted = result?.ok === true;
        } else {
          status = '这条已经不在了';
        }
        break;
      }
      case 'paste-latest': {
        const result = await pasteLatest({ push: false });
        pasted = result?.ok === true;
        break;
      }
      case 'pin': {
        await commit(togglePin(entries, String(value || '')));
        break;
      }
      case 'remove': {
        await commit(removeEntry(entries, String(value || '')));
        break;
      }
      case 'clear': {
        await commit(clearEntries());
        status = '历史清空了';
        break;
      }
      default:
        break;
    }
    // 贴完就把独立窗口收起来（面板里是 no-op）。
    if (pasted) dismissSelf();
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
                label: blockLabel(item),
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

  /** 积木按钮上那一行字（按类型来）。 */
  function blockLabel(item) {
    if (item.kind === 'image') {
      const size = formatBytes(item.imageBytes);
      return size ? `图片（${size}）` : '图片';
    }
    if (item.kind === 'files') {
      const names = item.files.map(fileName);
      return names.length <= 2 ? names.join('、') : `${names[0]} 等 ${names.length} 个文件`;
    }
    const text = String(item.text || '');
    if (!text.trim()) return item.html ? '富文本（HTML）' : '富文本（RTF）';
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
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
