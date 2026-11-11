import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * 常驻的 PowerShell 助手（搜索索引 + 抽图标）。
 *
 * **为什么是常驻的**：每敲一个字都要查一次本机文件。
 * 一次一开的代价是每次都要付一遍 PowerShell 的启动（~200ms）——
 * 搜起来会一顿一顿的。常驻进程把每次查询压到几十毫秒。
 *
 * **为什么整行 base64**：PowerShell 读 stdin 用的是**系统代码页**（中文机器上是 GBK）。
 * 直接发 UTF-8 的 JSON 会被按 GBK 解释，中文查询与中文路径全成乱码。
 * 整行 base64 就没有代码页这回事了。
 *
 * 这一层**不碰 electron**：它只管跟 PowerShell 说话，
 * 于是能在普通 node 里测（见 test/unit/ps-host.test.js）。
 */

/** 助手脚本：复制到临时目录再执行（脚本不能从 asar 里直接跑）。 */
const SCRIPT_PATH = fileURLToPath(new URL('./windowsSearch.ps1', import.meta.url));

/** 一次请求多久算超时。 */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 单次请求的超时
 * @param {string} [options.command] PowerShell 可执行文件
 * @returns {object} 助手客户端
 */
export function createPsHost({ timeoutMs = DEFAULT_TIMEOUT_MS, command = 'powershell.exe' } = {}) {
  let proc = null;
  let scriptFile = '';
  let buffer = '';
  /** 已经废掉了：进程起不来或崩了之后不再重试（重试只会一直失败）。 */
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
        console.warn('[desk-pet] 搜索助手的响应看不懂：', err?.message || err);
        continue;
      }
      const job = pending.get(payload?.id);
      if (!job) continue;
      pending.delete(payload.id);
      clearTimeout(job.timer);
      if (payload.ok) job.resolve(payload);
      else job.reject(new Error(payload.error || '搜索助手出错了'));
    }
  }

  /** 把助手脚本摆到临时目录并拉起进程。 */
  async function start() {
    if (proc) return proc;
    if (dead) throw new Error('搜索助手起不来');
    scriptFile = join(tmpdir(), `desk-pet-search-${process.pid}.ps1`);
    // **带 BOM 写**：PowerShell 5.1 没有 BOM 就按系统代码页（中文机器上是 GBK）
    // 读脚本，脚本里的中文注释会把语法搞乱（整个脚本解析失败）。
    await writeFile(scriptFile, `\ufeff${await readFile(SCRIPT_PATH, 'utf8')}`, 'utf8');
    proc = spawn(
      command,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', onStdout);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) console.warn('[desk-pet] 搜索助手：', text);
    });
    proc.on('error', (err) => fail(err));
    proc.on('exit', () => fail(new Error('搜索助手退出了')));
    return proc;
  }

  /**
   * 发一个请求，等它的回应。
   *
   * @param {string} op 指令（files / icons / ping）
   * @param {object} [payload] 指令的参数
   * @param {number} [timeout] 本次请求的超时（毫秒）
   */
  async function request(op, payload = {}, timeout = timeoutMs) {
    if (dead) throw new Error('搜索助手不可用');
    await start();
    const id = ++seq;
    const line = Buffer.from(JSON.stringify({ id, op, ...payload }), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('搜索助手超时了'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${line}\n`);
    });
  }

  return {
    request,
    /** 预热：后台先把进程拉起来（第一次查询就不用等启动）。 */
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
      fail(new Error('搜索助手已关闭'));
      if (scriptFile) {
        await rm(scriptFile, { force: true }).catch(() => {});
        scriptFile = '';
      }
    },
  };
}
