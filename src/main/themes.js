/**
 * 主题清单。
 *
 * 主题就是 `src/renderer/ui/themes/` 里的 css 文件：
 * **加一个主题 = 放一个文件进去**，不用改别处的代码。
 *
 * 文件头里写「主题：名字」，设置页的下拉框就用这个名字；
 * 没写就用文件名。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** 主题目录（相对项目根）。 */
export const THEMES_DIR = path.join('src', 'renderer', 'ui', 'themes');

/** 拼出来的那张样式表在 app:// 下的路径。 */
export const THEMES_STYLESHEET_PATH = '/__dp-themes.css';

/** 文件头里的「主题：名字」。 */
function labelOf(css) {
  const m = css.match(/^[ \t]*\*?[ \t]*主题[：:][ \t]*(.+)$/m);
  return m ? m[1].trim() : '';
}

/**
 * 读出全部主题。
 *
 * @param {string} rootDir 项目根目录
 * @returns {Promise<Array<{id: string, label: string, css: string}>>}
 */
export async function readThemes(rootDir) {
  const dir = path.join(rootDir, THEMES_DIR);
  const files = await readdir(dir).catch(() => []);
  const themes = [];
  for (const file of files.filter((f) => f.endsWith('.css')).sort()) {
    const css = await readFile(path.join(dir, file), 'utf8');
    const id = path.basename(file, '.css');
    themes.push({ id, label: labelOf(css) || id, css });
  }
  return themes;
}

/** 主题清单（给设置页的下拉框用）。 */
export async function listThemes(rootDir) {
  return (await readThemes(rootDir)).map(({ id, label }) => ({ id, label }));
}

/**
 * 把全部主题拼成一张样式表。
 *
 * 页面只链 theme.css 一份——主题由它 @import 进来，
 * 换主题不用换样式表，只改 <html> 上的 data-theme。
 */
export async function buildThemesStylesheet(rootDir) {
  const themes = await readThemes(rootDir);
  return themes.map((t) => `/* ${t.id}.css */\n${t.css}`).join('\n\n');
}
