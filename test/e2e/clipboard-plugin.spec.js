// 剪贴板插件的端到端验证。
//
// 验的是**用户在界面上真能办的事**：
// - 复制一段东西，它自己出现在列表里；
// - 点图钉能固定（固定的那条排在最前面、不会被淘汰）；
// - 历史落盘：退出之后还在（文件在 userData/clipboard-history.json）；
// - 快捷键能在**剪贴板自己的页面里**改，改完立刻生效；
// - 双击一条：那条内容被写回剪贴板。
//
// **不验「Ctrl+V 真的按下去了」**：那一下要发到别的进程，
// 会抢走用户正在用的窗口的焦点——自动化测试里不该干这个。
// 那条路（找窗口、叫前台、发按键）由 paste.ps1 负责，
// 它的回话格式在单元测试里验（test/unit/clipboard-store.test.js）。
import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-clipboard');

/**
 * 这一轮专用的标记。
 *
 * 剪贴板是**系统里那一个**：上一轮测完留在里面的内容，这一轮还在。
 * 复制的内容与剪贴板里原本的一模一样时，插件**不会**记它
 * （内容没变，不算「又复制了一次」）——所以测试要用**每次都不一样**的内容。
 */
let tag = '';
function once(text) {
  return `${text}-${tag}`;
}

/** 启动应用（E2E 模式：不抢单实例锁，用临时 userData）。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes(part)) return win;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  return panel;
}

/** 在面板里搜到「剪贴板」并打开它，返回装着插件页面的 iframe。 */
async function openClipboardPlugin(panel) {
  await panel.fill('#query', '剪贴板');
  await panel.waitForFunction(() => window.__panel?.resultIds?.includes('clipboard'), null, {
    timeout: 10000,
  });
  await panel.click('#results li:has-text("剪贴板")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'clipboard', null, { timeout: 10000 });
  return panel.frameLocator('#plugin-frame');
}

/** 在主进程里往系统剪贴板写一段东西（模拟用户复制）。 */
async function copyText(app, text) {
  await app.evaluate(async ({ clipboard }, value) => {
    await clipboard.writeText(value);
  }, text);
}

/** 读盘上的历史。 */
async function readHistory() {
  try {
    return JSON.parse(await readFile(join(USER_DATA, 'clipboard-history.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 1×1 的 PNG（标准最小合法 PNG）。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 在主进程里把一张图写进系统剪贴板（模拟截图/浏览器「复制图片」）。 */
async function copyImage(app) {
  await app.evaluate(async ({ clipboard, ClipboardItem }, base64) => {
    const bytes = Buffer.from(base64, 'base64');
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, TINY_PNG_BASE64);
}

/** 在主进程里往系统剪贴板写一份「复制的文件」（text/uri-list）。 */
async function copyFiles(app, paths) {
  const urls = paths.map((p) => pathToFileURL(p).href);
  await app.evaluate(async ({ clipboard, ClipboardItem }, list) => {
    await clipboard.write([new ClipboardItem({ 'text/uri-list': list.join('\r\n') })]);
  }, urls);
}

/** 现在系统剪贴板里有哪些 MIME 类型。 */
async function clipboardTypes(app) {
  return app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    return (items || []).flatMap((item) => item.types || []);
  });
}

test.describe('剪贴板插件', () => {
  test.beforeEach(async () => {
    tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('复制的东西会出现在列表里，能固定，历史会落盘', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      // 复制一段东西：它自己就该出现在列表里。
      await copyText(app, once('端到端测试复制的一段文字'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('端到端测试复制的一段文字'), {
        timeout: 10000,
      });

      // 固定：点一下图钉，它就跑到「固定」那一组里去了。
      await frame.locator('li.row .pin').first().click();
      await expect(frame.locator('li.group', { hasText: '固定' })).toBeVisible({ timeout: 5000 });
      await expect(frame.locator('li.row .pin.on')).toHaveCount(1);

      // 落盘：历史存在 userData 里。
      const history = await readHistory();
      expect(history, '历史文件没有写出来').toBeTruthy();
      expect(history.some((item) => item.text === once('端到端测试复制的一段文字'))).toBe(true);
      expect(history.find((item) => item.text === once('端到端测试复制的一段文字'))?.pinned).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('搜索、删除、清空', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      await copyText(app, once('第一条'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('第一条'), { timeout: 10000 });
      await copyText(app, once('第二条'));
      await expect(frame.locator('li.row .text')).toHaveCount(2, { timeout: 10000 });

      // 搜索：本地筛，不用等主进程。
      await frame.locator('#search').fill('第二条');
      await expect(frame.locator('li.row')).toHaveCount(1);
      await expect(frame.locator('li.row .text').first()).toHaveText(once('第二条'));
      await frame.locator('#search').fill('');

      // 删掉一条。
      await frame.locator('li.row .del').first().click();
      await expect(frame.locator('li.row')).toHaveCount(1, { timeout: 5000 });

      // 清空。
      await frame.locator('#clearBtn').click();
      await frame.locator('#clearBtn').click();
      await expect(frame.locator('li.row')).toHaveCount(0, { timeout: 5000 });
      await expect(frame.locator('#empty')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('快捷键在剪贴板自己的页面里改', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      // 设置抽屉在剪贴板**自己的页面**里（不是桌宠的设置窗口）。
      await frame.locator('#gearBtn').click();
      await expect(frame.locator('#drawer')).toBeVisible();

      // 默认的快捷键是清单里写的那两个。
      await expect(frame.locator('#showKey')).toHaveText('Ctrl + Shift + V');
      await expect(frame.locator('#pasteKey')).toHaveText('Ctrl + Shift + B');

      // 点「改」再按键：要带修饰键。
      await frame.locator('#showKeyBtn').click();
      await expect(frame.locator('#showKey')).toHaveText('按下新的组合键…');
      await frame.locator('#drawer').press('Control+Alt+K');
      await expect(frame.locator('#showKey')).toHaveText('Ctrl + Alt + K', { timeout: 5000 });

      // 值落在宿主管的插件配置里（plugins.json）。
      const prefs = JSON.parse(await readFile(join(USER_DATA, 'plugins.json'), 'utf8'));
      expect(prefs.config?.clipboard?.showHotkey).toBe('Control+Alt+K');
    } finally {
      await app.close();
    }
  });

  test('关掉「记录」就不再往历史里存', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      await copyText(app, once('记下来的一条'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('记下来的一条'), {
        timeout: 10000,
      });

      // 关掉记录。
      await frame.locator('#record').uncheck();
      await expect(frame.locator('#record')).not.toBeChecked();

      // 再复制一条：它不该出现。
      await copyText(app, once('关了之后复制的'));
      await panel.waitForTimeout(2500);
      await expect(frame.locator('li.row')).toHaveCount(1);
      await expect(frame.locator('li.row .text').first()).toHaveText(once('记下来的一条'));
    } finally {
      await app.close();
    }
  });

  test('双击粘贴：贴成功就关掉独立窗口，贴不上就留着并给出原因', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      // 复制一条，等它出现在列表里。
      await copyText(app, once('贴完就走'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('贴完就走'), {
        timeout: 10000,
      });

      // 分离成独立窗口（面板随即收起）。
      await panel.click('#detach');
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(win, '剪贴板的独立窗口没有出现').toBeTruthy();
      await win.waitForLoadState('domcontentloaded');

      const winFrame = win.frameLocator('#plugin-frame');
      await expect(winFrame.locator('li.row .text').first()).toHaveText(once('贴完就走'), {
        timeout: 10000,
      });

      // 双击一条：内容先写回剪贴板。
      await winFrame.locator('li.row').first().dblclick();
      await expect
        .poll(async () => await app.evaluate(async ({ clipboard }) => await clipboard.readText()), {
          timeout: 10000,
        })
        .toBe(once('贴完就走'));

      // 等结果落地：要么窗口关了，要么底栏出现失败原因。
      const deadline = Date.now() + 10000;
      let outcome = 'pending';
      while (Date.now() < deadline && outcome === 'pending') {
        if (win.isClosed()) {
          outcome = 'closed';
          break;
        }
        const text = await winFrame.locator('#statusText').textContent().catch(() => '');
        if (/没有找到可以粘贴的窗口|没能把那个窗口叫到前台|贴不了/.test(text || '')) outcome = 'failed';
        else await new Promise((r) => setTimeout(r, 100));
      }
      if (outcome === 'closed') {
        expect(win.isClosed()).toBe(true);
      } else {
        await expect(winFrame.locator('#statusText')).toHaveText(
          /没有找到可以粘贴的窗口|没能把那个窗口叫到前台|贴不了/
        );
      }

      const winStillOpen = () =>
        app.windows().some((w) => {
          try {
            return w.url().includes('/renderer/plugin-window/index.html');
          } catch {
            return false;
          }
        });
      if (outcome === 'closed') await expect.poll(winStillOpen, { timeout: 10000 }).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('双击一条：那条内容被写回剪贴板', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      // 两条内容，好确认双击的是哪一条。
      await copyText(app, once('clipboard-e2e-first'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('clipboard-e2e-first'), {
        timeout: 10000,
      });
      await copyText(app, once('clipboard-e2e-second'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('clipboard-e2e-second'), {
        timeout: 10000,
      });

      // 双击**第二条**（新的在上面，所以它是第二行）。
      await frame.locator('li.row').nth(1).dblclick();

      // 内容被写回剪贴板了。
      await expect
        .poll(async () => await app.evaluate(async ({ clipboard }) => await clipboard.readText()), {
          timeout: 10000,
        })
        .toBe(once('clipboard-e2e-first'));

      // 贴出去的那一条**不该又被记一遍**（新加的一条会排在最前面）。
      await expect(frame.locator('li.row').first().locator('.text')).toHaveText(
        once('clipboard-e2e-second'),
        { timeout: 5000 }
      );
    } finally {
      await app.close();
    }
  });

  test('复制的是图片时：记进历史、列表里能看见、双击贴回去', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      await copyImage(app);
      // 图片行：缩略图出现。
      await expect(frame.locator('li.row img.thumb').first()).toBeVisible({ timeout: 10000 });

      // 落盘：历史里有一条 kind=image 的条目，图片文件也在盘上。
      const history = await readHistory();
      expect(history?.some((item) => item.kind === 'image')).toBe(true);
      const entry = history.find((item) => item.kind === 'image');
      expect(entry.imageFile).toMatch(/^img-[0-9a-f]{40}\.png$/);
      const { access } = await import('node:fs/promises');
      await access(join(USER_DATA, 'clipboard-images', entry.imageFile));

      // 双击：图片写回剪贴板。
      await frame.locator('li.row').first().dblclick();
      await expect.poll(() => clipboardTypes(app), { timeout: 10000 }).toContain('image/png');
    } finally {
      await app.close();
    }
  });

  test('复制的是文件时：记进历史、双击贴出去', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'desk-pet-e2e-files-'));
    const fileA = join(tmp, 'e2e测试文件甲.txt');
    const fileB = join(tmp, 'e2e测试文件乙.txt');
    await writeFile(fileA, 'alpha', 'utf8');
    await writeFile(fileB, 'beta', 'utf8');
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      await copyFiles(app, [fileA, fileB]);
      // 文件行：出现文件名。
      await expect(frame.locator('li.row .text', { hasText: 'e2e测试文件甲.txt' }).first()).toBeVisible({
        timeout: 10000,
      });

      // 落盘：kind=files，路径原样存。
      const history = await readHistory();
      const entry = history?.find((item) => item.kind === 'files');
      expect(entry?.files).toContain(fileA);

      // 双击：文件（text/uri-list）写回剪贴板。
      await frame.locator('li.row', { hasText: 'e2e测试文件甲.txt' }).first().dblclick();
      await expect.poll(() => clipboardTypes(app), { timeout: 10000 }).toContain('text/uri-list');
      // 兜底：不认 CF_HDROP 的应用（记事本之类）至少拿到路径文本。
      await expect
        .poll(async () => await app.evaluate(async ({ clipboard }) => await clipboard.readText()), {
          timeout: 10000,
        })
        .toContain('e2e测试文件甲.txt');
    } finally {
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('复制的是富文本（HTML）时：贴回去还带 HTML', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      await app.evaluate(async ({ clipboard, ClipboardItem }) => {
        await clipboard.write([
          new ClipboardItem({
            'text/plain': '加粗的一段话',
            'text/html': '<p><b>加粗的一段话</b></p>',
          }),
        ]);
      });
      // HTML 徽章出现。
      await expect(frame.locator('li.row .badge', { hasText: 'HTML' }).first()).toBeVisible({ timeout: 10000 });

      // 落盘：HTML 存下来了。
      const history = await readHistory();
      const entry = history?.find((item) => item.html);
      expect(entry?.html).toContain('<b>');

      // 双击：HTML 写回剪贴板。
      await frame.locator('li.row').first().dblclick();
      await expect.poll(() => clipboardTypes(app), { timeout: 10000 }).toContain('text/html');
    } finally {
      await app.close();
    }
  });

  test('双击粘贴：那句话只出现一次', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      const frame = await openClipboardPlugin(panel);

      await copyText(app, once('只出现一次'));
      await expect(frame.locator('li.row .text').first()).toHaveText(once('只出现一次'), {
        timeout: 10000,
      });

      // 双击一条：提示出现在**插件自己页面**的底栏里。
      const before = await frame.locator('#statusText').textContent();
      await frame.locator('li.row').first().dblclick();
      await expect(frame.locator('#statusText')).not.toHaveText(before, { timeout: 30000 });
      const message = await frame.locator('#statusText').textContent();

      // 回到搜索视图再重新打开：宿主的面板状态栏**不该**再显示一遍
      //（插件页面自己已经有一行了，两处都写就是同一句话说两次）。
      await panel.bringToFront();
      await panel.click('#back');
      await panel.fill('#query', '剪贴板');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('clipboard'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("剪贴板")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'clipboard', null, {
        timeout: 10000,
      });

      await expect(panel.locator('#plugin-status')).toHaveText('');
      await expect(frame.locator('#statusText')).toHaveText(message);
    } finally {
      await app.close();
    }
  });
});
