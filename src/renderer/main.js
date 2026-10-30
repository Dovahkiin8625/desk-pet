import { createStage } from './pet/stage.js';
import { loadManifest } from './pet/manifest.js';
import { loadPetModel, disposePetModel } from './pet/model.js';
import { disposeTexturesUnderPath } from './pet/texture.js';

window.__pet = {
  ready: false,
  modelLoaded: false,
  modelId: null,
  expressions: [],
  hitAreas: [],
  naturalSize: null,
  // 最近一次切换释放掉的纹理数量。0 表示「一个都没释放」——
  // 那是显存泄漏的信号，必须能从诊断面读到。
  lastReleasedTextures: 0,
  switchError: null,
};

let stage = null;
let currentModel = null;
let currentManifest = null;
let userScale = 1;

// 切换请求序号：并发切换时只有最后一次请求允许提交到舞台，
// 否则「谁先加载完谁上屏」，屏幕上可能不是用户最后选的那个。
let switchSeq = 0;

// 切换串行化：同一时刻只允许一次加载在进行。
//
// pixi 的纹理缓存以 URL 为键，两次**并发**加载同一形象会拿到同一批
// Texture 实例（Texture.from 命中缓存就直接返回那个对象）。
// 先完成的那次一旦销毁自己的模型，就会把另一次正在用的纹理一起销毁——
// 胜出的模型变成「没有绑定纹理的空壳」，而 switchModel 仍然报告成功。
// 串行化之后任何时刻只有一个模型在被加载，不存在共享纹理。
let switchChain = Promise.resolve();

/**
 * 排队一次形象切换。
 *
 * 请求序号在**调用时**就取好：并发请求里只有最后取到序号的那个允许提交，
 * 先到的那些直接作废，连模型都不加载。
 */
function mountModel(modelId) {
  const token = ++switchSeq;
  const run = switchChain.then(
    () => doMountModel(modelId, token),
    () => doMountModel(modelId, token),
  );
  // 链条本身不能被拒绝打断：某一次切换失败不能卡死后面的切换。
  switchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 加载并挂载一个形象（串行化后的实际执行体）。
 *
 * 顺序很重要：**先加载新模型，再销毁旧模型**。反过来的话中间会出现
 * 一帧空舞台，而且一旦新模型加载失败，旧模型也已经被销毁了——
 * 用户的桌宠就彻底没了。
 */
async function doMountModel(modelId, token) {
  // 还没开始就已经被更新的请求顶掉了：什么都不用做。
  if (token !== switchSeq) return null;

  const manifest = await loadManifest(modelId);

  // 切换到**当前已挂载的同一个形象**时直接返回。
  // pixi 对已缓存的 URL 会返回同一个 Texture 实例，新旧模型因此共享同一批
  // 纹理对象；紧接着调用 disposeTextures 会把新模型自己的纹理销毁掉——
  // 桌宠变成「没有绑定纹理的空壳」，而 switchModel 仍然报告成功。
  if (currentModel && manifest.id === currentManifest?.id) {
    return currentModel;
  }

  let model;
  try {
    model = await loadPetModel(manifest);
  } catch (err) {
    // 加载失败时旧模型仍挂在舞台上，用户不会看到桌宠凭空消失。
    // 但失败的加载可能已经把纹理塞进了全局缓存，必须清掉，
    // 否则反复失败的切换会不断堆积显存。
    disposeTexturesUnderPath(`/assets/live2d/models/${manifest.id}/`);
    throw err;
  }

  // 缩放每次挂载时重读：userScale 是启动时抓的，
  // 用户在设置里改过缩放后再切换形象，新模型必须用新缩放。
  //
  // 这一句必须放在**提交之前**：提交段（销毁旧模型 → 挂载新模型 → 更新状态）
  // 要保持整体同步，中途 await 会让并发请求插进来，导致舞台上同时挂着两个模型。
  const settings = await window.pet.getSettings();
  if (typeof settings?.scale === 'number') userScale = settings.scale;

  // 加载期间可能又发起了新的切换——过期请求直接放弃，不要动舞台。
  if (token !== switchSeq) {
    disposePetModel(model);
    return null;
  }

  let released = 0;
  if (currentModel) {
    // 先把旧模型摘出舞台：它马上要被销毁，留在渲染列表里只会
    // 让渲染循环去访问已经释放的纹理。
    if (currentModel.parent) currentModel.parent.removeChild(currentModel);
    released = disposePetModel(currentModel);
    currentModel = null;
  }
  window.__pet.lastReleasedTextures = released;

  stage.app.stage.addChild(model);
  const fit = stage.fitModel(model, manifest, userScale);
  currentModel = model;
  currentManifest = manifest;

  // manifest.id 是注册表里的 id：未知的 modelId 会在 loadManifest 里
  // 回退到注册表首个形象，这里直接把回退后的 id 呈现出来。
  window.__pet.modelId = manifest.id;
  window.__pet.modelLoaded = true;
  // window.__pet.expressions = 模型**原始**表情名列表（如 Haru 的 F01..F08）
  // 语义映射（happy/angry/...）在 window.__pet.manifest.expressions 里。
  // 两者不要混淆：交互层要语义，测试与诊断要原始名。
  window.__pet.expressions = manifest.availableExpressions || [];
  // 命中区同样要跟着新模型重读——沿用旧模型的命中区会让点击落在
  // 新模型身上却不触发任何反应。
  window.__pet.hitAreas = Object.keys(model.internalModel?.hitAreas || {});
  window.__pet.naturalSize = { w: fit.naturalWidth, h: fit.naturalHeight };
  window.__pet.model = model;
  window.__pet.manifest = manifest;
  return model;
}

async function boot() {
  const container = document.getElementById('stage');
  stage = createStage(container);
  window.__pet.stage = stage;

  const settings = await window.pet.getSettings();
  userScale = settings?.scale ?? 1;
  // 不在这里写死任何形象 id：loadManifest 对未知/缺失的 id 会回退到注册表首个形象。
  await mountModel(settings?.modelId);

  // 主进程请求切换形象（pet:modelSwitchRequest）。
  // 这是既有的唯一切换入口，不另开 IPC 通道。
  window.pet.onModelSwitchRequest(async (modelId) => {
    try {
      await mountModel(modelId);
      window.__pet.switchError = null;
    } catch (err) {
      window.__pet.switchError = String(err && err.message ? err.message : err);
    }
  });

  window.__pet.switchModel = async (modelId) => {
    try {
      await mountModel(modelId);
      window.__pet.switchError = null;
      return true;
    } catch (err) {
      window.__pet.switchError = String(err && err.message ? err.message : err);
      return false;
    }
  };

  window.__pet.ready = true;
}

boot().catch((err) => {
  window.__pet.error = String(err && err.stack ? err.stack : err);
  window.__pet.ready = true;
});
