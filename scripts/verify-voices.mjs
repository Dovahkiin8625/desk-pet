// 探测 MiniMax 系统音色到底能不能用。
//
// 为什么需要这个脚本：
// 官方文档那份音色表有 327 条，但**文档里有 ≠ 你的账号能用**。
// 音色分大区（CN / 国际），key 只能打对应的大区；
// 还有的音色只支持特定模型（2043 model does not support this voice_id）。
// 建议清单里放一条用不了的音色，比不放更糟——
// 用户在设置里一下拉框，当场就会看到一个报错。
//
// 用法：
//   node scripts/verify-voices.mjs                       # 验建议清单里的全部音色
//   node scripts/verify-voices.mjs female-yujie-jingpin   # 验候选音色（可多个）
//   node scripts/verify-voices.mjs --model speech-2.6-hd  # 换一个模型验
//   node scripts/verify-voices.mjs --delay 1000           # 请求之间多歇一会儿
//   node scripts/verify-voices.mjs --user-data <dir>      # 指定 userData 目录
//
// Key 的来源与主进程一致（见 src/main/credentials.js）：
//   1. userData/credentials.json
//   2. 环境变量 MINIMAX_API_KEY
//   3. 仓库根目录的 minimax-api-key
//
// **脚本不打印 key**：它只报告每个音色「能不能合成」。
//
// 退出码：全部通过是 0，有失败是 1。
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadApiKey } from '../src/main/credentials.js';
import { synthesize, TTS_ERRORS } from '../src/main/assistant/tts/minimax.js';
import { SUGGESTED_VOICES } from '../src/main/assistant/tts/voices.js';
import { TTS_HOSTS } from '../src/shared/assistant.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'desk-pet';

/** 探测用的文本：越短越省钱，够让接口真的合成出音频就行。 */
const PROBE_TEXT = '你好';

/**
 * 应用的 userData 目录。
 *
 * Electron 的 userData = appData + app.getName()，
 * 而 app.getName() 取的是 package.json 的 name——这里跟它保持一致。
 */
function defaultUserDataDir() {
  if (process.env.DESK_PET_USER_DATA) return process.env.DESK_PET_USER_DATA;
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_NAME);
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), APP_NAME);
}

function parseArgs(argv) {
  const opts = { model: 'speech-02-hd', delayMs: 600, userData: defaultUserDataDir(), ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--delay') opts.delayMs = Number(argv[++i]);
    else if (arg === '--user-data') opts.userData = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`不认识的参数：${arg}`);
    else opts.ids.push(arg);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 试一个音色。
 *
 * 域名的处理跟主进程一样：**请求级的错误（2xxx）换域名也没用**，
 * 立刻放弃；鉴权、网络这类错误才换下一个域名再试。
 * 限流（1002）不换域名——歇一会儿重试同一个。
 */
async function probeVoice(voiceId, { apiKey, model, hosts, delayMs, retries = 2 }) {
  let lastErr = null;
  for (const host of hosts) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await synthesize({ text: PROBE_TEXT, apiKey, host, voiceId, model });
        return { ok: true, host };
      } catch (err) {
        const code = err?.code;
        if (code === TTS_ERRORS.RATE_LIMIT || code === TTS_ERRORS.TPM_LIMIT) {
          if (attempt < retries) {
            await sleep(5000 * (attempt + 1));
            continue;
          }
        }
        if (typeof code === 'number' && code >= 2000) {
          return { ok: false, code, message: err?.message || String(err) };
        }
        lastErr = err;
        break;
      }
    }
  }
  return { ok: false, code: lastErr?.code ?? null, message: lastErr?.message || '未知错误' };
}

const USAGE = `用法：
  node scripts/verify-voices.mjs [音色id ...] [选项]

选项：
  --model <模型>      默认 speech-02-hd（应用里写死的那个）
  --delay <毫秒>      请求之间的间隔，默认 600
  --user-data <目录>  userData 目录，默认按平台推断
  -h, --help          显示这份说明`;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const apiKey = await loadApiKey(opts.userData, ROOT);
if (!apiKey) {
  console.error(
    [
      '没有找到 API Key。任选一种方式提供：',
      '  1. 在设置窗口里填（落在 userData/credentials.json）',
      '  2. 设环境变量 MINIMAX_API_KEY',
      '  3. 在仓库根目录放一个 minimax-api-key 文件',
      '',
      `当前找的 userData 目录：${opts.userData}`,
    ].join('\n')
  );
  process.exit(1);
}

const ids = opts.ids.length
  ? opts.ids
  : SUGGESTED_VOICES.map((v) => v.id);

console.log(`模型：${opts.model}`);
console.log(`待验音色：${ids.length} 条`);
console.log('');

const failed = [];
for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  const result = await probeVoice(id, { apiKey, model: opts.model, hosts: TTS_HOSTS, delayMs: opts.delayMs });
  if (result.ok) {
    console.log(`  通过  ${id}  (${result.host})`);
  } else {
    const reason = result.code ? `${result.code} ${result.message}` : result.message;
    console.log(`  失败  ${id}  ${reason}`);
    failed.push({ id, code: result.code, message: result.message });
  }
  // 最后一个不用歇。
  if (i < ids.length - 1 && opts.delayMs > 0) await sleep(opts.delayMs);
}

console.log('');
console.log(`通过 ${ids.length - failed.length} / ${ids.length}`);
if (failed.length) {
  console.log('失败明细（这些不要放进建议清单）：');
  for (const f of failed) console.log(`  ${f.id}\t${f.code ?? '-'}\t${f.message}`);
}
process.exit(failed.length ? 1 : 0);
