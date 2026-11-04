import { disposeTextures } from './texture.js';
import { pickModelClass } from '../live2dRuntime.js';

/**
 * 加载 Live2D 模型。
 *
 * URL 的基址来自清单的 base：内置模型在项目目录里，用户导入的模型
 * 在用户数据目录里（由 protocol.js 的虚拟根提供）。两种模型因此
 * 用同一段代码，只是 base 不同。
 *
 * modelFile 是**设置文件**的名字（Cubism 4 是 .model3.json，
 * Cubism 2 是 .model.json 之类）。
 *
 * 用哪个模型类取决于 cubismVersion：两代 Cubism 各用各的运行时
 * （见 live2dRuntime.js），混用会得到 "Missing settings."。
 */
export async function loadPetModel(manifest) {
  const base = manifest?.base || '/assets/live2d/models';
  const settingsName = manifest?.modelFile || manifest?.model3 || `${manifest.id}.model3.json`;
  const modelUrl = `${base}/${manifest.id}/${settingsName}`;
  const ModelClass = pickModelClass(manifest?.cubismVersion);
  if (!ModelClass) throw new Error('Live2D 运行时没有加载');
  const model = await ModelClass.from(modelUrl);
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
