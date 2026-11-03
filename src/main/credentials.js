import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './store.js';

/**
 * API Key 的存取。
 *
 * **key 永远不进渲染层。** 它不写进 settings.json、不随设置广播下发，
 * 设置窗口只能读到「已配置 ****abcd」这样的掩码。
 *
 * 读取优先级：
 * 1. `userData/credentials.json` —— 设置窗口里填的（正本）
 * 2. 环境变量 `MINIMAX_API_KEY`
 * 3. 项目根目录的 `minimax-api-key` —— 开发期的引导来源
 *
 * 第 3 条是为了开发方便：仓库根目录里放一个 key 文件，
 * `npm start` 就能用，不必每次都去设置窗口里粘一遍。
 * 它已经被 .gitignore 排除，也被 app:// 协议的拒绝清单挡住
 * （渲染层拿不到它）。
 */

const FILE_NAME = 'credentials.json';

/** key 的掩码：只露出末尾 4 个字符。 */
export function maskKey(key) {
  const text = String(key || '');
  if (!text) return '';
  if (text.length <= 8) return '********';
  return `****${text.slice(-4)}`;
}

/** 读一次 key（按优先级）。返回 null 表示没有可用的 key。 */
export async function loadApiKey(userDataDir, rootDir = null) {
  try {
    const raw = await readJson(userDataDir, FILE_NAME, null, FILE_NAME);
    const key = raw?.minimaxApiKey;
    if (typeof key === 'string' && key.trim() !== '') return key.trim();
  } catch {
    /* 读不到就往下找 */
  }
  const fromEnv = process.env.MINIMAX_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  if (rootDir) {
    try {
      const text = await readFile(join(rootDir, 'minimax-api-key'), 'utf8');
      const key = text.trim();
      if (key !== '') return key;
    } catch {
      /* 没有这个文件是正常的 */
    }
  }
  return null;
}

/** 保存 key（设置窗口里填的）。 */
export async function saveApiKey(userDataDir, key) {
  const value = String(key ?? '').trim();
  const existing = await readJson(userDataDir, FILE_NAME, {}, FILE_NAME).catch(() => ({}));
  const next = { ...(existing || {}), minimaxApiKey: value };
  await writeJson(userDataDir, FILE_NAME, next);
  return maskKey(value);
}

/** 当前 key 的状态：给设置窗口显示（只回掩码，绝不回明文）。 */
export async function apiKeyStatus(userDataDir, rootDir = null) {
  const key = await loadApiKey(userDataDir, rootDir);
  return {
    configured: Boolean(key),
    mask: key ? maskKey(key) : '',
  };
}

// ---------------------------------------------------------------------------
// 对话（LLM）用的 key
//
// 与 TTS 的 key **分开存**：用户可能把对话指向另一个 OpenAI 兼容服务
// （DeepSeek、通义、OpenAI 自己……），那儿的 key 与 MiniMax 的不是一回事。
//
// 但**留空就沿用 MiniMax 的 key**——大多数人只有一个 key，
// 让人再去填一遍是白折腾。
// ---------------------------------------------------------------------------

/** 只读对话自己那份 key（不看回落）。 */
async function readDedicatedLlmKey(userDataDir) {
  try {
    const raw = await readJson(userDataDir, FILE_NAME, null, FILE_NAME);
    const key = raw?.llmApiKey;
    if (typeof key === 'string' && key.trim() !== '') return key.trim();
  } catch {
    /* 读不到就往下找 */
  }
  const fromEnv = process.env.LLM_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return null;
}

/**
 * 读一次对话用的 key。
 *
 * 优先级：对话自己的 key → `LLM_API_KEY` 环境变量 → MiniMax 的 key。
 */
export async function loadLlmApiKey(userDataDir, rootDir = null) {
  const dedicated = await readDedicatedLlmKey(userDataDir);
  if (dedicated) return dedicated;
  return loadApiKey(userDataDir, rootDir);
}

/** 保存对话用的 key（设置窗口里填的）。 */
export async function saveLlmApiKey(userDataDir, key) {
  const value = String(key ?? '').trim();
  const existing = await readJson(userDataDir, FILE_NAME, {}, FILE_NAME).catch(() => ({}));
  const next = { ...(existing || {}), llmApiKey: value };
  await writeJson(userDataDir, FILE_NAME, next);
  return maskKey(value);
}

/**
 * 对话 key 的状态：给设置窗口显示（只回掩码，绝不回明文）。
 *
 * `dedicated` 说明它是**单独配的**——没单独配就是沿用 MiniMax 的那个。
 */
export async function llmKeyStatus(userDataDir, rootDir = null) {
  const dedicated = await readDedicatedLlmKey(userDataDir);
  const key = dedicated || (await loadApiKey(userDataDir, rootDir));
  return {
    configured: Boolean(key),
    dedicated: Boolean(dedicated),
    mask: key ? maskKey(key) : '',
  };
}
