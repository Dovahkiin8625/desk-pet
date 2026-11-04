/**
 * 让 Cubism 4 时代的显示层跟 Cubism 6 的 Core 对上话。
 *
 * 背景：显示层用的是 pixi-live2d-display 0.4.0，它内置的框架是
 * Cubism 4.2 时代的，按**老 Core 的 JS 封装**取数据：
 *
 *     this._model.drawables.renderOrders
 *
 * 而 Core（官方 SDK 5-r.5 自带的那份，见 vendor/live2d/）是 Cubism 6.0，
 * 把渲染顺序挪到了 model 上：
 *
 *     this._model.renderOrders / this._model.getRenderOrders()
 *
 * 差的只有这一处：Core 6 的其余 API（Utils 里的各位判断函数、Logging、
 * Moc/Model 的构造入口）老框架用到的那几个都还在，语义也没变。
 *
 * 所以这里在模型建好之后，把渲染顺序**补回老位置**：
 * 既不用改第三方库，也不用换显示层。
 *
 * 补的值是 Core 6 自己那份数组，官方框架（SDK 里的 CubismFramework）
 * 取的也是同一个（`model.getRenderOrders()`）——
 * 老框架对它的用法（`renderOrder[i]` 对应第 i 个可绘制部件）与官方一致。
 */

/**
 * 打上兼容补丁。可重复调用（第二次起是空操作）。
 *
 * @returns {boolean} 补丁是否生效。
 */
export function applyLive2DCoreCompat() {
  const Core = window.Live2DCubismCore;
  if (!Core?.Model?.fromMoc) {
    console.warn('[desk-pet] Cubism Core 没有加载，兼容补丁跳过');
    return false;
  }
  if (Core.Model.fromMoc.__deskPetCompat) return true;

  const original = Core.Model.fromMoc;
  const patched = function fromMoc(moc) {
    const model = original.call(this, moc);
    try {
      if (model?.drawables && !model.drawables.renderOrders && model.renderOrders) {
        model.drawables.renderOrders = model.renderOrders;
      }
    } catch (err) {
      console.warn('[desk-pet] Cubism Core 兼容补丁失败：', err?.message || err);
    }
    return model;
  };
  patched.__deskPetCompat = true;
  Core.Model.fromMoc = patched;
  return true;
}
