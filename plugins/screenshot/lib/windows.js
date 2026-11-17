// plugins/screenshot/lib/windows.js
/**
 * 桌面上的窗口：位置与大小（框选前自动选窗用）。
 *
 * 坐标是**物理像素**，而且是**相对窗口所在那块屏的左上角**：
 * 多块屏缩放不一样时，屏与屏之间的偏移没有统一的物理含义，
 * 只有屏内的偏移是准的——截图的像素网格跟屏内的偏移是一套。
 */
import { fileURLToPath } from 'node:url';
import { runPowerShell } from './powershell.js';

const SCRIPT_PATH = fileURLToPath(new URL('./windows.ps1', import.meta.url));

/** 太小的窗口不算（托盘气泡、辅助窗口之类的）。 */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 80;

/**
 * 解析脚本的输出（base64 的 UTF-8 JSON）。
 *
 * @param {string} stdout 脚本的标准输出
 * @returns {{monitors:Array,windows:Array}}
 */
export function parseDesk(stdout) {
  // 输出只有一串 base64，前后可能带空白，取第一个词就是它。
  const token = String(stdout || '').trim().split(/\s+/)[0] || '';
  if (!token) return { monitors: [], windows: [] };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    return { monitors: [], windows: [] };
  }
  const monitors = (parsed?.Monitors || parsed?.monitors || []).map((item, index) => ({
    index: Number(item.Index ?? item.index ?? index),
    x: Number(item.X ?? item.x) || 0,
    y: Number(item.Y ?? item.y) || 0,
    w: Number(item.W ?? item.w) || 0,
    h: Number(item.H ?? item.h) || 0,
    dpi: Number(item.Dpi ?? item.dpi) || 96,
  }));
  const windows = (parsed?.Windows || parsed?.windows || [])
    .map((item) => ({
      pid: Number(item.Pid ?? item.pid) || 0,
      title: String(item.Title ?? item.title ?? ''),
      cls: String(item.Class ?? item.class ?? ''),
      x: Number(item.X ?? item.x) || 0,
      y: Number(item.Y ?? item.y) || 0,
      w: Number(item.W ?? item.w) || 0,
      h: Number(item.H ?? item.h) || 0,
      monitor: Number(item.Monitor ?? item.monitor) ?? 0,
      // 脚本给不出来就当最下面：旧脚本枚举的窗口都靠后。
      z: Number.isFinite(Number(item.Z ?? item.z)) ? Number(item.Z ?? item.z) : 1e9,
    }))
    .filter((item) => item.w >= MIN_WIDTH && item.h >= MIN_HEIGHT);
  return { monitors, windows };
}

/**
 * 列出看得见的窗口与显示器。
 *
 * @returns {Promise<{monitors:Array,windows:Array}>}
 */
export async function listWindows() {
  const { code, stdout, stderr } = await runPowerShell(SCRIPT_PATH, {}, { timeoutMs: 15000 });
  if (code !== 0) {
    console.warn('[截图] 列窗口失败：', stderr.slice(0, 200));
    return { monitors: [], windows: [] };
  }
  const result = parseDesk(stdout);
  if (!result.windows.length && !result.monitors.length) {
    console.warn('[截图] 窗口清单看不懂');
  }
  return result;
}
