// plugins/screenshot/lib/win32.js
/**
 * 个别 Win32 的活：给窗口关掉 DWM 转场动画。
 *
 * Electron 不暴露这个属性，走 PowerShell P/Invoke 补（与列窗口同一套路）。
 * 关掉之后窗口出现没有「缩放动画」——即使系统「动画效果」开着也一样。
 */
import { fileURLToPath } from 'node:url';
import { runPowerShell } from './powershell.js';

const SCRIPT_PATH = fileURLToPath(new URL('./dwm.ps1', import.meta.url));

/**
 * 关掉某个窗口的 DWM 转场动画（DWMWA_TRANSITIONS = FALSE）。
 *
 * **不等它跑完**：窗口先藏着（调用方在 show 之前调），动画关不上顶多退回
 * 「带一个缩放转场」的老样子，不影响功能；等它等于给遮罩出现多加 100 毫秒。
 *
 * @param {object} win Electron 的 BrowserWindow
 */
export function disableWindowTransitions(win) {
  if (!win || win.isDestroyed?.()) return;
  try {
    const buf = win.getNativeWindowHandle();
    // 64 位进程 handle 是 8 字节；万一 32 位（理论上不会）退回 4 字节读。
    const hwnd =
      buf && buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf?.readUInt32LE(0) ?? 0);
    void runPowerShell(SCRIPT_PATH, { SHOT_HWND: String(hwnd) }, { timeoutMs: 5000 })
      .then(({ code }) => {
        if (code !== 0) {
          console.warn('[截图] 遮罩的出场动画关不掉（窗口还是会带一个缩放转场）');
        }
      })
      .catch((err) => console.warn('[截图] 遮罩的出场动画关不掉：', err?.message));
  } catch (err) {
    console.warn('[截图] 拿不到窗口句柄：', err?.message);
  }
}
