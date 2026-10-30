import { createStage } from './pet/stage.js';
import { loadManifest } from './pet/manifest.js';
import { loadPetModel } from './pet/model.js';

window.__pet = {
  ready: false,
  modelLoaded: false,
  modelId: null,
  expressions: [],
  hitAreas: [],
  naturalSize: null,
};

async function boot() {
  const container = document.getElementById('stage');
  const stage = createStage(container);
  window.__pet.stage = stage;

  const settings = await window.pet.getSettings();
  const modelId = settings?.modelId || 'haru';
  const manifest = await loadManifest(modelId);
  window.__pet.manifest = manifest;

  const model = await loadPetModel(manifest);
  stage.app.stage.addChild(model);
  const fit = stage.fitModel(model, manifest, settings?.scale ?? 1);

  window.__pet.modelId = manifest.id;
  window.__pet.modelLoaded = true;
  // window.__pet.expressions = 模型**原始**表情名列表（如 Haru 的 F01..F08）
  // 语义映射（happy/angry/...）在 window.__pet.manifest.expressions 里。
  // 两者不要混淆：交互层要语义，测试与诊断要原始名。
  window.__pet.expressions = manifest.availableExpressions || [];
  window.__pet.hitAreas = Object.keys(model.internalModel?.hitAreas || {});
  window.__pet.naturalSize = { w: fit.naturalWidth, h: fit.naturalHeight };
  window.__pet.model = model;
  window.__pet.ready = true;
}

boot().catch((err) => {
  window.__pet.error = String(err && err.stack ? err.stack : err);
  window.__pet.ready = true;
});
