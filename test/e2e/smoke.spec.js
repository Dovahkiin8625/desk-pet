import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers.js';

test('应用能启动并打开窗口', async () => {
  const ctx = await launchApp();
  try {
    expect(await ctx.win.title()).toBe('Desk Pet');
    const size = await ctx.win.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));
    expect(size.w).toBe(300);
    expect(size.h).toBe(560);
  } finally {
    await ctx.close();
  }
});

test('userData 目录不存在时自动创建', async () => {
  // app.setPath 要求目录已存在，主进程会先创建它。
  const base = join(tmpdir(), `desk-pet-e2e-new-${Date.now()}`);
  const target = join(base, 'nested', 'deep');
  expect(existsSync(target)).toBe(false);

  const ctx = await launchApp({ env: { DESK_PET_USER_DATA: target } });
  try {
    expect(await ctx.win.title()).toBe('Desk Pet');
    expect(existsSync(target)).toBe(true);
  } finally {
    await ctx.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('渲染层经 app:// 协议加载且窗口透明置顶', async () => {
  const ctx = await launchApp();
  try {
    const info = await ctx.win.evaluate(() => ({
      url: location.href,
      ready: window.__pet?.ready === true,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }));
    expect(info.url).toContain('app://bundle/src/renderer/index.html');
    expect(info.ready).toBe(true);
    expect(info.bodyBg).toContain('rgba(0, 0, 0, 0)');

    // 置顶只能从主进程侧断言：渲染层拿不到 BrowserWindow。
    //
    // 但 isAlwaysOnTop() 并非在所有 Windows 会话里都可靠：
    // 在没有交互桌面的会话里，setAlwaysOnTop(true) 根本不生效，
    // 连构造参数 alwaysOnTop: true 也不体现出来（实测普通窗口同样返回 false）。
    // 所以先用一次性普通窗口探测「这个环境是否支持置顶」，
    // 不支持就跳过这条断言——而不是让整套测试因为环境而变红。
    const topmostSupported = await ctx.app.evaluate(({ BrowserWindow }) => {
      // 探测窗口必须与真实桌宠窗口**同形**：已显示 + 构造参数 alwaysOnTop。
      // 用「隐藏且不带构造参数」的窗口去探测，在真实窗口其实能置顶的环境里
      // 也会返回 false——那会让这条断言静默退化成空操作，套件全绿却什么都没断言。
      const probe = new BrowserWindow({ show: true, alwaysOnTop: true, width: 80, height: 60 });
      probe.setAlwaysOnTop(true);
      const ok = probe.isAlwaysOnTop();
      probe.destroy();
      return ok;
    });
    if (topmostSupported) {
      const alwaysOnTop = await ctx.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isAlwaysOnTop()
      );
      expect(alwaysOnTop).toBe(true);
    } else {
      // 跳过也要留痕：否则「绿色的套件」可能只是因为断言没跑。
      console.warn('[e2e] 当前 Windows 会话不支持置顶，已跳过置顶断言');
    }
  } finally {
    await ctx.close();
  }
});

test('app:// 拒绝点开头的路径段及其编码变体', async () => {
  const ctx = await launchApp();
  try {
    const results = await ctx.win.evaluate(async () => {
      const paths = [
        '/.git/config',
        '/%2egit/config',
        '/%2Egit/config',
        '/%5c.git/config',
        '/%5c%5c.git/config',
        '/.superpowers/sdd/plan-path',
      ];
      const out = [];
      for (const p of paths) {
        const res = await fetch('app://bundle' + p);
        const body = await res.text();
        out.push({
          path: p,
          status: res.status,
          leaked: body.includes('repositoryformatversion') || body.includes('[core]'),
        });
      }
      return out;
    });

    for (const r of results) {
      expect(r.status, r.path).not.toBe(200);
      expect(r.leaked, r.path).toBe(false);
    }
  } finally {
    await ctx.close();
  }
});
