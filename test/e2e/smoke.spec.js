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
  } finally {
    await ctx.close();
  }
});
