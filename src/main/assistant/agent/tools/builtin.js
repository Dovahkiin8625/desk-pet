import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { DEFAULT_AGENT, TOOL_RISK } from '../../../../shared/assistant.js';

/**
 * agent 的内置工具集。
 *
 * 七个工具：读文件、列目录、搜文件、写文件、执行命令、启动程序、读剪贴板。
 *
 * **这一层不 import electron**：剪贴板、程序索引、子进程都靠注入。
 * 这么做的理由很实在——它们是本项目里**最危险**的一批能力，
 * 能在普通 node 里测，才谈得上「测试盯着它」。
 *
 * ## 路径边界：只读工具关住，写/执行工具不关
 *
 * 规格 §5.3 说得很明确：**路径逃逸的检查只在 `risk: 'read'` 的内置工具上强制**。
 *
 * 理由是审批模型：只读工具**自动放行**（用户不在场），
 * 所以它们必须被工作区关住——不然一次注入就能把整台机器上的文件读出来。
 * 写与执行工具要走用户审批，用户看得见具体路径、自己点头，
 * 再关边界就只会让 agent 什么都干不了。
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
 * 把一个路径解析成工作区里的绝对路径；越界就抛错。
 *
 * **只读工具用它**，写/执行工具不用（见文件头的说明）。
 *
 * 相对路径按工作区解析；绝对路径原样解析，但要检查它是不是还在工作区里。
 */
export function resolveInsideWorkspace(base, target) {
  const root = resolve(base);
  const full = isAbsolute(String(target)) ? resolve(String(target)) : resolve(root, String(target));
  const rel = relative(root, full);
  // rel 以 '..' 开头就是跑到工作区外面去了；
  // isAbsolute(rel) 是另一头的情况（不同的盘符）。
  if (rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error(`路径「${target}」在工作区（${root}）外面，不给碰`);
  }
  return full;
}

/**
 * 走一个目录树，把文件交给 visit。
 *
 * 搜文件用：node_modules 与 .git 里几十万文件，
 * 全翻一遍能把一次搜索拖到几十秒。
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
 * 在 shell 里跑一条命令。
 *
 * 超时会**杀掉子进程**并当成一次工具失败——超时的命令可能正在改文件，
 * 让它继续跑比杀掉更危险。
 */
function runShell(command, cwd, timeoutMs, spawn, signal) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      // shell: true —— Windows 上走 cmd.exe，别的平台走 /bin/sh。
      child = spawn(command, { cwd, shell: true, windowsHide: true });
    } catch (err) {
      reject(new Error(`命令起不来：${err?.message || err}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(chunk);
    });
    child.on('error', (err) => finish(() => reject(new Error(`命令执行失败：${err?.message || err}`))));
    child.on('close', (code) =>
      finish(() => resolvePromise({ code: code ?? 0, stdout, stderr, timedOut }))
    );

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            /* 已经死了就算了 */
          }
        }, timeoutMs)
      : null;

    // 任务被取消时也要把子进程带走：留着它继续跑等于没人管它。
    signal?.addEventListener?.('abort', () => {
      try {
        child.kill();
      } catch {
        /* 同上 */
      }
    });
  });
}

/**
 * 造出内置工具集。
 *
 * 所有会碰到「外面」的东西都靠注入：
 * - `getWorkspace()`：工作区目录（空 = 用户主目录）；
 * - `getTimeoutMs()`：单个工具调用的超时；
 * - `readClipboard()`：读剪贴板；
 * - `isClipboardEnabled()`：剪贴板助手开没开（关着就不给读）；
 * - `getAppIndex()`：本机程序索引（用来启动程序）；
 * - `spawn`：起子进程（测试注入假的）。
 *
 * @returns {Array<object>} 工具描述符数组
 */
export function createBuiltinTools({
  getWorkspace = () => '',
  getTimeoutMs = () => DEFAULT_AGENT.timeoutMs,
  readClipboard = null,
  isClipboardEnabled = () => true,
  getAppIndex = () => null,
  spawn = nodeSpawn,
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
        const full = resolveInsideWorkspace(workspaceDir(), path);
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
          path: { type: 'string', description: '目录路径，默认是工作区' },
        },
        required: [],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const path = String(args?.path || '').trim() || '.';
        const full = resolveInsideWorkspace(workspaceDir(), path);
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
          path: { type: 'string', description: '从哪个目录开始搜，默认是工作区' },
        },
        required: ['pattern'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const pattern = String(args?.pattern || '').trim();
        if (!pattern) throw new Error('要搜什么？给个 pattern');
        const root = resolveInsideWorkspace(workspaceDir(), String(args?.path || '').trim() || '.');
        const hits = [];
        await walkFiles(root, async (file) => {
          if (hits.length >= MAX_SEARCH_HITS) return;
          let raw = '';
          try {
            raw = await readFile(file, 'utf8');
          } catch {
            return;
          }
          if (raw.length > MAX_SEARCH_FILE_BYTES) return;
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
      // **不设工作区边界**：写工具要走用户审批，用户看得见路径、自己点头。
      // 只读工具是自动放行的，所以只有它们必须被关住（见文件头）。
      async run(args) {
        const path = String(args?.path || '').trim();
        if (!path) throw new Error('要写哪个文件？给个 path');
        const full = isAbsolute(path) ? resolve(path) : resolve(workspaceDir(), path);
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
        if (result.timedOut) {
          throw new Error(`命令超时了（${timeoutMs} 毫秒），已经把它杀掉：${command}`);
        }
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
      name: 'clipboard.read',
      label: '读剪贴板',
      description: '读一次剪贴板里的文字。',
      parameters: { type: 'object', properties: {}, required: [] },
      risk: TOOL_RISK.READ,
      async run() {
        // 剪贴板助手默认是关的（用户没点头就不该读）——
        // 工具不能绕过用户这个开关。
        if (!isClipboardEnabled()) {
          throw new Error('剪贴板助手没开（去设置里打开它才能读）');
        }
        if (typeof readClipboard !== 'function') throw new Error('剪贴板读不了');
        const text = await readClipboard();
        const content = String(text || '');
        return {
          text: truncate(content || '（剪贴板是空的）', MAX_RESULT_TEXT),
          data: { length: content.length },
        };
      },
    },
  ];
}
