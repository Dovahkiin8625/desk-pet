import { disposeTextures } from './texture.js';

export async function loadPetModel(manifest) {
  const PIXI = window.PIXI;
  const model3Url = `/assets/live2d/models/${manifest.id}/${manifest.model3}`;
  const model = await PIXI.live2d.Live2DModel.from(model3Url);
  return model;
}

/** 销毁模型并显式释放纹理，避免多次切换后显存持续增长。 */
export function disposePetModel(model) {
  if (!model) return;
  try {
    disposeTextures(model);
  } catch {
    /* 释放失败不应阻断切换 */
  }
  try {
    if (model.parent) model.parent.removeChild(model);
    model.destroy({ children: true });
  } catch {
    /* ignore */
  }
}
