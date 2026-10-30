import { createStage } from './pet/stage.js';
import { loadManifest } from './pet/manifest.js';
import { loadPetModel, disposePetModel } from './pet/model.js';

window.__pet = {
  ready: false,
  modelLoaded: false,
  modelId: null,
  expressions: [],
  hitAreas: [],
  naturalSize: null,
  // 最近一次切换时释放掉的纹理数量。0 表示「一个都没释放」——
  // 那是显存泄漏的信号，必须能从诊断面读到。
  lastReleasedTextures: 0,
  switchError: null,
};

let stage = null;
let currentModel = null;
let currentManifest = null;
let userScale = 1;

/**
 * 加载并挂载一个形象。
 *
 * 顺序很重要：**先加载新模型，再销毁旧模型**。反过来的话中间会出现
 * 一帧空舞台，而且一旦新模型加载失败，旧模型也已经被销毁了——
 * 用户的桌宠就彻底没了。
 */
async function mountModel(modelId) {
  const manifest = await loadManifest(modelId);
  const model = await loadPetModel(manifest);

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
  await mountModel(settings?.modelId || 'haru');

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
