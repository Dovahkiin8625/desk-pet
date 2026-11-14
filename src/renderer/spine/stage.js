import { loadSpineRuntime } from './runtime.js';

/**
 * Spine 模型的舞台：**第二块画布**。
 *
 * Live2D 跑在 pixi 6 上，Spine 官方运行时要 pixi 7——两套 pixi 不能共存于
 * 同一份代码（各自带一整套基类，后加载的会整体覆盖前一个的导出）。
 * 所以 Spine 走自己的画布，同一时刻只有一个画布是可见的。
 *
 * 对外的接口与 pet/stage.js（Live2D 的舞台）保持一致：
 * app、canvas、fitModel。
 */
export async function createSpineStage(container, { onFit } = {}) {
  const { pixi } = await loadSpineRuntime();
  const app = new pixi.Application({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  const canvas = app.canvas || app.view;
  // 挂上先藏起来：只有真的切到 Spine 模型时才显示。
  canvas.style.display = 'none';
  container.appendChild(canvas);

  // 最近一次适配过的模型：画布尺寸变了要重新适配。
  let fitted = null;

  /**
   * 把模型缩放适配到画布。
   *
   * Spine 的骨骼坐标是**像素**（一个 4096×2048 的骨架就是 4096×2048），
   * 而且原点通常在角色脚下、不在画面中心——所以适配不能照抄
   * Live2D 那套「锚点 + 偏移」，得按**实际画出来的范围**算：
   * 等比缩放到画布里，再把角色的底边中点摆到画布底边中点。
   */
  function fitModel(model, manifest) {
    const viewW = app.screen.width;
    const viewH = app.screen.height;
    if (!model.__naturalSize) {
      // 网格（SlotMesh）是第一次渲染时才生成的：先让它长出来再量。
      model.updateTransform?.();
      const natural = model.getLocalBounds();
      model.__naturalSize = {
        x: natural.x || 0,
        y: natural.y || 0,
        w: natural.width || 1,
        h: natural.height || 1,
      };
    }
    const n = model.__naturalSize;
    const fitScale = Math.min((viewH * 0.96) / n.h, (viewW * 0.98) / n.w);
    const scale = fitScale * (manifest?.fit?.scale ?? 1);
    model.scale.set(scale);
    const offset = manifest?.fit?.offset || [0, 0];
    model.position.set(
      viewW / 2 - (n.x + n.w / 2) * scale + offset[0] * viewW,
      viewH - (n.y + n.h) * scale + offset[1] * viewH,
    );
    fitted = { model, manifest };
    onFit?.(model, manifest);
    return { naturalWidth: n.w, naturalHeight: n.h, scale };
  }

  app.renderer.on('resize', () => {
    if (!fitted || !fitted.model || fitted.model.destroyed) return;
    fitModel(fitted.model, fitted.manifest);
  });

  return { kind: 'spine', app, canvas, fitModel };
}
