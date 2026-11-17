// plugins/screenshot/lib/powershell.js
/**
 * 跑一小段 PowerShell。
 *
 * 走 `-EncodedCommand`（脚本内容编码成 base64 传进去），**不用 `-File`**：
 * `-File` 要过执行策略（ExecutionPolicy），用户机器上没放行就整个跑不起来，
 * 而 `-EncodedCommand` 不受它管。
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * 跑一个 PowerShell 脚本文件。
 *
 * @param {string} scriptPath 脚本路径
 * @param {object} env 传给脚本的环境变量
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{code:number,stdout:string,stderr:string}>}
 */
export function runPowerShell(scriptPath, env = {}, { timeoutMs = 30000 } = {}) {
  return readFile(scriptPath, 'utf8').then(
    (script) =>
      new Promise((resolve, reject) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { env: { ...process.env, ...env }, windowsHide: true }
        );
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('超时了'));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(e.message));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      })
  );
}
