export function createStage(container) {
  const PIXI = window.PIXI;
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  container.appendChild(app.view);

  function resize() {
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);

  /**
   * 把模型缩放适配到视口：先按自然尺寸等比 contain，再乘清单与用户缩放。
   * 自然尺寸只在首次调用时测量并缓存——之后 getBounds() 返回的是**已缩放**的尺寸，
   * 重复用它计算适配比例会让模型越缩越小（Task 9 调整缩放时会再次调用本函数）。
   */
  function fitModel(model, manifest, userScale = 1) {
    const viewW = app.screen.width;
    const viewH = app.screen.height;
    if (!model.__naturalSize) {
      const natural = model.getBounds();
      model.__naturalSize = { w: natural.width || 1, h: natural.height || 1 };
    }
    const nw = model.__naturalSize.w;
    const nh = model.__naturalSize.h;
    const fitScale = Math.min((viewH * 0.96) / nh, (viewW * 0.98) / nw);
    const manifestScale = manifest?.fit?.scale ?? 1;
    model.scale.set(fitScale * manifestScale * userScale);
    const anchor = manifest?.fit?.anchor || [0.5, 1.0];
    model.anchor.set(anchor[0], anchor[1]);
    const offset = manifest?.fit?.offset || [0, 0];
    model.position.set(
      viewW / 2 + offset[0] * viewW,
      viewH * (anchor[1] === 1 ? 1 : 0.5) + offset[1] * viewH,
    );
    return { naturalWidth: nw, naturalHeight: nh, scale: model.scale.x };
  }

  return { app, resize, fitModel };
}
