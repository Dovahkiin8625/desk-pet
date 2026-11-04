/**
 * Cubism 2 老模型走**另一套**运行时。
 *
 * pixi-live2d-display 的 cubism2 / cubism4 两个 bundle 各带一整套自己的
 * 基类（Live2DModel、ModelSettings、Live2DFactory……），彼此**不共享**：
 * 把两个 bundle 塞进同一个页面，后加载的会整体覆盖前一个的导出。
 *
 * 与其想办法合并它们，不如**按格式各用各的**：
 * Cubism 4 用 cubism4 那份（`PIXI.live2d.Live2DModel`），
 * Cubism 2 用 cubism2 那份——页面加载时先把引用存下来（见 index.html）。
 *
 * 这么做还顺带避开了 instanceof 的坑：两个 bundle 的 ModelSettings
 * 是两个**不同的类**，一个 bundle 的设置文件不认另一个的
 * （"Missing settings." 就是这么来的）。各用各的就不存在这个问题。
 *
 * 另外，cubism2 那份还需要老 SDK（Live2D 2.1）提供的
 * `Live2DModelWebGL` / `Live2DMotion`——老模型的动作文件是**文本**格式，
 * 只有老 SDK 认得。index.html 里一并加载了。
 */

/**
 * 按格式挑一个能加载它的模型类。
 *
 * @param {number} cubismVersion 4 或 2。
 * @returns {Function} 该格式的 Live2DModel 类。
 */
export function pickModelClass(cubismVersion) {
  if (cubismVersion === 2) {
    const cls = window.__live2dCubism2?.Live2DModel;
    if (cls) return cls;
    // 走到这里说明老 SDK 那套没加载上：退回 Cubism 4 的类，
    // 结果是模型加载失败并给出明确错误——比静默崩溃好。
    console.warn('[desk-pet] Cubism 2 运行时没有加载，老模型可能加载不了');
  }
  return window.PIXI?.live2d?.Live2DModel;
}
