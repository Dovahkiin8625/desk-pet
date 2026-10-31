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

// init() 完成之前收到的广播：先记下来，等初始化结束时统一应用。
//
// 监听器是先于 Promise.all([getSettings(), listModels()]) 注册的，
// 两者之间到达的广播会撞上空的 options：setModel 只能把 value 置空，
// 随后 init() 结束时又用**更旧**的 getSettings 结果覆盖一次——
// 下拉框显示的就不是桌面上跑的那个，而且不会有下一次广播来纠正。
// 缩放与透明度同理：广播里的新值会被 init 的旧值盖回去。
let pending = null;

// 下拉框只认注册表里的 id：存着的 id 不在列表里（比如形象被删了），
// 就退回到列表第一项——那正是渲染层 loadManifest 的回退规则，
// 两边不一致的话，设置窗口显示的形象会和桌面上显示的对不上。
function setModel(id) {
  if (typeof id !== 'string' || id === '') return;
  if (modelSelect.options.length === 0) {
    // 选项还没填好：先记下来，填充完再应用。
    pending = { ...(pending || {}), modelId: id };
    return;
  }
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
    // 记下最近一次广播：init() 结束时要用它，而不是更旧的 getSettings 结果。
    pending = { ...(pending || {}), ...s };
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
  // 选项填好了：广播里的值比 getSettings 的结果新，优先用它。
  const latest = { ...settings, ...(pending || {}) };
  pending = null;
  setModel(latest.modelId);
  updateScale(latest.scale);
  updateOpacity(latest.opacity);
}

modelSelect.addEventListener('change', async () => {
  const requested = modelSelect.value;
  let result;
  try {
    // switchModel 现在**等渲染层的回执**：主进程拿到「模型真的上屏了」
    // 才算成功。加载失败时主进程会把磁盘上的 modelId 回滚到屏幕上
    // 那个形象，并在这里报告失败——不能先显示「已切换到 …」。
    result = await window.pet.switchModel(requested);
  } catch (err) {
    show(`切换失败：${err?.message || err}`);
    return;
  }
  if (!result || result.ok !== true) {
    // 失败：下拉框拨回**屏幕上那个**形象，别停在用户点的那个。
    if (result?.modelId) setModel(result.modelId);
    show(`切换失败：${result?.error || '模型加载失败'}`);
    return;
  }
  // 成功：请求了未知 id 时主进程会按注册表回退，
  // 这里必须把下拉框也拨回实际生效的那个。
  if (typeof result.modelId === 'string' && result.modelId !== requested) setModel(result.modelId);
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
