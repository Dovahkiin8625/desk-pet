import { TOOL_RISK } from '../../shared/assistant.js';
import { searchPlugins } from '../../shared/fuzzy.js';

/**
 * 「打开插件界面」这个工具。
 *
 * 用户发一句话就能让桌宠把某个插件的界面打开：
 * 「帮我打开系统状态插件」→ 系统状态那个窗口就出来了。
 *
 * ## 它是宿主的能力，不是插件的能力
 *
 * 插件自己的工具由插件声明（清单里的 `tools`），
 * 这个不是——它属于宿主：只有宿主知道怎么开窗口、
 * 知道现在开着哪些插件。所以它没有 owner，
 * 插件被关掉时它也不会被摘掉。
 *
 * ## 名字对不上怎么办
 *
 * 用户说的多半不是插件的 id，而是它的名字或者顺口的话
 * （「系统状态」「看 CPU 的那个」）。所以这里按三档去找：
 * 完全一致 → 关键词命中 → 模糊匹配。
 * 全都找不到就把现在能打开的插件列出来喂回模型，
 * 它自己就能改用正确的名字再试一次。
 */

/**
 * 按一句话找到一个插件。
 *
 * @param {string} query 用户说的那个名字
 * @param {Array<{id: string, name: string, description?: string, keywords?: string[]}>} list
 * @returns {object|null} 找到的那个插件
 */
export function resolvePlugin(query, list) {
  const items = Array.isArray(list) ? list : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  // 一、id 或名字完全一致。
  const exact = items.find(
    (p) => String(p?.id || '').toLowerCase() === q || String(p?.name || '').toLowerCase() === q
  );
  if (exact) return exact;
  // 二、关键词命中（正着反着都算：「cpu监控」里有「cpu」）。
  const byKeyword = items.find((p) =>
    (Array.isArray(p?.keywords) ? p.keywords : []).some((k) => {
      const kk = String(k || '').toLowerCase();
      if (!kk) return false;
      return kk === q || q.includes(kk) || kk.includes(q);
    })
  );
  if (byKeyword) return byKeyword;
  // 三、模糊匹配（名字、关键词、描述一起找）。
  const hits = searchPlugins(query, items);
  return hits[0]?.plugin || null;
}

/**
 * 造「打开插件界面」这个工具。
 *
 * @param {object} options
 * @param {Function} [options.getPlugins] 现在能打开的插件清单
 * @param {Function} [options.openWindow] (pluginId) => { ok, message? }
 */
export function createPluginOpenTool({ getPlugins = () => [], openWindow = null } = {}) {
  return {
    name: 'plugin.open',
    label: '打开插件界面',
    description:
      '打开某个插件的界面窗口（比如系统状态、音乐播放器）。' +
      '参数 name 写插件的名字，也可以写它的关键词。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '插件的名字' },
      },
      required: ['name'],
    },
    // **只读**：开一个窗口不动用户的东西，
    // 所以「只读自动放行」那档策略下它不会再去要一次批准。
    risk: TOOL_RISK.READ,
    async run(args) {
      const name = String(args?.name || '').trim();
      if (!name) throw new Error('要打开哪个插件？给个 name');
      const list = getPlugins() || [];
      const target = resolvePlugin(name, list);
      if (!target) {
        const names = list
          .map((p) => String(p?.name || ''))
          .filter(Boolean)
          .join('、');
        throw new Error(
          `没有叫「${name}」的插件。现在能打开的有：${names || '（一个也没有）'}`
        );
      }
      const res = openWindow?.(target.id);
      if (!res?.ok) throw new Error(res?.message || `打不开「${target.name}」`);
      return {
        text: `已打开「${target.name}」的界面窗口。`,
        data: { pluginId: String(target.id || ''), name: String(target.name || '') },
      };
    },
  };
}
