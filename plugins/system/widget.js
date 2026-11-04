/**
 * 系统监控小部件。
 *
 * 这是**插件自己的页面**：宿主只负责喂数据（每秒一次），
 * 画成什么样是插件自己的事。
 *
 * 用的是插件窗口专用的 preload（window.plugin）：
 * 数据从 onTick 来，动作走 window.* 那几个方法。
 */

const cpuBar = document.getElementById('cpu-bar');
const cpuVal = document.getElementById('cpu-val');
const memBar = document.getElementById('mem-bar');
const memVal = document.getElementById('mem-val');
const thermalEl = document.getElementById('thermal');
const powerEl = document.getElementById('power');

/** 把一个百分比画成进度条。 */
function setBar(bar, val, value) {
  // cpu 为 null 表示「还在采样」——这时不画，也不写 0%。
  // 报 0% 是在说谎。
  if (typeof value !== 'number') {
    bar.style.width = '0%';
    return false;
  }
  bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
  return value >= 85;
}

/** 画一次数据。 */
function render(data) {
  if (!data) return;
  const cpuHot = setBar(cpuBar, cpuVal, data.cpu);
  const memHot = setBar(memBar, memVal, data.memory);
  cpuVal.textContent = typeof data.cpu === 'number' ? `${data.cpu}%` : '…';
  memVal.textContent = typeof data.memory === 'number' ? `${data.memory}%` : '…';
  cpuBar.parentElement.classList.toggle('hot', cpuHot);
  memBar.parentElement.classList.toggle('hot', memHot);
  thermalEl.textContent = `温度 ${data.thermalText || '未知'}`;
  powerEl.textContent = data.onBattery === true ? '电池' : data.onBattery === false ? '已接电' : '';
}

// 宿主每秒推一次；打开时还会先给一份。
window.plugin?.onTick?.(render);
window.plugin?.onData?.(render);
void window.plugin?.data?.().then(render);

document.getElementById('expand').addEventListener('click', () => {
  // 变回独立窗口：切形态会重建窗口，这一页马上就死了。
  window.plugin?.window?.setMode?.('window');
});

document.getElementById('close').addEventListener('click', () => {
  window.plugin?.window?.close?.();
});
