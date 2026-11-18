// plugins/toolbox/main.js
/**
 * 工具箱插件。
 *
 * 五个常用小工具：JSON 格式化/压缩/校验、Base64 / URL 编解码、
 * 时间戳转换、正则表达式测试、Token 估算。
 *
 * 工具本身是纯函数（lib/tools.js），页面直接 import 来实时算，
 * 主进程这边只管剪贴板与积木界面的退路。
 */
import { writeClipboard } from './lib/clipboard.js';

export default function createToolboxPlugin() {
  /** 积木界面退路（自己的页面不在磁盘上时靠它画界面）。 */
  async function page(ctx) {
    return ctx.ui.makePage({
      pluginId: 'toolbox',
      title: '工具箱',
      subtitle: 'JSON、编解码、时间戳、正则、Token 估算',
      blocks: [ctx.ui.textBlock('工具箱')],
    });
  }

  async function action(ctx) {
    return page(ctx);
  }

  /** 标题那几个字段（自己的页面用）。**要便宜**。 */
  async function meta() {
    return { title: '工具箱', subtitle: 'JSON、编解码、时间戳、正则、Token 估算' };
  }

  async function data() {
    return {};
  }

  /** 自己页面里的动作：目前只用到复制。 */
  async function act(ctx, actionId, body) {
    const input = body && typeof body === 'object' ? body : {};
    if (String(actionId) === 'copy') {
      const text = String(input.text ?? '');
      if (!text.trim()) return { copied: { ok: false, message: '没有可复制的东西' } };
      try {
        await writeClipboard(text);
        return { copied: { ok: true, message: '已复制到剪贴板' } };
      } catch (err) {
        return { copied: { ok: false, message: `复制不了：${err?.message || err}` } };
      }
    }
    return {};
  }

  return { page, action, meta, data, act };
}
