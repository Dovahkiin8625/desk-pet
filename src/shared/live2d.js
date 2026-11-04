/**
 * Live2D 模型格式的判别规则（主进程与渲染层共用）。
 *
 * 放在 shared 里是因为**两边必须一致**：
 * 主进程导入时按它决定注册表里写 model3 还是 model2，
 * 渲染层加载时按它决定用哪一套运行时。
 * 两边规则不同的话，会出现「导入时认得是 Cubism 2，加载时当成 Cubism 4」
 * ——模型静默加载不出来，用户完全看不出发生了什么。
 */

/**
 * 这是哪种 Cubism 格式的设置文件。
 *
 * 判别靠**内容**而不是文件名：Cubism 2 的设置文件叫什么都行
 * （DSR50 那个就叫 model0.json），只有内容长成那样才是它。
 *
 * @param {object} settings 解析后的设置 JSON。
 * @returns {number} 4 = Cubism 4，2 = Cubism 2，0 = 认不出来。
 */
export function detectCubismVersion(settings) {
  if (!settings || typeof settings !== 'object') return 0;
  // Cubism 4：有 FileReferences（里面点名 .moc3 与纹理）。
  if (settings.FileReferences && typeof settings.FileReferences === 'object') return 4;
  // Cubism 2：有 model（.moc 文件名）与 textures（数组）。
  if (typeof settings.model === 'string' && Array.isArray(settings.textures)) return 2;
  return 0;
}

/**
 * 注册表/清单里设置文件名的字段：Cubism 4 叫 model3，Cubism 2 叫 model2。
 *
 * @param {number} version detectCubismVersion 的结果。
 * @returns {string} 'model3' 或 'model2'。
 */
export function settingsFieldForVersion(version) {
  return version === 2 ? 'model2' : 'model3';
}
