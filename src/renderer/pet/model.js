import { disposeTextures } from './texture.js';

export async function loadPetModel(manifest) {
  const PIXI = window.PIXI;
  const model3Url = `/assets/live2d/models/${manifest.id}/${manifest.model3}`;
  const model = await PIXI.live2d.Live2DModel.from(model3Url);
  return model;
}

/** 销毁模型并显式释放纹理，避免多次切换后显存持续增长。 */
export function disposePetModel(model) {
  if (!model) return 0;
  let released = 0;
  try {
    released = disposeTextures(model);
    if (released === 0) {
      console.warn('[desk-pet] 未释放任何模型纹理，显存可能持续增长');
    }
  } catch (err) {
    // 释放失败不应阻断切换，但必须留痕——否则显存泄漏完全不可见。
    console.warn('[desk-pet] 模型纹理释放失败：', err?.message);
  }
  // 注意：释放数量要等模型销毁完再返回。提前 return 会跳过下面的
  // removeChild/destroy，模型就永远留在 stage 上——那比重启更糟。
  try {
    if (model.parent) model.parent.removeChild(model);
    model.destroy({ children: true });
  } catch {
    /* ignore */
  }
  return released;
}
