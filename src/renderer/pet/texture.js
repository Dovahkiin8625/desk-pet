/**
 * 释放 Live2D 模型占用的纹理。
 * pixi 的纹理缓存以 URL 为键，模型销毁不会自动清理，必须显式移除。
 */
export function disposeTextures(model) {
  const PIXI = window.PIXI;
  const internal = model?.internalModel;
  const textures = internal?._textures || internal?.textures || [];
  const urls = [];
  for (const t of textures) {
    if (!t) continue;
    if (t.baseTexture?.resource?.url) urls.push(t.baseTexture.resource.url);
    else if (t.url) urls.push(t.url);
  }
  for (const url of urls) {
    const cached = PIXI.TextureCache?.[url];
    if (cached) {
      PIXI.Texture.removeFromCache(url);
      cached.destroy(true);
    }
  }
  // 兜底：把模型相关的所有纹理都从缓存里摘掉
  for (const key of Object.keys(PIXI.TextureCache || {})) {
    if (key.includes(`/${model?.internalModel?.settings?.getModelFile?.() || ''}`)) {
      const cached = PIXI.TextureCache[key];
      PIXI.Texture.removeFromCache(key);
      cached?.destroy(true);
    }
  }
}
