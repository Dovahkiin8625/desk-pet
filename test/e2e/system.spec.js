import { test, expect } from '@playwright/test';
import { launchApp, collectErrors } from './helpers.js';

/**
 * 系统级功能（第六部分）的端到端用例。
 *
 * 本任务先只放「总音量」这一条：它要证明的是
 * 「主进程是唯一的状态来源」——设置窗口改的值，
 * 经主进程推到渲染层，渲染层把它用在自己的主增益上。
 */
test('总音量传到了渲染层', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    await ctx.win.evaluate(async () => {
      await window.pet.saveAssistantPrefs({ sound: { volume: 0.3 } });
    });
    await ctx.win.waitForFunction(() => window.__pet.volume === 0.3, null, { timeout: 10000 });
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
