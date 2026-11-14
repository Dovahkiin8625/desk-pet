/**
 * Spine 运行时（官方 spine-core + spine-pixi + pixi 7）的按需加载。
 *
 * 为什么单独一个模块：spine-pixi 要求 pixi 7，而桌宠的 Live2D 用的是
 * pixi 6。两套 pixi 不能塞进同一份代码（各自带一整套基类），
 * 所以 Spine 走**另一块画布**、另一套运行时。
 *
 * 为什么要按需加载：pixi 7 的 bundle 有几百 KB，而绝大多数用户
 * 只用 Live2D 模型。没装 Spine 模型时，这段代码根本不会被下载。
 */

/** 已经加载好的运行时（null = 还没加载）。 */
let runtimePromise = null;

/**
 * 加载 Spine 运行时。
 *
 * import map 把 @pixi/* 全部指到 pixi 7 的单文件构建上，
 * spine-pixi 拿到的每一个 @pixi/* 因此都是同一个实例。
 */
export function loadSpineRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [pixi, spineCore, spinePixi] = await Promise.all([
        import('pixi7'),
        import('@esotericsoftware/spine-core'),
        import('@esotericsoftware/spine-pixi'),
      ]);
      return { pixi, spineCore, spinePixi };
    })().catch((err) => {
      // 加载失败不能被缓存住：下一次切到 Spine 模型时应当再试一次。
      runtimePromise = null;
      throw err;
    });
  }
  return runtimePromise;
}
