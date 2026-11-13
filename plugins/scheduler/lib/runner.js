/**
 * 跑一条定时任务。
 *
 * 两种活：
 * - **命令**：按用户写的原样执行（`cmd.exe` 那条路），把输出与退出码带回来；
 * - **派单**：只说要做的事，交给桌宠的 agent ——它自己决定怎么做，
 *   必要时写脚本、调工具；写文件与执行命令仍走它自己的审批（用户点头才动）。
 */

import { exec } from 'node:child_process';

/** 输出留多少字：界面上摆得下，日志里也够看。 */
const MAX_OUTPUT_CHARS = 400;

/**
 * 执行一条命令。
 *
 * @param {object} options
 * @param {string} options.command 命令行
 * @param {string} [options.cwd] 工作目录
 * @param {number} [options.timeoutMs] 最长跑多久
 * @returns {Promise<{ok: boolean, code: number, output: string, error: string}>}
 */
export function runCommand({ command, cwd = '', timeoutMs = 600000 }) {
  const text = String(command || '').trim();
  if (!text) return Promise.resolve({ ok: false, code: -1, output: '', error: '命令是空的' });
  return new Promise((resolve) => {
    exec(
      text,
      { cwd: cwd || undefined, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, output: clip(stdout || stderr), error: '' });
          return;
        }
        // 超时也会走到这里：它是个「被杀掉」的错误，不该当成命令自己报的错。
        const killed = error.killed || error.signal;
        const reason = killed
          ? `跑太久了，被停掉了（超过 ${Math.round(timeoutMs / 60000)} 分钟）`
          : String(error.message || error);
        resolve({
          ok: false,
          code: Number(error.code) || -1,
          output: clip(stdout || ''),
          error: clip(stderr || reason),
        });
      }
    );
  });
}

/**
 * 给 agent 的派单说明。
 *
 * **说清楚这是定时任务**：agent 不知道用户此刻在不在跟前，
 * 它要考虑的是「半夜三点也能做完」，而不是「问问用户怎么办」。
 */
export function buildAgentPrompt(task, scheduleText = '') {
  return [
    `定时任务「${task.name}」到点了${scheduleText ? `（${scheduleText}）` : ''}。`,
    '请完成下面这件事：',
    '',
    String(task.description || '').trim(),
    '',
    '怎么做由你决定：要写脚本、用工具查资料都可以。',
    '做完之后用一句话说清楚结果。',
  ].join('\n');
}

/** 留多少字。 */
function clip(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}…` : s;
}
