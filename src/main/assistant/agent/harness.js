import { spawn as nodeSpawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 外部 harness 适配器（规格 §9）。
 *
 * 外部 harness（claude code CLI 等）是**另一个会自己干活的 agent**：
 * 桌宠把一件活儿交给它，它自己跑，中间还会调它自己的工具。
 *
 * ## 三个必须记住的事实
 *
 * 1. **CLI 的输出是 JSONL，但每一行不一定都是 JSON。**
 *    正常时 stdout 一行一个 JSON；CLI 自己也会往 stdout 吐整段纯文本
 *    （比如安全分类器不可用时的说明）。认不出的行**跳过**，别抛。
 * 2. **prompt 走 stdin，不走命令行。**
 *    命令行里只放固定的参数——prompt 是模型写的，
 *    放进命令行就等于交给 shell 去拼（`"; rm -rf ~` 就是一条命令）。
 * 3. **取消要杀整棵进程树。**
 *    `child.kill()` 只杀最外面那层，孙进程还占着管道，
 *    `close` 永远不来，任务就永远不结束。
 *
 * 这一层**不 import electron**：它要在普通 node 里单测。
 */

/** 支持的外部助手。 */
export const HARNESS_AGENTS = Object.freeze({
  claude: Object.freeze({
    label: 'claude code',
    command: 'claude',
    // 固定参数表：**一个字都不能是模型写的**。
    args: Object.freeze([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
    ]),
  }),
});

/**
 * 桌宠的审批档位 → CLI 的权限模式。
 *
 * headless 运行里**没有人能回答 CLI 的权限提问**——
 * 与其让它去问一个不会有人答的问题，不如把桌宠的档位翻译过去。
 *
 * - `auto`（都不问）：用户自己选的“什么都能做”。
 * - `graded`（问一声）：读与改文件自动过（它们要的就是这个），
 *   跑命令被拒——没人能点头，那就别跑。
 * - `manual`（每件事都问）：需要权限的动作一律被拒。
 */
export function permissionModeForPolicy(policy) {
  const p = String(policy || 'graded');
  if (p === 'auto') return 'bypassPermissions';
  if (p === 'manual') return 'dontAsk';
  return 'acceptEdits';
}

/** 一行日志里最多留多少字（超了截断，不让日志涨成几十兆）。 */
const MAX_LOG_LINE = 2000;

/** 工具结果正文最多留多少字（进记录的那份）。 */
const MAX_RESULT_TEXT = 2000;

/** 截断。 */
function truncate(text, max = MAX_LOG_LINE) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 解析 CLI 的一行 JSONL。
 *
 * **返回的是数组**：一条 assistant 消息里可能有多个内容块
 * （先说一句话、再调一个工具），丢掉一个就丢信息。
 *
 * @param {string} line 一行文本
 * @returns {Array<object>} 事件（认不出的行返回空数组）
 */
export function parseHarnessLine(line) {
  const text = String(line || '').trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const type = String(data.type || '');

  // 开头那一行：会话起跑了。
  if (type === 'system' && data.subtype === 'init') {
    return [
      {
        kind: 'init',
        sessionId: String(data.session_id || ''),
        cwd: String(data.cwd || ''),
        model: String(data.model || ''),
      },
    ];
  }

  // 模型这一轮：可能有话要说，也可能要调工具。
  if (type === 'assistant') {
    const content = Array.isArray(data.message?.content) ? data.message.content : [];
    const events = [];
    for (const block of content) {
      if (block?.type === 'text') {
        events.push({ kind: 'text', text: String(block.text || '') });
      } else if (block?.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          toolId: String(block.id || ''),
          tool: String(block.name || ''),
          input: block.input && typeof block.input === 'object' ? block.input : {},
        });
      }
    }
    return events;
  }

  // 工具的结果：跟在 tool_use 后面，靠 tool_use_id 对上号。
  if (type === 'user') {
    const content = data.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const events = [];
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      events.push({
        kind: 'tool_result',
        toolId: String(block.tool_use_id || ''),
        text: resultText(block.content),
        isError: Boolean(block.is_error),
      });
    }
    return events;
  }

  // 最后一行：结果。
  if (type === 'result') {
    return [
      {
        kind: 'result',
        text: String(data.result || ''),
        isError: Boolean(data.is_error),
        subtype: String(data.subtype || ''),
        cost: Number(data.total_cost_usd) || 0,
      },
    ];
  }

  return [];
}

/** 工具结果的内容可能是字符串，也可能是内容块的数组。 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : String(block?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * 造一个 harness 启动器。
 *
 * @param {object} options
 * @param {Function} [options.spawn] 起子进程（测试注入假的）
 * @param {Function} [options.killTree] 杀整棵进程树
 * @param {string} [options.logDir] 日志目录
 * @param {Function} [options.now] 取当前时刻
 * @param {object} [options.logger] 日志器
 */
export function createHarnessRunner({
  spawn = nodeSpawn,
  killTree = null,
  logDir = '',
  now = () => Date.now(),
  logger = console,
} = {}) {
  /**
   * 起一个外部助手。
   *
   * **立刻返回**：不等它跑完——它可能跑好几分钟，
   * agent 循环不能卡在这儿（规格 §9）。后续输出走 `onEvent`。
   *
   * @returns {Promise<{ok: boolean, agent: string, logPath: string}>}
   */
  async function run({
    agent = 'claude',
    prompt = '',
    cwd = '',
    timeoutMs = 0,
    taskId = '',
    permissionMode = 'acceptEdits',
    onEvent = null,
    signal = null,
  } = {}) {
    const name = String(agent || '').trim();
    const spec = HARNESS_AGENTS[name];
    if (!spec) {
      const known = Object.keys(HARNESS_AGENTS).join('、');
      throw new Error(`还没有这个外部助手：${name || '（没填）'}（现在只有 ${known}）`);
    }
    const text = String(prompt || '').trim();
    if (!text) throw new Error('要交给它什么活儿？给个 prompt');

    // 日志：每行都留着，排查时只有它。
    const logName = `${String(taskId || 'harness')}-${now()}.log`;
    const logPath = logDir ? join(logDir, logName) : '';
    let writeChain = Promise.resolve();
    const writeLog = (source, body) => {
      if (!logPath) return;
      const line = `[${new Date(now()).toISOString()}] ${source} ${truncate(body)}\n`;
      writeChain = writeChain
        .then(() => mkdir(logDir, { recursive: true }))
        .then(() => appendFile(logPath, line, 'utf8'))
        .catch((err) => logger?.warn?.('[desk-pet] harness 日志写不进去：', err?.message));
    };

    const args = [...spec.args, '--permission-mode', String(permissionMode || 'acceptEdits')];
    let child;
    try {
      child = spawn(spec.command, args, {
        cwd: cwd || undefined,
        // **Windows 上必须走 shell**：npm 装出来的是 `claude.cmd` 批处理，
        // Node 不能直接执行它。命令行里只有固定参数，没有模型写的东西，
        // 所以过一遍 cmd 是安全的。
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`起不来 ${spec.command}：${err?.message || err}`);
    }

    // 认出来的工具调用：结果要靠 tool_use_id 对上号。
    const toolNames = new Map();
    let settled = false;
    let timer = null;
    let onAbort = null;

    const emit = (event) => {
      try {
        onEvent?.(event);
      } catch (err) {
        logger?.warn?.('[desk-pet] harness 事件的订阅者出错：', err?.message);
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (onAbort && signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    };

    // **prompt 走 stdin**：命令行里一个字都不放模型写的东西。
    try {
      child.stdin?.on('error', () => {
        /* CLI 不读 stdin 时会 EPIPE：不是错误 */
      });
      child.stdin?.end(text, 'utf8');
    } catch (err) {
      logger?.warn?.('[desk-pet] harness 的提示词没送进去：', err?.message);
    }

    // stdout：按行切，逐行解析。
    let buffer = '';
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        idx = buffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk) => {
      writeLog('stderr', String(chunk));
    });

    function handleLine(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      writeLog('stdout', trimmed);
      const events = parseHarnessLine(trimmed);
      // **认不出的行不是错误**：CLI 自己会吐纯文本。
      // 它已经进了日志，排查时看得到。
      for (const event of events) {
        if (event.kind === 'tool_use') {
          if (event.toolId) toolNames.set(event.toolId, event.tool);
          emit({
            kind: 'tool_use',
            label: `${spec.label} 调了 ${event.tool}`,
            args: event.input,
            data: { tool: event.tool },
          });
        } else if (event.kind === 'tool_result') {
          const toolName = toolNames.get(event.toolId) || '工具';
          emit({
            kind: 'tool_result',
            label: `${spec.label} 的 ${toolName} 有结果了`,
            result: truncate(event.text, MAX_RESULT_TEXT),
            error: event.isError ? '这个动作没成功' : '',
            data: { tool: toolName },
          });
        } else if (event.kind === 'text') {
          emit({
            kind: 'text',
            label: truncate(event.text, 120),
            result: truncate(event.text, MAX_RESULT_TEXT),
          });
        } else if (event.kind === 'init') {
          emit({
            kind: 'init',
            label: `${spec.label} 起来了`,
            data: { sessionId: event.sessionId, model: event.model, cwd: event.cwd },
          });
        } else if (event.kind === 'result') {
          emit({
            kind: 'result',
            label: event.isError ? `${spec.label} 没做成` : `${spec.label} 跑完了`,
            result: truncate(event.text, MAX_RESULT_TEXT),
            error: event.isError ? event.text || '它没做成这件事' : '',
            data: { subtype: event.subtype, cost: event.cost },
          });
        }
      }
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const message = `${spec.label} 起不来：${err?.message || err}`;
      writeLog('error', message);
      emit({ kind: 'error', label: message, error: message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 退出码非 0：CLI 自己没跑成（命令找不到、参数不对……）。
      if (code) {
        const message = `${spec.label} 退出了（退出码 ${code}）`;
        writeLog('exit', message);
        emit({ kind: 'error', label: message, error: message });
      }
    });

    // 超时：杀掉整棵树，别让它在后台继续改用户的东西。
    const limit = Math.max(0, Number(timeoutMs) || 0);
    if (limit > 0) {
      timer = setTimeout(() => {
        killTree?.(child);
        const message = `${spec.label} 超时了（${limit} 毫秒），已经把它杀掉`;
        writeLog('timeout', message);
        emit({ kind: 'error', label: message, error: message });
      }, limit);
    }

    // 任务被取消：把子进程带走。留着它继续跑等于没人管它。
    if (signal?.addEventListener) {
      onAbort = () => {
        killTree?.(child);
        writeLog('cancel', '任务被取消了');
        emit({ kind: 'cancelled', label: `${spec.label} 被取消了` });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    return { ok: true, agent: name, label: spec.label, logPath };
  }

  return { run };
}
