import { join } from 'node:path';

/**
 * 插件目录的约定。
 *
 * - **内置插件**在项目根目录的 `plugins/` 下（随程序分发）；
 * - **用户插件**在 `userData/plugins/` 下（用户自己放的）。
 *
 * 两者是同一套结构：一个插件 = 一个子目录 + 一个 `plugin.json`。
 */

/** 用户插件在 app:// 里的虚拟根前缀。 */
export const USER_PLUGINS_URL_PREFIX = '/__plugins__';

/** 用户插件目录（userData 下）。 */
export function userPluginsDir(userDataDir) {
  return join(userDataDir, 'plugins');
}

/** 内置插件目录（项目根下）。 */
export function bundledPluginsDir(rootDir) {
  return join(rootDir, 'plugins');
}
