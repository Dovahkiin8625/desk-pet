// plugins/screen-recorder/lib/window-icons.js
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

/**
 * 窗口图标。
 *
 * 为什么这么绕：Windows 上 Electron 给的 `DesktopCapturerSource.appIcon`
 * 是**空的**（只有 macOS 有），而为了图标去请求缩略图，系统会去挨个抓
 * 一遍窗口画面——实测列一次窗口要 5.5 秒（不要缩略图只要 0.4 秒）。
 *
 * 所以绕一圈：先用 PowerShell 枚举窗口，拿到「这个窗口是哪个程序的」，
 * 再用 Electron 的 `app.getFileIcon()` 读那个程序的图标（读本机资源，很快）。
 *
 * 整个过程是**后台**做的：列窗口要半秒多，不能挡在界面上。
 */

const SCRIPT_PATH = fileURLToPath(new URL('./list-windows.ps1', import.meta.url));

/** 标题归一化：Windows 的标题常常前后带空格。 */
function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

/**
 * 窗口图标的查找器。
 *
 * 命中的缓存是**按路径**的：同一个程序开三个窗口，图标只读一次。
 */
export function createWindowIconResolver() {
  /** 程序路径 → 图标（data URL）。 */
  const iconByPath = new Map();
  /** 标题 → 程序路径。 */
  let pathByTitle = new Map();
  /** 正在跑的那次枚举。 */
  let pending = null;

  /** 跑一遍 PowerShell，拿到「标题 → 路径」。 */
  function loadPaths() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const script = await readFile(SCRIPT_PATH, 'utf8');
        const stdout = await runPowerShell(script);
        // 脚本输出的是 base64 的 UTF-8 JSON（绕开控制台编码问题）。
        const json = Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8');
        const list = JSON.parse(json || '[]');
        const map = new Map();
        for (const item of Array.isArray(list) ? list : []) {
          const title = normalizeTitle(item?.Title);
          const path = typeof item?.Path === 'string' ? item.Path : '';
          if (title && path && !map.has(title)) map.set(title, path);
        }
        pathByTitle = map;
      } catch (err) {
        // 没有 PowerShell（不是 Windows）或者脚本被拦了：
        // 就没有图标，界面照常用。
        console.warn('[录屏] 列窗口取图标失败：', err?.message);
        pathByTitle = new Map();
      }
      return pathByTitle;
    })();
    return pending;
  }

  /**
   * 给一批窗口名配上图标。
   *
   * @param {string[]} titles 窗口标题（desktopCapturer 给的 name）
   * @returns {Promise<Map<string,string>>} 标题 → 图标 data URL
   */
  async function iconsFor(titles) {
    const result = new Map();
    const wanted = [...new Set((titles || []).map(normalizeTitle))].filter(Boolean);
    if (!wanted.length) return result;

    await loadPaths();

    // 按路径缓存：同一个程序只用 app.getFileIcon 读一次。
    const missing = new Set();
    for (const title of wanted) {
      const path = pathByTitle.get(title);
      if (!path) continue;
      if (!iconByPath.has(path)) missing.add(path);
    }
    for (const path of missing) {
      try {
        const image = await app.getFileIcon(path);
        iconByPath.set(path, image && !image.isEmpty() ? image.toDataURL() : '');
      } catch (err) {
        iconByPath.set(path, '');
      }
    }

    for (const title of wanted) {
      const path = pathByTitle.get(title);
      const icon = path ? iconByPath.get(path) : '';
      if (icon) result.set(title, icon);
    }
    return result;
  }

  return { iconsFor };
}

/** 跑一段 PowerShell 脚本，拿它的标准输出。 */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
