/**
 * 剪贴板。
 *
 * 读剪贴板是异步的（Electron 45 的 clipboard.readText 返回 Promise），
 * 所以这个插件的 `page()` 是 **async** 的。
 *
 * 动作里必须 await —— 直接展开一个 Promise 会得到空对象，
 * 页面就没了（标题、块全空）。
 */
export default function createClipboardPlugin() {
  const page = async (ctx) => {
    const view = ctx.assistant.clipboardView();
    const clip = await ctx.assistant.readClipboard();
    return ctx.ui.makePage({
      pluginId: 'clipboard',
      title: '剪贴板',
      subtitle: view.enabled ? '助手开着：复制内容时我会提示一句' : '助手关着',
      blocks: [
        clip.ok ? ctx.ui.textBlock(`最近复制的是：${clip.text}`) : ctx.ui.emptyBlock('剪贴板是空的'),
        ctx.ui.toggleBlock('enabled', '剪贴板助手', view.enabled),
      ],
    });
  };

  return {
    page,
    async action(ctx, actionId, value) {
      if (actionId === 'enabled') {
        const r = ctx.assistant.setClipboardEnabled(value === 'true');
        return { ...(await page(ctx)), status: r.message };
      }
      return page(ctx);
    },
  };
}
