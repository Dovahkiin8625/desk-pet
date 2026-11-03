import os from 'node:os';

/**
 * 系统状态采样。
 *
 * CPU 占用率在 Windows 上**不能**用 `os.loadavg()`：那个函数只对 Unix 有意义，
 * 在 Windows 上恒返回 [0, 0, 0]。这里用 `os.cpus()` 的**累计 tick 差值**算：
 * 每个核心的 times 里有 user/nice/sys/idle/irq 的累计毫秒数，
 * 两次采样相减就是这段时间里各状态占了多少时间。
 *
 * 热状态与电源状态来自 Electron 的 powerMonitor，由调用方传进来——
 * 这个模块保持纯 Node，不 import electron，才能被单测直接跑。
 */

/** 上一次的 CPU 采样；第一次采样没有差值，算不出占用率。 */
let previousSample = null;

/** 取一次 CPU 时间快照。 */
export function sampleCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * CPU 占用率（百分比）。
 *
 * 第一次调用返回 null：没有上一次采样就没有差值，
 * 此时报 0% 会让用户以为机器很闲——那是在说谎。
 */
export function sampleCpuPercent() {
  const now = sampleCpuTimes();
  const prev = previousSample;
  previousSample = now;
  if (!prev) return null;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0) return null;
  const idleDelta = now.idle - prev.idle;
  const used = totalDelta - idleDelta;
  return Math.round(Math.min(100, Math.max(0, (used / totalDelta) * 100)));
}

/** 内存占用率（百分比）。 */
export function sampleMemoryPercent() {
  const total = os.totalmem();
  if (!total) return 0;
  const free = os.freemem();
  return Math.round(Math.min(100, Math.max(0, ((total - free) / total) * 100)));
}

/** 内存的「已用 / 总量」文本。 */
export function formatMemory(total, free) {
  const gb = (bytes) => `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${gb(total - free)} / ${gb(total)}`;
}

/**
 * 状态文本（给气泡显示）。
 *
 * @param {object} s { cpu, memory, thermal, onBattery }
 */
export function formatStatus(s = {}) {
  const lines = ['系统状态'];
  // cpu 为 null 表示「还没有差值可算」（第一次采样）。
  // 那时写「采样中」而不是 0%——报 0% 是在说谎。
  if (typeof s.cpu === 'number') lines.push(`CPU ${s.cpu}%`);
  else if (s.cpu === null) lines.push('CPU 采样中');
  if (typeof s.memory === 'number') lines.push(`内存 ${s.memory}%`);
  if (s.memoryText) lines.push(s.memoryText);
  if (s.thermal) lines.push(`温度 ${thermalText(s.thermal)}`);
  if (typeof s.onBattery === 'boolean') {
    lines.push(s.onBattery ? '电源：电池供电' : '电源：已接电');
  }
  return lines.join('\n');
}

/** 热状态的中文说法。 */
export function thermalText(thermal) {
  switch (thermal) {
    case 'nominal':
      return '正常';
    case 'fair':
      return '偏热';
    case 'serious':
      return '很热';
    case 'critical':
      return '过热';
    default:
      return '未知';
  }
}

/**
 * 该不该提醒「我好热」。
 *
 * 阈值取 serious 而不是 fair：fair 只是一般笔记本的常态，
 * 到了 serious 才真的值得说一句。
 */
export function isTooHot(thermal) {
  return thermal === 'serious' || thermal === 'critical';
}
