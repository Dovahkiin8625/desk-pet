// plugins/translate/main.js
/**
 * 翻译插件。
 *
 * 干的事：把**面板输入框里**那段文字译成另一种语言，译文显示在插件自己的页面上。
 *
 * 怎么用：
 *
 * 1. 双击桌宠打开面板（输入框里已经填好了剪贴板里最近的文字）；
 * 2. 结果列表里有一行「翻译「xxx」」，按回车；
 * 3. 插件打开，输入框里那段文字被翻好，译文就在页面上。
 *
 * 也可以在插件的页面里自己改文字再翻。
 *
 * 两个引擎（设置里切）：
 *
 * - **大模型**：用设置里已经配好的 API Key（MiniMax 等 OpenAI 兼容的接口）。
 *   质量好，不用多填任何东西。
 * - **公共接口**：Google 那个不用 key 的免费端点。不花钱，
 *   但要能连上——连不上时页面上会说明白。
 *
 * 译成什么语言也是设置里定的：默认自动（外文→中文，中文→英语）。
 *
 * 另外：
 *
 * - **自动变量命名**（默认关的设置项）：译文是能当变量名的英文短语时，
 *   页面上自动给出小驼峰 / 大驼峰两种写法；
 * - 译文点击即复制到剪贴板（页面浮出「已复制到剪贴板」）。
 */
import {
  LANGUAGES,
  TARGET_AUTO,
  TRANSLATE_SYSTEM,
  buildPrompt,
  resolveTarget,
  translateWithPublic,
} from './lib/translate.js';
import { variableNamesFor } from './lib/variables.js';
import { writeClipboard } from './lib/clipboard.js';

/** 引擎的名字（设置里存的就是它）。 */
const ENGINE_LLM = '大模型';
const ENGINE_PUBLIC = '公共接口';

export default function createTranslatePlugin(ctx) {
  /**
   * 当前设置。
   *
   * `ctx.config` 是活的：用户改了设置，这里读到的就是新的。
   */
  function settings() {
    const cfg = ctx.config || {};
    return {
      engine: String(cfg.engine || ENGINE_LLM),
      target: String(cfg.target || TARGET_AUTO),
      autoVariableName: cfg.autoVariableName === true || cfg.autoVariableName === 'true',
    };
  }

  /**
   * 上一次翻译的结果。
   *
   * 同一个 key（引擎 + 目标语言 + 原文）只翻一次：
   * 宿主的 `data()` 会被问两遍（面板自己一次、页面自己一次），
   * 不缓存的话一次打开要花两份钱。
   */
  let cache = { key: '', result: '', status: '', busy: false };

  /** 缓存的 key：换了任何一个东西就是另一段译文。 */
  function cacheKey(text, cfg) {
    return `${cfg.engine}|${cfg.target}|${text}`;
  }

  /** 面板输入框里那段文字。 */
  function sourceText() {
    return String(ctx.host.getInputText?.() || '').trim();
  }

  /** 给界面看的一份状态。 */
  function payload(text) {
    const cfg = settings();
    const key = cacheKey(text, cfg);
    const hit = cache.key === key;
    const target = resolveTarget(text, cfg.target);
    const result = hit ? cache.result : '';
    // 自动变量命名开着、译文能当变量名：给出小驼峰 / 大驼峰两种写法。
    const variables =
      cfg.autoVariableName && result ? variableNamesFor(result) : null;
    return {
      text,
      result,
      busy: hit ? cache.busy : false,
      status: hit ? cache.status : '',
      engine: cfg.engine,
      target: cfg.target,
      autoVariableName: cfg.autoVariableName,
      variables,
      // 译成什么、原文是什么语：页面上要写清楚。
      targetName: target.name,
      sourceIsChinese: target.source === 'zh',
      engines: [ENGINE_LLM, ENGINE_PUBLIC],
      languages: LANGUAGES.map((item) => item.label),
    };
  }

  /** 真的去翻。 */
  async function runTranslation(text, cfg) {
    const target = resolveTarget(text, cfg.target);
    try {
      if (cfg.engine === ENGINE_PUBLIC) {
        const result = await translateWithPublic(text, target.code);
        return { ok: true, text: result };
      }
      const result = await ctx.assistant.complete?.(buildPrompt(text, target.name), {
        system: TRANSLATE_SYSTEM,
      });
      if (!result?.ok) return { ok: false, message: result?.message || '翻译失败' };
      const translated = String(result.text || '').trim();
      if (!translated) return { ok: false, message: '模型没有给出译文' };
      return { ok: true, text: translated };
    } catch (err) {
      return { ok: false, message: err?.message || '翻译失败' };
    }
  }

  /**
   * 开头翻一次（不等它翻完）。
   *
   * 页面拿到的是「翻译中…」的状态，译好了再推一份过去——
   * 让用户等着一个几秒钟的请求，界面不该卡住。
   */
  function startTranslation(text, cfg) {
    const key = cacheKey(text, cfg);
    if (!text || cache.key === key) return;
    cache = { key, result: '', status: '翻译中…', busy: true };
    void runTranslation(text, cfg).then((result) => {
      // 期间用户又改了东西：这一份译文已经过期了，扔掉。
      if (cache.key !== key) return;
      cache = {
        key,
        result: result.ok ? result.text : '',
        status: result.ok ? '' : result.message,
        busy: false,
      };
      ctx.push(payload(text));
    });
  }

  /** 自己页面里的首份数据。 */
  async function data() {
    const text = sourceText();
    const cfg = settings();
    startTranslation(text, cfg);
    return payload(text);
  }

  /** 自己页面里的一个动作。 */
  async function act(currentCtx, actionId, body) {
    const input = body && typeof body === 'object' ? body : {};
    const action = String(actionId);
    if (action === 'translate') {
      const text = String(input.text ?? sourceText()).trim();
      const cfg = settings();
      if (!text) {
        cache = { key: '', result: '', status: '没有要翻译的文字', busy: false };
        return payload('');
      }
      // 重新翻一遍：先摆「翻译中…」，翻好了再推一份。
      cache = { key: cacheKey(text, cfg), result: '', status: '翻译中…', busy: true };
      ctx.push(payload(text));
      const result = await runTranslation(text, cfg);
      cache = {
        key: cacheKey(text, cfg),
        result: result.ok ? result.text : '',
        status: result.ok ? '' : result.message,
        busy: false,
      };
      return payload(text);
    }
    if (action === 'setting') {
      const key = String(input.key || '');
      const value = input.value ?? '';
      if (key === 'autoVariableName') {
        // 只影响变量命名不影响译文：存上就行，不用重翻。
        const saved = await ctx.host.setConfig({ [key]: value });
        if (saved && saved.ok === false) {
          cache = { ...cache, status: saved.message || '设置没存上', busy: false };
        }
        return payload(String(input.text ?? sourceText()));
      }
      if (key === 'engine' || key === 'target') {
        const saved = await ctx.host.setConfig({ [key]: String(value) });
        if (saved && saved.ok === false) {
          cache = { ...cache, status: saved.message || '设置没存上', busy: false };
          return payload(String(input.text ?? sourceText()));
        }
        // 设置变了：之前那段译文作废，用新的设置重翻一遍。
        const text = String(input.text ?? sourceText()).trim();
        cache = { key: '', result: '', status: '', busy: false };
        startTranslation(text, settings());
        return payload(text);
      }
      return payload(String(input.text ?? sourceText()));
    }
    if (action === 'copy') {
      // 把文字写进剪贴板：译文、变量名都走这条（页面上点一下就复制）。
      const text = String(input.text ?? '');
      let copied;
      if (!text.trim()) {
        copied = { ok: false, message: '没有可复制的东西' };
      } else {
        try {
          await writeClipboard(text);
          copied = { ok: true, message: '已复制到剪贴板' };
        } catch (err) {
          copied = { ok: false, message: `复制不了：${err?.message || err}` };
        }
      }
      return { ...payload(String(input.source ?? sourceText())), copied };
    }
    return payload(sourceText());
  }

  /** 标题那几个字段（自己的页面用）。**要便宜**：别在这儿翻译。 */
  async function meta() {
    return {
      title: '翻译',
      subtitle: '把输入框里的文字译成另一种语言',
    };
  }

  /** 积木页面（自己的页面不在磁盘上时的退路）。 */
  async function page(currentCtx) {
    const text = sourceText();
    const cfg = settings();
    const key = cacheKey(text, cfg);
    const hit = cache.key === key;
    const result = hit ? cache.result : '';
    const variables = cfg.autoVariableName && result ? variableNamesFor(result) : null;
    return currentCtx.ui.makePage({
      pluginId: 'translate',
      title: '翻译',
      subtitle: text ? `译成${resolveTarget(text, cfg.target).name}` : '输入框里没有文字',
      status: hit ? cache.status : '',
      blocks: [
        currentCtx.ui.heroBlock({
          icon: 'globe',
          title: '翻译',
          subtitle: variables
            ? `变量名：${variables.lower}（小驼峰） / ${variables.upper}（大驼峰）`
            : '把输入框里的文字译成另一种语言',
        }),
        currentCtx.ui.inputBlock('translate', '要翻译的文字…', '翻译', text),
        ...(result ? [currentCtx.ui.textBlock(result)] : []),
        ...(result
          ? [currentCtx.ui.buttonsBlock([{ id: 'copy', label: '复制译文', icon: 'clipboard' }])]
          : []),
      ],
    });
  }

  /** 积木页面里的一个动作。 */
  async function action(currentCtx, actionId, value) {
    if (String(actionId) === 'copy') {
      // 复制译文：积木页按钮走这条——与 iframe 页面的 copy 动作同一件事。
      const text = String(cache.result || '');
      if (!text.trim()) return { ...page(currentCtx), status: '没有可复制的东西' };
      try {
        await writeClipboard(text);
        return { ...page(currentCtx), status: '已复制到剪贴板' };
      } catch (err) {
        return { ...page(currentCtx), status: `复制不了：${err?.message || err}` };
      }
    }
    if (String(actionId) === 'translate') {
      const text = String(value || '').trim();
      if (text) {
        const cfg = settings();
        cache = { key: cacheKey(text, cfg), result: '', status: '翻译中…', busy: true };
        const result = await runTranslation(text, cfg);
        cache = {
          key: cacheKey(text, cfg),
          result: result.ok ? result.text : '',
          status: result.ok ? '' : result.message,
          busy: false,
        };
      }
    }
    return page(currentCtx);
  }

  return { page, action, meta, data, act };
}
