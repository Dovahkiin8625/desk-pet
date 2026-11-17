import { loadSpineRuntime } from './runtime.js';

/**
 * 加载一个 Spine 模型。
 *
 * 模型目录是导入时整理好的**标准 Spine 布局**：
 *
 *   model.skel   骨架（4.1 的二进制，或骨架 JSON）
 *   model.atlas  图集（页名就是同目录下的图片文件名）
 *   0.png 1.png  图集的页面
 *
 * 加载分三步：图集 → 纹理 → 骨架。
 */
export async function loadSpineModel(manifest, stage) {
  const { pixi, spineCore, spinePixi } = await loadSpineRuntime();
  const dir = `${manifest.base || '/assets/models'}/${manifest.id}`;
  const spec = manifest.spine || {};

  const atlasRes = await fetch(`${dir}/${spec.atlas}`);
  if (!atlasRes.ok) throw new Error(`图集加载失败：${spec.atlas}`);
  const atlas = new spineCore.TextureAtlas(await atlasRes.text());

  const textureUrls = [];
  // 贴图不能在 worker 里加载：worker 里 fetch 不了 app:// 协议，
  // 拿到的不是正常的 Response。
  // 也不能走 createImageBitmap：浏览器会自己把 alpha 预乘一遍，
  // 而 pma 的图集本身已经是预乘过的（官方运行时也是这么设的）。
  pixi.Assets.setPreferences?.({ preferWorkers: false, preferCreateImageBitmap: false });
  try {
    for (const page of atlas.pages) {
      // 必须给**绝对 URL**：pixi 7 会把以 / 开头的路径当成
      // 「相对于站点根目录」再拼一次，拼出来的地址在 app:// 下是错的。
      const url = new URL(`${dir}/${page.name}`, document.baseURI).href;
      const texture = await pixi.Assets.load(url);
      // pma 的图集用的是预乘 alpha：贴图本身已经是预乘过的，
      // GPU 那边就不能再预乘一遍（否则边缘发黑）。
      // 注意不能把它当加载参数传进去——pixi 7.4 带 alphaMode 加载贴图会失败。
      if (page.pma) {
        try {
          texture.baseTexture.alphaMode = pixi.ALPHA_MODES.PMA;
        } catch {
          /* 这个 pixi 版本改不了就算了 */
        }
      }
      page.setTexture(spinePixi.SpineTexture.from(texture.baseTexture));
      textureUrls.push(url);
    }
  } catch (err) {
    // 中途失败：已经加载的纹理要释放，否则反复失败的切换会堆积显存。
    for (const url of textureUrls) {
      pixi.Assets.unload(url)?.catch?.(() => {});
    }
    throw err;
  }

  const attachmentLoader = new spineCore.AtlasAttachmentLoader(atlas);
  const skeletonRes = await fetch(`${dir}/${spec.skeleton}`);
  if (!skeletonRes.ok) throw new Error(`骨架加载失败：${spec.skeleton}`);
  let skeletonData;
  if (spec.skeletonFormat === 'json') {
    skeletonData = new spineCore.SkeletonJson(attachmentLoader).readSkeletonData(
      await skeletonRes.json(),
    );
  } else {
    skeletonData = new spineCore.SkeletonBinary(attachmentLoader).readSkeletonData(
      new Uint8Array(await skeletonRes.arrayBuffer()),
    );
  }

  const instance = new spinePixi.Spine(skeletonData, { autoUpdate: false });
  instance.__kind = 'spine';
  instance.__stage = stage;

  // 动画推进挂在**这块画布**的 ticker 上：Spine 默认用全局的 Ticker.shared，
  // 那是第二个循环，没必要。
  const ticker = stage.app.ticker;
  const tickerCb = () => {
    if (instance.destroyed) return;
    instance.update((ticker.deltaMS || 16.667) / 1000);
  };
  ticker.add(tickerCb);
  instance.__tickerCb = tickerCb;
  instance.__pixi = pixi;
  instance.__textureUrls = textureUrls;

  // 动画清单：Spine 4.x 的 SkeletonData.animations 是个**数组**。
  const animList = instance.skeleton?.data?.animations || [];
  const names = Array.isArray(animList)
    ? animList.map((a) => a?.name).filter(Boolean)
    : Object.keys(animList);
  const animations = {};
  for (const n of names) animations[n] = true;
  const derived = deriveSpineMotions(names);
  instance.__animations = names;
  instance.__idle = derived.idle;
  if (derived.idle) instance.state.setAnimation(0, derived.idle, true);

  // 动作：Spine 的动画是**具名**的，语义键映射到一个动画名。
  instance.motion = (name) => {
    if (typeof name !== 'string' || !animations[name]) return Promise.resolve(false);
    instance.state.setAnimation(0, name, false);
    // 播完回到待机：一次性动作播完就停在最后一帧，角色看着像卡住了。
    const restore = (entry) => {
      if (entry?.animation?.name !== name) return;
      instance.state.removeListener(restore);
      if (instance.__idle && instance.__idle !== name) {
        instance.state.setAnimation(0, instance.__idle, true);
      }
    };
    instance.state.addListener(restore);
    return Promise.resolve(true);
  };

  return instance;
}

/**
 * Spine 的语义动作映射。
 *
 * Spine 的动画是**具名**的（「idle」「attack」「talk」），
 * 语义键（idle / tapHead / tapBody / drag）按名字对上。
 *
 * 对不上就**不映射**：宁可少播一个动作，也不要在摸头的时候
 * 播一段攻击动画。表情同理——Spine 没有表情，语义表情一律留空。
 */
export function deriveSpineMotions(animationNames) {
  const names = Array.isArray(animationNames) ? animationNames.filter(Boolean) : [];
  const motionGroups = {};
  for (const n of names) motionGroups[n] = 1;

  const find = (re) => names.find((n) => re.test(n)) || null;
  const motions = {};
  const idle = find(/idle|待机|stand|wait/i) || names[0] || null;
  if (idle) motions.idle = { group: idle, index: 0 };
  const tapHead = find(/tap|head|pat|touch|摸头/i);
  if (tapHead) motions.tapHead = { group: tapHead, index: 0 };
  const tapBody = find(/hit|body|react|ouch|受击/i);
  if (tapBody) motions.tapBody = { group: tapBody, index: 0 };
  const drag = find(/drag|hold|carry|grab|拖/i);
  if (drag) motions.drag = { group: drag, index: 0 };

  return { motions, motionGroups, idle };
}

/** 释放 Spine 模型占用的纹理。 */
export function disposeSpineModel(model) {
  if (!model) return 0;
  let released = 0;
  try {
    if (model.__tickerCb) model.__stage?.app?.ticker?.remove(model.__tickerCb);
    // 用 Assets.unload 而不是 texture.destroy()：纹理是走 Assets 缓存进来的，
    // 直接 destroy 会把缓存里那条留在那儿，下次再切回这个模型拿到的是已销毁的纹理。
    for (const url of model.__textureUrls || []) {
      model.__pixi?.Assets?.unload(url)?.catch?.(() => {});
      released += 1;
    }
  } catch (err) {
    console.warn('[desk-pet] Spine 纹理释放失败：', err?.message);
  }
  return released;
}
