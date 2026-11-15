import os from 'node:os';
import { execFile } from 'node:child_process';

/**
 * 网络采样。
 *
 * 三样东西，三个来源：
 *
 * - **上/下行速率**：`netstat -e` 给的是累计字节数，
 *   两次采样相减除以间隔就是速率。第一次采样没有基准，报「不知道」——
 *   报 0 KB/s 是在说谎。
 * - **Wi-Fi 信号**：`netsh wlan show interfaces`，读「信号」那一行。
 *   网线连着的时候没有这一行，信号就是 null。
 * - **连接状态与 IP**：`os.networkInterfaces()` 里非回环的 IPv4。
 *
 * 这个模块保持纯 Node（不 import electron），才能被单测直接跑。
 */

/** netstat 的采样间隔（毫秒）。 */
const STATS_MS = 2000;
/** netsh 的采样间隔（毫秒）：信号强度变得很慢。 */
const WLAN_MS = 10000;
/** 一次采样的超时（毫秒）。 */
const TIMEOUT_MS = 4000;

/** 最近一次采样结果；没采到就是 null。 */
let latest = null;
/** 上次跑 netstat 的时刻。 */
let lastStatsAt = 0;
/** 上次跑 netsh 的时刻。 */
let lastWlanAt = 0;
/** 上次采样是不是还在跑。 */
let busy = false;
/** 上一次的累计字节数与时刻：算速率的基准。 */
let prevBytes = null;
/** 上次读到的 Wi-Fi 接口（数组）。 */
let wlanList = [];

/**
 * 解码 Windows 命令的输出。
 *
 * 中文 Windows 的 netsh 输出是 UTF-8，但也有机器是 GBK：
 * 先按 UTF-8 严格解，失败再按 GBK 解。
 */
export function decodeWindows(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  }
}

/**
 * 解析 `netstat -e` 的输出，取「字节」那一行。
 *
 * 第一行有两个数字的才是累计收发的字节数（后面几行是包数与错误数）。
 * 不按标签找——标签是中文还是英文取决于系统语言。
 *
 * @returns {object|null} { received, sent }；解析不出来就是 null。
 */
export function parseNetstatE(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const nums = line.match(/\d+/g);
    if (!nums || nums.length < 2) continue;
    const received = Number(nums[0]);
    const sent = Number(nums[1]);
    if (Number.isFinite(received) && Number.isFinite(sent)) return { received, sent };
  }
  return null;
}

/**
 * 解析 `netsh wlan show interfaces` 的输出。
 *
 * 每个接口是一段，以「名称」开头。取每段的名称、状态、信号。
 *
 * @returns {Array<object>} [{ name, state, signal, connected }]；signal 没有就是 null。
 */
export function parseWlan(text) {
  const blocks = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*(?:名称|Name)\s*[:：]/.test(line)) {
      current = { name: null, state: null, signal: null, connected: false };
      blocks.push(current);
    }
    if (!current) continue;
    const name = line.match(/^\s*(?:名称|Name)\s*[:：]\s*(.+?)\s*$/);
    if (name) current.name = name[1];
    const state = line.match(/^\s*(?:状态|State)\s*[:：]\s*(.+?)\s*$/);
    if (state) current.state = state[1];
    const signal = line.match(/^\s*(?:信号|Signal)\s*[:：]\s*(\d+)/i);
    if (signal) {
      const value = Number(signal[1]);
      if (Number.isFinite(value)) current.signal = Math.max(0, Math.min(100, value));
    }
  }
  for (const block of blocks) {
    block.connected = /已连接|connected/i.test(String(block.state || ''));
  }
  return blocks;
}

/** 跑一条命令，返回解码后的输出；跑失败就当没有输出。 */
function runCommand(run, cmd, args) {
  return new Promise((resolve) => {
    run(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'buffer' }, (err, out) => {
      if (err) {
        resolve('');
        return;
      }
      resolve(decodeWindows(out));
    });
  });
}

/** 名字归一化：比网卡名时去掉大小写、空格与非字母数字。 */
function normalize(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
}

/**
 * 找一个「连上了」的网卡：非回环的 IPv4。
 *
 * 优先选跟连着的 Wi-Fi 对得上的那个（有线和 Wi-Fi 同时在的时候，
 * Wi-Fi 的信号才说明得了问题）。
 */
function pickAdapter() {
  const nics = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nics)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push({ name, ip: addr.address });
    }
  }
  if (!candidates.length) return null;
  const wifi = wlanList.find((w) => w.connected);
  if (wifi) {
    const target = normalize(wifi.name);
    const hit = candidates.find((c) => {
      const n = normalize(c.name);
      return n && target && (n === target || n.includes(target) || target.includes(n));
    });
    if (hit) return hit;
  }
  return candidates[0];
}

/** 最近一次采到的网络状况；没采到就是 null。 */
export function networkStatus() {
  return latest;
}

/**
 * 采一次。
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFile] 跑命令（测试注入假的）
 * @param {number} [opts.now] 此刻（测试注入）
 */
export async function refreshNetwork({ execFile: run = execFile, now = Date.now() } = {}) {
  if (busy) return latest;
  busy = true;
  try {
    const wantStats = !lastStatsAt || now - lastStatsAt >= STATS_MS;
    const wantWlan = !lastWlanAt || now - lastWlanAt >= WLAN_MS;
    const jobs = [];

    if (wantStats) {
      lastStatsAt = now;
      jobs.push(
        runCommand(run, 'netstat', ['-e']).then((out) => {
          const bytes = parseNetstatE(out);
          if (!bytes) {
            // 没读出来：基准就作废，下一轮重新算，别拿旧差值糊弄。
            prevBytes = null;
            return;
          }
          if (prevBytes && now > prevBytes.at) {
            const seconds = (now - prevBytes.at) / 1000;
            const down = bytes.received - prevBytes.received;
            const up = bytes.sent - prevBytes.sent;
            // 计数器归零（网卡重置）时差值是负的：那是「不知道」，不是负速率。
            prevBytes = {
              at: now,
              received: bytes.received,
              sent: bytes.sent,
              down: down >= 0 ? down / seconds : null,
              up: up >= 0 ? up / seconds : null,
            };
          } else {
            prevBytes = { at: now, received: bytes.received, sent: bytes.sent, down: null, up: null };
          }
        })
      );
    }

    if (wantWlan) {
      lastWlanAt = now;
      jobs.push(
        runCommand(run, 'netsh', ['wlan', 'show', 'interfaces']).then((out) => {
          wlanList = out ? parseWlan(out) : [];
        })
      );
    }

    await Promise.all(jobs);

    const adapter = pickAdapter();
    const wifi = wlanList.find((w) => w.connected) || null;
    latest = {
      // 字节每秒。第一次采样是 null（还没有基准）。
      down: prevBytes?.down ?? null,
      up: prevBytes?.up ?? null,
      // 信号：连着 Wi-Fi 才有。
      signal: wifi?.signal ?? null,
      wifi: Boolean(wifi),
      // 连上了没有（有没有非回环的 IPv4）。
      connected: Boolean(adapter),
      ip: adapter?.ip ?? null,
      adapter: adapter?.name ?? null,
    };
  } finally {
    busy = false;
  }
  return latest;
}

/** 测试用：把内部状态复位。 */
export function resetNetworkState() {
  latest = null;
  lastStatsAt = 0;
  lastWlanAt = 0;
  busy = false;
  prevBytes = null;
  wlanList = [];
}
