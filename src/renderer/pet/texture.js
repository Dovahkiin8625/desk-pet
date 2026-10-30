/**
 * 释放 Live2D 模型占用的纹理。
 * pixi 的纹理缓存以 URL 为键，模型销毁不会自动清理，必须显式移除。
 */
export function disposeTextures(model) {
  const PIXI = window.PIXI;

  // pixi v6 的全局纹理缓存挂在 PIXI.utils.TextureCache 上。
  // 浏览器构建里 PIXI.TextureCache 是 undefined——写错命名空间会让整个函数
  // 静默地什么都不释放。
  const cache = PIXI.TextureCache || PIXI.utils?.TextureCache;
  if (!cache) return 0;

  // 模型的 PIXI 纹理挂在 model.textures 上（Live2DModel 用 Texture.fromURL 加载，
  // 纹理以完整 URL 为键缓存在 PIXI.utils.TextureCache 里）。
  //
  // 不要去碰 internalModel._textures——那是 CubismRenderer_WebGL 持有的原始
  // WebGLTexture 句柄数组，不可迭代；internalModel.textures 只是 model3.json 里的
  // 文件名数组。两者都拿不到我们要的键。
  const textures = model?.textures || [];
  const keys = [];
  for (const t of textures) {
    // 缓存键是**加载时用的那个 URL**（相对 app:// 根的路径，如
    // /assets/live2d/models/haru/Haru.2048/texture_00.png），
    // 不是 baseTexture.resource.url 里的绝对地址——用绝对地址查不到缓存。
    const key = t?.baseTexture?.cacheId || t?.baseTexture?.resource?.url;
    if (key) keys.push(key);
  }

  let released = 0;
  for (const key of keys) {
    const cached = cache[key];
    if (!cached) continue;
    PIXI.Texture.removeFromCache(key);
    cached.destroy(true);
    released++;
  }

  // 刻意**不做**「把缓存里所有 URL 形状的键都清掉」这种兜底：
  // PIXI 的纹理缓存是全局命名空间，那样会把别的模型或未来任何资源的纹理
  // 一起销毁，表现为切换形象后渲染空白。
  return released;
}
