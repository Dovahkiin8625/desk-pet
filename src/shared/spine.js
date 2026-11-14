/**
 * Spine 模型的清单契约（主进程与渲染层共用）。
 *
 * 与 shared/live2d.js 同一个道理：两边必须一致。
 * 主进程导入时按它写清单（type: 'spine'），
 * 渲染层加载时按它决定用 Spine 运行时而不是 Cubism Core。
 */

/** 清单里的模型类型：Spine。 */
export const SPINE_TYPE = 'spine';

/** 清单是不是一个 Spine 模型。 */
export function isSpineManifest(manifest) {
  return !!manifest && manifest.type === SPINE_TYPE && !!manifest.spine;
}
