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

    // 置顶只能从主进程侧断言：渲染层拿不到 BrowserWindow
    const alwaysOnTop = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isAlwaysOnTop()
    );
    expect(alwaysOnTop).toBe(true);
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
