// plugins/clipboard/lib/paste.js
/**
 * 把内容贴到「用户刚才在用的那个窗口」。
 *
 * 为什么需要它：Electron 没有「往别的程序发按键」的接口，
 * 而 Ctrl+V 必须真的发出去（只写进剪贴板不算粘贴）。
 *
 * 真正干活的是 paste.ps1（Windows 的老办法：找出目标窗口 →
 * 把它叫到前台 → 补发 Ctrl+V）。这一层只负责把它叫起来，
 * 并把它回的那句 base64 JSON 翻译成人话。
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Windows 自带的 PowerShell。 */
const POWERSHELL = 'powershell.exe';

/** 摆到临时目录里的那份脚本（带 BOM，见 prepareScript）。 */
let scriptFile = '';
/** 脚本准备好了吗（同一个 Promise 复用，别每次都重写一遍）。 */
let scriptReady = null;

/**
 * 把脚本摆到临时目录里，**带 BOM** 写。
 *
 * PowerShell 5.1 读脚本时，没有 BOM 就按**系统代码页**读
 * （中文机器上是 GBK）——脚本里的中文注释会被按 GBK 解释，
 * 整段脚本解析失败（报的是莫名其妙的 "UnexpectedToken"）。
 *
 * 宿主那边也是这么干的（见 src/main/psHost.js 的说明）。
 *
 * @param {string} scriptPath 插件目录里的 paste.ps1
 * @returns {Promise<string>} 临时目录里那份脚本的路径
 */
export async function prepareScript(scriptPath) {
  if (scriptReady) return scriptReady;
  scriptReady = (async () => {
    const file = join(tmpdir(), `desk-pet-clipboard-paste-${process.pid}.ps1`);
    const text = await readFile(String(scriptPath || ''), 'utf8');
    await writeFile(file, `\ufeff${text}`, 'utf8');
    scriptFile = file;
    return file;
  })();
  return scriptReady;
}

/** 收工：把临时脚本删掉。 */
export async function disposePasteHelper() {
  if (!scriptFile) return;
  const file = scriptFile;
  scriptFile = '';
  scriptReady = null;
  await rm(file, { force: true }).catch(() => {});
}

/**
 * 翻译脚本回的那句话。
 *
 * 脚本在 stdout 上给一行 **base64 的 UTF-8 JSON**——
 * 绕开控制台代码页，中文标题才不乱码。
 *
 * @param {string} stdout
 * @returns {{ok: boolean, title?: string, error?: string}|null}
 */
export function decodeAnswer(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // 从后往前找：脚本最后说的那一句才是结果。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!/^[A-Za-z0-9+/=]+$/.test(line)) continue;
    try {
      const value = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
      if (value && typeof value === 'object') return value;
    } catch {
      // 不是它，继续往前找。
    }
  }
  return null;
}

/**
 * 贴一次。
 *
 * @param {object} options
 * @param {string} options.scriptPath paste.ps1 的路径
 * @param {number} [options.ourPid] 自己的进程号（脚本靠它排除自己的窗口）
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, title?: string, error: string}>}
 */
export async function pasteToTarget({ scriptPath, ourPid = process.pid, timeoutMs = 20000 } = {}) {
  let file = '';
  try {
    file = await prepareScript(scriptPath);
  } catch (err) {
    return { ok: false, title: '', error: `贴不了：${err?.message || err}` };
  }
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      {
        env: { ...process.env, DP_OUR_PID: String(ourPid ?? '') },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const answer = decodeAnswer(stdout);
        if (answer) {
          resolve({
            ok: Boolean(answer.ok),
            title: typeof answer.title === 'string' ? answer.title : '',
            error: typeof answer.error === 'string' ? answer.error : '',
          });
          return;
        }
        // 脚本没给出结果：要么它自己报错了，要么根本没跑起来。
        const detail =
          String(stderr || '')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .pop() || '';
        resolve({
          ok: false,
          title: '',
          error: detail || (err ? `贴不了：${err.message}` : '贴不了'),
        });
      }
    );
  });
}
