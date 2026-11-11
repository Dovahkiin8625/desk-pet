import { execFile } from 'node:child_process';

/**
 * GPU 采样。
 *
 * **只认 nvidia-smi**：Windows 的 GPU 性能计数器（Get-Counter /
 * Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine）每次要起一个
 * PowerShell 进程，实测一次 2～6 秒，挂在一秒的心跳上扛不住。
 * 没有 nvidia-smi 就报「未知」——不拿别的数糊弄。
 *
 * 这个模块保持纯 Node（不 import electron），才能被单测直接跑。
 */

/** nvidia-smi 的查询字段与格式。 */
const QUERY_ARGS = [
  '--query-gpu=utilization.gpu,memory.used,memory.total,name',
  '--format=csv,noheader,nounits',
];

/** 两次采样之间至少隔多久（毫秒）。 */
const REFRESH_MS = 2000;

/** 一次采样的超时（毫秒）。 */
const TIMEOUT_MS = 4000;

/** 最近一次采样结果：{ name, util, memUsed, memTotal } 或 null。 */
let latest = null;
/** 上次采样的时刻。 */
let lastAt = 0;
/** 上次采样是不是还在跑。 */
let busy = false;
/** 这台机器上有没有 nvidia-smi（没有就别再试了）。 */
let unsupported = false;

/**
 * 解析 nvidia-smi 的 CSV 输出（第一行）。
 *
 * 例：`5, 3433, 16303, NVIDIA GeForce RTX 5070 Ti`
 *
 * @returns {object|null} 解析不出来就是 null。
 */
export function parseNvidiaCsv(text) {
  const line = String(text || '')
    .trim()
    .split('\n')[0]
    ?.trim();
  if (!line) return null;
  const parts = line.split(',').map((item) => item.trim());
  if (parts.length < 4) return null;
  const util = Number(parts[0]);
  const memUsed = Number(parts[1]);
  const memTotal = Number(parts[2]);
  if (!Number.isFinite(util)) return null;
  return {
    name: parts.slice(3).join(','),
    util: Math.max(0, Math.min(100, util)),
    memUsed: Number.isFinite(memUsed) ? memUsed : null,
    memTotal: Number.isFinite(memTotal) ? memTotal : null,
  };
}

/** 最近一次采到的 GPU 状况；没采到就是 null。 */
export function gpuStatus() {
  return latest;
}

/**
 * 采一次。
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFile] 跑命令（测试注入假的）
 * @param {number} [opts.now] 此刻（测试注入）
 */
export async function refreshGpu({ execFile: run = execFile, now = Date.now() } = {}) {
  if (unsupported || busy) return latest;
  // lastAt 为 0 表示「还没采过」：第一次不拦。
  if (lastAt && now - lastAt < REFRESH_MS) return latest;
  busy = true;
  lastAt = now;
  try {
    const stdout = await new Promise((resolve, reject) => {
      run('nvidia-smi', QUERY_ARGS, { timeout: TIMEOUT_MS, windowsHide: true }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    latest = parseNvidiaCsv(stdout);
  } catch (err) {
    // 机器上没有这个程序：别每秒再试一次。
    if (err?.code === 'ENOENT') unsupported = true;
    latest = null;
  } finally {
    busy = false;
  }
  return latest;
}

/** 测试用：把内部状态复位。 */
export function resetGpuState() {
  latest = null;
  lastAt = 0;
  busy = false;
  unsupported = false;
}
