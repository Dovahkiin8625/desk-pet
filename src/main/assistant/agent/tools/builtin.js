import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_AGENT, TOOL_RISK } from '../../../../shared/assistant.js';
import { permissionModeForPolicy } from '../harness.js';

/**
 * agent 的内置工具集。
 *
 * 六个工具：读文件、列目录、搜文件、写文件、执行命令、启动程序。
 *
 * **这一层不 import electron**：程序索引、子进程都靠注入。
 * 这么做的理由很实在——它们是本项目里**最危险**的一批能力，
 * 能在普通 node 里测，才谈得上「测试盯着它」。
 *
 * ## 路径：不设目录边界
 *
 * 规格 §5.3 原本要求：**路径逃逸的检查只在 `risk: 'read'` 的内置工具上强制**——
 * 只读工具自动放行（用户不在场），所以得靠工作区把它们关住。
 *
 * 现在**一律不设边界**：用户要 agent 能碰到工作区之外的目录（素材在别的盘符上）。
 * 代价是：一次提示词注入就能把本机的文件读出来。
 * 收紧的口子是**审批策略**（设置里的 `approval.policy`），
 * 但审批气泡是 L3 的活，还没上线——在那之前只读操作完全放行。
 * 工作区仍然有用：它是相对路径的基准，也是 `shell.exec` 的默认目录。
 *
 * ## 工具出错一律抛错
 *
 * 工具失败时**抛**，不返回空字符串：agent 循环会把错误喂回模型，
 * 模型可以换个参数再试一次。返回空字符串的话，模型会以为「文件是空的」。
 */

/** 给模型看的结果正文，最多多少字。 */
const MAX_RESULT_TEXT = 4000;

/** 命令输出最多留多少字（再多对模型也没用，还会把上下文冲垮）。 */
const MAX_OUTPUT = 8000;

/** 一次列目录最多回报多少项。 */
const MAX_LIST_ENTRIES = 200;

/** 一次搜索最多回报多少条命中。 */
const MAX_SEARCH_HITS = 50;

/** 一次搜索最多翻多少个文件。 */
const MAX_SEARCH_FILES = 5000;

/** 读文件时最多读多少行（整份读进内存会被大文件撑爆）。 */
const MAX_READ_LINES = 500;

/**
 * 读文件时最多读多少**字节**。
 *
 * 行数上限管不住内存：模型传个 `start`/`end` 也救不了——
 * 整份文件已经进内存了。一个 2GB 的视频文件（当文本读）就能把主进程撑爆。
 * 所以先按字节拦一道，超了直接报错，让模型换条路（先 fs.search 定位）。
 */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/** 搜索时跳过这些目录：它们太大，而且 agent 一般不该去动依赖与版本库。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'out', '.next']);

/** 超过这个大小（字节）的文件不搜：多半是二进制或压缩包。 */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

/**
 * 把一段文字截到上限，截了就说清楚截了。
 *
 * 截断必须**留痕**：模型看到半句话会以为文件就这么多。
 */
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…（已截断）` : s;
}

/**
 * 把一个路径解析成绝对路径。
 *
 * 相对路径按工作区解析；绝对路径原样解析（别的盘符也算）。
 *
 * 原来这里有一道「只能碰工作区」的护栏，越界就抛错。
 * 用户明确要 agent 能访问工作区之外的目录，于是这道护栏撤了：
 * 要收紧只能靠审批策略，而审批气泡还没上线。
 *
 * 相对路径里带 `..` 也不再拦：它只是回到工作区的上级目录，
 * 既然绝对路径随便给，这一点上没有区别。
 */
export function resolveToolPath(base, target) {
  const root = resolve(base);
  const t = String(target);
  return isAbsolute(t) ? resolve(t) : resolve(root, t);
}

/**
 * 走一个目录树，把文件交给 visit。
 *
 * 搜文件用：node_modules 与 .git 里几十万文件，
 * 全翻一遍能把一次搜索拖到几十秒。
 *
 * **链接一律跳过**：链接可能绕回上级目录，跟着走就会陷入死循环；
 * 顺着链接读文件用 `fs.read` 指定完整路径就行，不需要靠遍历。
 */
async function walkFiles(root, visit) {
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 读不到就跳过（没权限、被删了）
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue; // 链接：可能通向外面，不碰
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      count += 1;
      if (count > MAX_SEARCH_FILES) return;
      await visit(full);
    }
  }
}

/**
 * 杀掉一个子进程**连它的孙进程**。
 *
 * ## 为什么要杀整棵树
 *
 * `child.kill()` 只杀最外面那一层：
 * - Windows 上最外面是 `cmd.exe`，它起的 `ping.exe`、`node.exe` 什么的还活着；
 * - 那些孙进程还占着 stdout/stderr 的管道，`close` 事件就永远不来——
 *   于是「超时了但 Promise 不结算」，整个 agent 循环卡在那儿转圈。
 *
 * 所以：
 * - Windows 用 `taskkill /T /F`（/T = 连子进程一起杀）；
 * - 别的平台杀整个进程组（起进程时 `detached: true`，于是它自成一组）。
 *
 * @returns {'taskkill'|'group'|'kill'|'none'} 用了哪种方式
 */
export function killProcessTree(child, { spawn = nodeSpawn, platform = process.platform, kill = process.kill } = {}) {
  const pid = child?.pid;
  if (!pid) {
    try {
      child?.kill?.();
    } catch {
      /* 已经死了就算了 */
    }
    return 'none';
  }
  if (platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return 'taskkill';
    } catch {
      /* taskkill 起不来就落回 child.kill() */
    }
  }
  try {
    kill(-pid, 'SIGKILL');
    return 'group';
  } catch {
    /* 没有这个进程组就落回 child.kill() */
  }
  try {
    child.kill?.('SIGKILL');
    return 'kill';
  } catch {
    return 'none';
  }
}

/**
 * 在 shell 里跑一条命令。
 *
 * 超时会**杀掉整棵进程树**并当成一次工具失败——超时的命令可能正在改文件，
 * 让它继续跑比杀掉更危险。
 *
 * **超时就立刻结算**：不等 `close`。`close` 要等所有管道关闭，
 * 而孙进程还活着时管道就不会关——等它等于把 agent 循环卡死。
 */
function runShell(command, cwd, timeoutMs, spawn, signal) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      // shell: true —— Windows 上走 cmd.exe，别的平台走 /bin/sh。
      // detached 只在别的平台开：Windows 上它会另开一个控制台窗口，
      // 而 Windows 那边靠 taskkill /T 杀树，用不着进程组。
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(new Error(`命令起不来：${err?.message || err}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let onAbort = null;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // 摘掉 abort 监听：不然调用多了监听器会越堆越多。
      if (onAbort && signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
      onAbort = null;
      fn();
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(chunk);
    });
    child.on('error', (err) => finish(() => reject(new Error(`命令执行失败：${err?.message || err}`))));
    child.on('close', (code) => finish(() => resolvePromise({ code: code ?? 0, stdout, stderr })));

    timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killProcessTree(child, { spawn });
            finish(() =>
              reject(new Error(`命令超时了（${timeoutMs} 毫秒），已经把它杀掉：${command}`))
            );
          }, timeoutMs)
        : null;

    // 任务被取消时也要把子进程带走：留着它继续跑等于没人管它。
    if (signal?.addEventListener) {
      onAbort = () => {
        killProcessTree(child, { spawn });
        finish(() => reject(new Error(`命令被取消了：${command}`)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 造出内置工具集。
 *
 * 所有会碰到「外面」的东西都靠注入：
 * - `getWorkspace()`：工作区目录（空 = 用户主目录）；
 * - `getTimeoutMs()`：单个工具调用的超时；
 * - `getAppIndex()`：本机程序索引（用来启动程序）；
 * - `spawn`：起子进程（测试注入假的）；
 * - `harness`：外部助手运行器（`harness.run` 工具用，没接上就不给这个工具）；
 * - `getPolicy()`：审批档位（决定外部助手的权限模式）。
 *
 * @returns {Array<object>} 工具描述符数组
 */
export function createBuiltinTools({
  getWorkspace = () => '',
  getTimeoutMs = () => DEFAULT_AGENT.timeoutMs,
  getAppIndex = () => null,
  spawn = nodeSpawn,
  harness = null,
  getPolicy = () => DEFAULT_AGENT.approval.policy,
} = {}) {
  /** 工作区目录：没配就用用户主目录（总得有个起点）。 */
  function workspaceDir() {
    const configured = String(getWorkspace() || '').trim();
    return configured ? resolve(configured) : homedir();
  }

  return [
    {
      name: 'fs.read',
      label: '读文件',
      description: '读一个文本文件。可以带 start/end 指定行范围（行号从 1 开始，含首含尾）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对工作区或绝对路径）' },
          start: { type: 'number', description: '起始行号，从 1 开始' },
          end: { type: 'number', description: '结束行号，含' },
        },
        required: ['path'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const path = String(args?.path || '').trim();
        if (!path) throw new Error('要读哪个文件？给个 path');
        const full = resolveToolPath(workspaceDir(), path);
        // 先看大小再读：整份读进内存，一个大文件就能把主进程撑爆。
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch (err) {
          throw new Error(`读不了 ${full}：${err?.message || err}`);
        }
        if (size > MAX_READ_BYTES) {
          throw new Error(
            `文件太大（${size} 字节，超过 ${MAX_READ_BYTES} 字节），读不了；` +
              '先用 fs.search 找到要的那几行，再读小一点的文件'
          );
        }
        let raw = '';
        try {
          raw = await readFile(full, 'utf8');
        } catch (err) {
          throw new Error(`读不了 ${full}：${err?.message || err}`);
        }
        const lines = raw.split(/\r?\n/);
        const start = Number.isFinite(args?.start) ? Math.max(1, Math.floor(args.start)) : 1;
        const end = Number.isFinite(args?.end)
          ? Math.max(start, Math.floor(args.end))
          : Math.min(lines.length, start + MAX_READ_LINES - 1);
        const slice = lines.slice(start - 1, end);
        return {
          text: truncate(slice.join('\n'), MAX_RESULT_TEXT),
          data: {
            path: full,
            start,
            end: start + slice.length - 1,
            totalLines: lines.length,
          },
        };
      },
    },

    {
      name: 'fs.list',
      label: '列目录',
      description: '列出一个目录里的内容（文件与子目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认是工作区；可以给绝对路径' },
        },
        required: [],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const path = String(args?.path || '').trim() || '.';
        const full = resolveToolPath(workspaceDir(), path);
        let entries = [];
        try {
          entries = await readdir(full, { withFileTypes: true });
        } catch (err) {
          throw new Error(`列不了 ${full}：${err?.message || err}`);
        }
        const list = entries
          .slice(0, MAX_LIST_ENTRIES)
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
          }));
        const text = list.map((e) => `${e.type === 'dir' ? '[目录]' : '[文件]'} ${e.name}`).join('\n');
        return {
          text: truncate(text || '（空目录）', MAX_RESULT_TEXT),
          data: { path: full, entries: list, total: entries.length },
        };
      },
    },

    {
      name: 'fs.search',
      label: '搜文件内容',
      description: '在一个目录里递归搜索包含某段文字的文件，返回命中的文件与行号。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜的那段文字（按字面匹配，不认正则）' },
          path: { type: 'string', description: '从哪个目录开始搜，默认是工作区；可以给绝对路径' },
        },
        required: ['pattern'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const pattern = String(args?.pattern || '').trim();
        if (!pattern) throw new Error('要搜什么？给个 pattern');
        const root = resolveToolPath(
          workspaceDir(),
          String(args?.path || '').trim() || '.'
        );
        const hits = [];
        await walkFiles(root, async (file) => {
          if (hits.length >= MAX_SEARCH_HITS) return;
          // **按字节算大小**：按字数算的话，中文文件永远小于阈值，
          // 阈值就成了摆设。先 stat 再决定要不要读。
          let size = 0;
          try {
            size = (await stat(file)).size;
          } catch {
            return;
          }
          if (size > MAX_SEARCH_FILE_BYTES) return;
          let raw = '';
          try {
            raw = await readFile(file, 'utf8');
          } catch {
            return;
          }
          const lines = raw.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (!lines[i].includes(pattern)) continue;
            hits.push({ file, line: i + 1, text: lines[i].slice(0, 300) });
            if (hits.length >= MAX_SEARCH_HITS) return;
          }
        });
        const text = hits.length
          ? hits.map((h) => `${h.file}:${h.line} ${h.text}`).join('\n')
          : `没有找到包含「${pattern}」的文件`;
        return { text: truncate(text, MAX_RESULT_TEXT), data: { pattern, hits } };
      },
    },

    {
      name: 'fs.write',
      label: '写文件',
      description: '写一个文本文件（同名文件会被覆盖，不存在就新建）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写进去的内容' },
        },
        required: ['path', 'content'],
      },
      risk: TOOL_RISK.WRITE,
      // **写工具要走用户审批**：用户看得见路径、自己点头。
      // 只读工具是自动放行的，所以要收紧就靠审批策略（见文件头）。
      async run(args) {
        const path = String(args?.path || '').trim();
        if (!path) throw new Error('要写哪个文件？给个 path');
        const full = resolveToolPath(workspaceDir(), path);
        const content = String(args?.content ?? '');
        try {
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, content, 'utf8');
        } catch (err) {
          throw new Error(`写不了 ${full}：${err?.message || err}`);
        }
        return {
          text: `已写入 ${full}（${content.length} 字）`,
          data: { path: full, bytes: content.length },
        };
      },
    },

    {
      name: 'shell.exec',
      label: '执行命令',
      description: '在 shell 里执行一条命令（默认在工作区目录下），返回输出与退出码。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录，默认是工作区' },
        },
        required: ['command'],
      },
      risk: TOOL_RISK.EXEC,
      async run(args, ctx) {
        const command = String(args?.command || '').trim();
        if (!command) throw new Error('要执行什么命令？给个 command');
        const cwdArg = String(args?.cwd || '').trim();
        const cwd = cwdArg
          ? isAbsolute(cwdArg)
            ? resolve(cwdArg)
            : resolve(workspaceDir(), cwdArg)
          : workspaceDir();
        const timeoutMs = Math.max(0, Number(getTimeoutMs()) || 0);
        const result = await runShell(command, cwd, timeoutMs, spawn, ctx?.signal);
        const parts = [`退出码 ${result.code}`];
        if (result.stdout.trim()) parts.push(`输出：\n${result.stdout.trim()}`);
        if (result.stderr.trim()) parts.push(`错误输出：\n${result.stderr.trim()}`);
        return {
          text: truncate(parts.join('\n'), MAX_RESULT_TEXT),
          data: {
            command,
            cwd,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        };
      },
    },

    {
      name: 'app.launch',
      label: '启动程序',
      description: '按名字启动本机已安装的程序（会真的把程序打开）。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '程序名，可以是名字的一部分' },
        },
        required: ['name'],
      },
      risk: TOOL_RISK.EXEC,
      async run(args) {
        const name = String(args?.name || '').trim();
        if (!name) throw new Error('要启动哪个程序？给个 name');
        const index = getAppIndex?.() || null;
        if (!index) throw new Error('程序索引还没准备好');
        const apps = await index.list();
        const list = Array.isArray(apps) ? apps : [];
        const wanted = name.toLowerCase();
        // 先找全名相等的，再找名字里包含的——
        // 否则搜「记事」可能先撞上「记事本 2」，而用户要的是「记事本」。
        const match =
          list.find((a) => String(a?.name || '').toLowerCase() === wanted) ||
          list.find((a) => String(a?.name || '').toLowerCase().includes(wanted));
        if (!match) throw new Error(`没找到叫「${name}」的程序`);
        const result = await index.launch(match.id);
        if (!result?.ok) throw new Error(result?.message || `打不开 ${match.name}`);
        return {
          text: result.message || `已打开 ${match.name}`,
          data: { id: match.id, name: match.name, target: match.target },
        };
      },
    },

    {
      name: 'harness.run',
      label: '外部助手',
      description:
        '把一件活儿交给外部助手（claude code）去做。' +
        '它会自己在你的机器上动手，可能跑很久：工具**立刻返回**，' +
        '过程与结果会陆续出现在记录里——不要凭空编一个结果出来。',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: '外部助手的名字（现在只有 claude）' },
          prompt: { type: 'string', description: '要交给它的活儿，写清楚要什么' },
          cwd: { type: 'string', description: '工作目录，默认是工作区' },
          timeout: { type: 'number', description: '最多跑多久（毫秒），默认用设置里的上限' },
        },
        required: ['prompt'],
      },
      // **执行级**：它在用户机器上起一个会自己动手的进程，
      // 与 `shell.exec` 同档——审批不能把它当成只读放过去。
      risk: TOOL_RISK.EXEC,
      async run(args, ctx) {
        if (!harness || typeof harness.run !== 'function') {
          throw new Error('外部助手还没接上');
        }
        const agent = String(args?.agent || 'claude').trim();
        const prompt = String(args?.prompt || '').trim();
        if (!prompt) throw new Error('要交给它什么活儿？给个 prompt');
        const cwdArg = String(args?.cwd || '').trim();
        const cwd = cwdArg
          ? isAbsolute(cwdArg)
            ? resolve(cwdArg)
            : resolve(workspaceDir(), cwdArg)
          : workspaceDir();
        // 超时：模型给的优先，没给就用设置里的那个上限。
        const timeoutMs = Math.max(0, Number(args?.timeout) || Number(getTimeoutMs()) || 0);
        const started = await harness.run({
          agent,
          prompt,
          cwd,
          timeoutMs,
          taskId: String(ctx?.taskId || ''),
          // 桌宠的审批档位 → CLI 的权限模式（headless 里没人能回答它的提问）。
          permissionMode: permissionModeForPolicy(getPolicy()),
          signal: ctx?.signal,
          // 过程走**异步事件**：工具返回之后它还在跑，输出一条条进记录。
          onEvent: (event) => {
            ctx?.onEvent?.({
              tool: 'harness.run',
              label: event?.label,
              args: event?.args ?? null,
              result: event?.result,
              error: event?.error,
              data: event?.data ?? null,
            });
          },
        });
        return {
          text:
            `已启动${started?.label || '外部助手'}，它会自己跑完。` +
            '过程与结果会陆续出现在记录里，别凭空编结果。',
          data: { agent, cwd, timeoutMs, logPath: started?.logPath || '' },
        };
      },
    },
  ];
}
