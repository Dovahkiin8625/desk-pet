const modelSelect = document.getElementById('model');
const scaleInput = document.getElementById('scale');
const opacityInput = document.getElementById('opacity');
const scaleVal = document.getElementById('scaleVal');
const opacityVal = document.getElementById('opacityVal');
const status = document.getElementById('status');

function show(msg) {
  status.textContent = msg;
  if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2000);
}

function formatScale(v) {
  return `${Number(v).toFixed(2)}x`;
}

function formatOpacity(v) {
  return `${Math.round(Number(v) * 100)}%`;
}

// 下拉框只认注册表里的 id：存着的 id 不在列表里（比如形象被删了），
// 就退回到列表第一项——那正是渲染层 loadManifest 的回退规则，
// 两边不一致的话，设置窗口显示的形象会和桌面上显示的对不上。
function setModel(id) {
  if (typeof id !== 'string' || id === '') return;
  const known = Array.from(modelSelect.options).some((o) => o.value === id);
  modelSelect.value = known ? id : modelSelect.options[0]?.value || '';
}

function updateScale(v) {
  scaleInput.value = String(v);
  scaleVal.textContent = formatScale(v);
}

function updateOpacity(v) {
  opacityInput.value = String(v);
  opacityVal.textContent = formatOpacity(v);
}

async function init() {
  // 先挂监听再取数据：设置可能在读取期间就变了，漏掉的那次广播
  // 会让界面停在旧值上。
  window.pet.onSettingsChanged((s) => {
    if (!s) return;
    if (typeof s.modelId === 'string') setModel(s.modelId);
    if (typeof s.scale === 'number') updateScale(s.scale);
    if (typeof s.opacity === 'number') updateOpacity(s.opacity);
  });

  const [settings, models] = await Promise.all([window.pet.getSettings(), window.pet.listModels()]);
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  }
  setModel(settings.modelId);
  updateScale(settings.scale);
  updateOpacity(settings.opacity);
}

modelSelect.addEventListener('change', async () => {
  const requested = modelSelect.value;
  try {
    // switchModel 返回**实际生效**的形象 id：请求了未知 id 时，
    // 主进程会按注册表回退，这里必须把下拉框也拨回回退后的那个，
    // 否则界面显示的与桌面上跑的就对不上了。
    const applied = await window.pet.switchModel(requested);
    if (typeof applied === 'string' && applied !== requested) setModel(applied);
  } catch (err) {
    show(`切换失败：${err?.message || err}`);
    return;
  }
  const label = modelSelect.options[modelSelect.selectedIndex]?.text || requested;
  show(`已切换到 ${label}`);
});

scaleInput.addEventListener('input', async () => {
  const v = Number(scaleInput.value);
  scaleVal.textContent = formatScale(v);
  try {
    await window.pet.saveSettings({ scale: v });
  } catch (err) {
    show(`保存失败：${err?.message || err}`);
  }
});

opacityInput.addEventListener('input', async () => {
  const v = Number(opacityInput.value);
  opacityVal.textContent = formatOpacity(v);
  try {
    await window.pet.saveSettings({ opacity: v });
  } catch (err) {
    show(`保存失败：${err?.message || err}`);
  }
});

init().catch((e) => show(`加载失败：${e.message}`));
