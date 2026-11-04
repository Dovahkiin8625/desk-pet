// plugins/screen-recorder/lib/config.js
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 录屏插件的配置。
 *
 * 配置存在 userData/screen-recorder.json——**不放插件目录里**：
 * 插件目录在安装目录下，多半没有写权限。
 *
 * 写盘是**原子**的（先写 .tmp 再 rename）：普通 writeFile 会先把目标截断成
 * 0 字节，写到一半被强杀就留下一个空文件，下次启动配置全丢。
 */

/** 默认值。outputDir 为空串 = 用系统的「视频」文件夹。 */
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'screen', // screen | region | window
  format: 'video', // video | gif
  mic: false,
  speaker: true,
  outputDir: '',
  sourceId: '',
  hotkey: 'Control+Shift+R',
  fps: 30,
  gifWidth: 480,
  gifFps: 12,
});

export const MODES = Object.freeze(['screen', 'region', 'window']);
export const FORMATS = Object.freeze(['video', 'gif']);

/** 配置文件的位置。 */
export function configPath(userDataDir) {
  return join(userDataDir, 'screen-recorder.json');
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 规整一份配置。
 *
 * 配置是**磁盘上的文件**，用户（或手滑的程序）写什么都不奇怪：
 * 认不出的值一律退回默认，而不是照着坏值往下跑。
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const c = { ...DEFAULT_CONFIG, ...source };
  if (!MODES.includes(c.mode)) c.mode = DEFAULT_CONFIG.mode;
  if (!FORMATS.includes(c.format)) c.format = DEFAULT_CONFIG.format;
  c.mic = Boolean(c.mic);
  c.speaker = Boolean(c.speaker);
  c.outputDir = typeof c.outputDir === 'string' ? c.outputDir : '';
  c.sourceId = typeof c.sourceId === 'string' ? c.sourceId : '';
  c.hotkey = typeof c.hotkey === 'string' ? c.hotkey.trim() : DEFAULT_CONFIG.hotkey;
  c.fps = clampInt(c.fps, 5, 60, DEFAULT_CONFIG.fps);
  c.gifWidth = clampInt(c.gifWidth, 160, 1920, DEFAULT_CONFIG.gifWidth);
  c.gifFps = clampInt(c.gifFps, 5, 30, DEFAULT_CONFIG.gifFps);
  return c;
}

/** 读配置；读不到或读坏了都退回默认。 */
export async function readConfig(userDataDir) {
  try {
    const text = await readFile(configPath(userDataDir), 'utf8');
    return normalizeConfig(JSON.parse(text));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[录屏] 配置读不了，用默认值：', err?.message);
    }
    return normalizeConfig({});
  }
}

/** 写配置（原子）。 */
export async function writeConfig(userDataDir, config) {
  const value = normalizeConfig(config);
  await mkdir(userDataDir, { recursive: true });
  const target = configPath(userDataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return value;
}
