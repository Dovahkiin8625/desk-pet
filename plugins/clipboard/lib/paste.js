// plugins/clipboard/lib/paste.js
/**
 * 把内容贴到「用户刚才在用的那个窗口」。
 *
 * 为什么需要它：Electron 没有「往别的程序发按键」的接口，
 * 而 Ctrl+V 必须真的发出去（只写进剪贴板不算粘贴）。
 *
 * 真正干活的是 paste.ps1（Windows 的老办法：找出目标窗口 →
 * 把它叫到前台 → 补发 Ctrl+V）。
 *
 * **常驻一个进程**（与 src/main/psHost.js 同一套路）：
 * 一次性的话，每次粘贴都要付一遍 PowerShell 的启动和
 * Add-Type 的 C# 编译（几百毫秒），双击贴就一顿一顿的。
 * 常驻之后，这些开销只在预热时付一次，每一贴就是「发一行、等一行」。
 * 第一次粘贴仍会等进程起来，之后就快了。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Windows 自带的 PowerShell。 */
const POWERSHELL = 'powershell.exe';

/** 一次剪贴/粘贴请求多久算超时。 */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 摆到临时目录里的那份脚本（带 BOM，见 prepareScript）。
 */

/** 常驻助手（整个插件一份）。 */
let helper = null;

/**
 * 把脚本摆到临时目录里，**带 BOM** 写。
 *
 * PowerShell 5.1 读脚本时，没有 BOM 就按**系统代码页**读
 * （中文机器上是 GBK）——脚本里的中文注释会被按 GBK 解释，
 * 整段脚本解析失败（报的是莫名其妙的 "UnexpectedToken"）。
 *
 * @param {string} scriptPath 插件目录里的 paste.ps1
 * @returns {Promise<string>} 临时目录里那份脚本的路径
 */
export async function prepareScript(scriptPath) {
  const file = join(tmpdir(), `desk-pet-clipboard-paste-${process.pid}.ps1`);
  const text = await readFile(String(scriptPath || ''), 'utf8');
  await writeFile(file, `\ufeff${text}`, 'utf8');
  return file;
}

/**
 * 翻译一次「一次性」跑出来的回话（旧接口，保留给单元测试用）。
 *
 * 常驻模式里不再用它（那边是一行一行 base64 的响应，直接解析）。
 *
 * @param {string} stdout
 * @returns {{ok: boolean, title?: string, error?: string}|null}
 */
export function decodeAnswer(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
 * 造一个常驻的粘贴助手。
 *
 * @param {string} scriptPath 插件目录里的 paste.ps1
 * @returns {object} 助手客户端
 */
function createPersistentHelper(scriptPath) {
  let proc = null;
  let scriptFile = '';
  let buffer = '';
  /** 已经废掉了：起不来或崩了之后不再重试（重试只会一直失败）。 */
  let dead = false;
  let seq = 0;
  /** id → {resolve, reject, timer} */
  const pending = new Map();

  /** 进程没了：所有在等的请求都算失败。 */
  function fail(err) {
    dead = true;
    proc = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    pending.clear();
  }

  /** stdout 是一行一个 base64 的 JSON 响应。 */
  function onStdout(chunk) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let payload = null;
      try {
        payload = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
      } catch (err) {
        console.warn('[desk-pet] 粘贴助手的响应看不懂：', err?.message || err);
        continue;
      }
      const job = pending.get(payload?.id);
      if (!job) continue;
      pending.delete(payload.id);
      clearTimeout(job.timer);
      if (payload.ok) job.resolve(payload);
      else job.reject(new Error(payload.error || '粘贴助手出错了'));
    }
  }

  /** 把助手脚本摆到临时目录并拉起进程。 */
  async function start() {
    if (proc) return proc;
    if (dead) throw new Error('粘贴助手起不来');
    scriptFile = await prepareScript(scriptPath);
    proc = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', onStdout);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) console.warn('[desk-pet] 粘贴助手：', text);
    });
    proc.on('error', (err) => fail(err));
    proc.on('exit', () => fail(new Error('粘贴助手退出了')));
    return proc;
  }

  /**
   * 发一个请求，等它的回应。
   *
   * @param {string} op 指令（paste / ping）
   * @param {object} [payload] 指令的参数（如 ourPid）
   * @param {number} [timeout] 本次请求的超时（毫秒）
   */
  async function request(op, payload = {}, timeout = DEFAULT_TIMEOUT_MS) {
    if (dead) throw new Error('粘贴助手不可用');
    await start();
    const id = ++seq;
    const line = Buffer.from(JSON.stringify({ id, op, ...payload }), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('粘贴助手超时了'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${line}\n`);
    });
  }

  return {
    request,
    /** 预热：后台先把进程拉起来（界面打开时就该准备好）。 */
    warm: () => {
      void start().catch(() => {});
    },
    /** 收工：杀掉进程，删掉临时脚本。 */
    async dispose() {
      const current = proc;
      proc = null;
      if (current) {
        try {
          current.stdin.end();
        } catch {
          /* 进程可能已经没了 */
        }
        try {
          current.kill();
        } catch {
          /* 同上 */
        }
      }
      fail(new Error('粘贴助手已关闭'));
      if (scriptFile) {
        await rm(scriptFile, { force: true }).catch(() => {});
        scriptFile = '';
      }
    },
  };
}

/** 取（或造）那唯一的一份常驻助手。 */
function getHelper(scriptPath) {
  if (!helper) helper = createPersistentHelper(scriptPath);
  return helper;
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
export async function pasteToTarget({ scriptPath, ourPid = process.pid, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const answer = await getHelper(scriptPath).request('paste', { ourPid }, timeoutMs);
    return {
      ok: true,
      title: typeof answer.title === 'string' ? answer.title : '',
      error: '',
    };
  } catch (err) {
    return { ok: false, title: '', error: `贴不了：${err?.message || err}` };
  }
}

/**
 * 预热粘贴助手：后台先把进程拉起来（第一次粘贴就不用等启动 + 编译）。
 *
 * 在 clipboard 界面打开时（onSurfaceChange 的 open 分支）调它——
 * 用户点开界面多半就是要贴东西了。
 */
export function warmPasteHelper(scriptPath) {
  getHelper(scriptPath).warm();
}

/** 收工：把常驻进程杀掉、临时脚本删掉。 */
export async function disposePasteHelper() {
  if (!helper) return;
  const current = helper;
  helper = null;
  await current.dispose();
}
