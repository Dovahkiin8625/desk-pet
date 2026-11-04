export function createStage(container, { onFit } = {}) {
  const PIXI = window.PIXI;
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  container.appendChild(app.view);

  // 最近一次适配过的模型与清单：画布尺寸变了要重新适配。
  let fitted = null;

  /**
   * 把模型缩放适配到画布：先按自然尺寸等比 contain，再乘清单里的基础缩放。
   *
   * 模型的大小**完全由画布决定**——用户缩放不参与这里的计算：
   * 它由主进程翻译成窗口尺寸，画布随之变大，模型跟着等比变大。
   *
   * 这样「模型永远在画布内」是一条构造上的保证：无论缩放多大、
   * 窗口什么时候变，模型都不会被窗口边界切掉。
   * （早先的写法在这里再乘一次用户缩放，窗口却是不变的——
   *  放大到一定程度，模型的上半身就被窗口切掉了。）
   *
   * 自然尺寸只在首次调用时测量并缓存——之后 getBounds() 返回的是**已缩放**的尺寸，
   * 重复用它计算适配比例会让模型越缩越小。
   */
  function fitModel(model, manifest) {
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
    model.scale.set(fitScale * manifestScale);
    const anchor = manifest?.fit?.anchor || [0.5, 1.0];
    model.anchor.set(anchor[0], anchor[1]);
    const offset = manifest?.fit?.offset || [0, 0];
    model.position.set(
      viewW / 2 + offset[0] * viewW,
      viewH * (anchor[1] === 1 ? 1 : 0.5) + offset[1] * viewH,
    );
    fitted = { model, manifest };
    // 每次重新适配都要通知外面：形象在画布里的**可见范围**变了，
    // 而可见范围决定着「哪里点得到桌宠」与「桌宠能拖到哪」。
    // （见 pet/silhouette.js 与主进程的可见矩形。）
    onFit?.(model, manifest);
    return { naturalWidth: nw, naturalHeight: nh, scale: model.scale.x };
  }

  // 画布尺寸变了（用户改缩放、显示器缩放比例变化）就重新适配模型。
  //
  // 监听 renderer 的 resize 而不是 window 的：renderer 真正改完画布之后
  // 才发这个事件，此时 app.screen 已经是新尺寸；
  // window 的 resize 事件触发时画布还是旧的（PIXI 把它排到下一帧），
  // 在那里适配会用旧尺寸算出一套错的缩放。
  app.renderer.on('resize', () => {
    // 模型可能已经被销毁（切换形象）：给已销毁的对象设 scale 会抛错。
    if (!fitted || !fitted.model || fitted.model.destroyed) return;
    fitModel(fitted.model, fitted.manifest);
  });

  return { app, fitModel };
}
