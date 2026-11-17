/**
 * 桌宠天气效果：钥匙、文案与「按当前天气 / 季节播哪一种」的规则。
 *
 * 触发有两条路，都用这一份规则：
 * - assistant 的定时器偶尔掷骰子（随机、偶尔）；
 * - 天气插件里的「预览效果」按钮（点名要看，立刻播）。
 */

export const WEATHER_EFFECT = Object.freeze({
  RAIN: 'rain',
  WIND: 'wind',
  SNOW: 'snow',
  SUN: 'sun',
  LEAVES: 'leaves',
});

export const WEATHER_EFFECT_LABEL = Object.freeze({
  rain: '下雨',
  wind: '刮风',
  snow: '下雪',
  sun: '晴天',
  leaves: '落叶',
});

/** 下拉里的候选项：自动 + 五种效果（中文，与清单 options 一致）。 */
export const WEATHER_EFFECT_OPTIONS = Object.freeze(['自动', '下雨', '刮风', '下雪', '晴天', '落叶']);

/**
 * 每个候选项的图标（天气面板里的小方框预览用）。
 * 钥匙是 `normalizeEffectChoice` 规整后的值：'auto' 与五种效果的钥匙。
 */
export const WEATHER_EFFECT_ICON = Object.freeze({
  auto: 'sparkles',
  rain: 'cloud-rain',
  wind: 'wind',
  snow: 'cloud-snow',
  sun: 'sun',
  leaves: 'leaf',
});

/** 一波特效多久收尾（毫秒）。 */
export const EFFECT_DURATION_MS = 10000;

/** 偶尔触发：多久掷一次骰子。 */
export const EFFECT_CHECK_MS = 5 * 60 * 1000;
/** 偶尔触发：单次掷骰子的概率。 */
export const EFFECT_TRIGGER_CHANCE = 0.35;
/** 偶尔触发：两次播放之间的最小间隔。 */
export const EFFECT_MIN_GAP_MS = 20 * 60 * 1000;

/** WMO：下雨（含冻雨、阵雨、雷阵雨）。 */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
/** WMO：下雪（含雪粒、阵雪）。 */
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

export function isRainCode(code) {
  return RAIN_CODES.has(Number(code));
}

export function isSnowCode(code) {
  return SNOW_CODES.has(Number(code));
}

/** 0-based 月份 → 季节（12/1/2 冬、3/4/5 春、6/7/8 夏、9/10/11 秋）。 */
export function seasonForMonth(month) {
  const m = Number(month);
  if (!Number.isInteger(m) || m < 0 || m > 11) return 'spring';
  if (m === 11 || m <= 1) return 'winter';
  if (m <= 4) return 'spring';
  if (m <= 7) return 'summer';
  return 'autumn';
}

/** 风速到这个档就算「刮风」（open-meteo wind_speed_10m，单位 km/h）。 */
export const HIGH_WIND_KMH = 25;

/**
 * 「自动」时按当前天气与季节抽哪一种：
 * 天气代码优先（雪 > 雨 > 风），其次季节（秋 → 落叶，冬 → 雪），否则晴天。
 */
export function resolveAutoEffect({ code, wind, month } = {}) {
  if (isSnowCode(code)) return WEATHER_EFFECT.SNOW;
  if (isRainCode(code)) return WEATHER_EFFECT.RAIN;
  const w = Number(wind);
  if (Number.isFinite(w) && w >= HIGH_WIND_KMH) return WEATHER_EFFECT.WIND;
  const season = seasonForMonth(month);
  if (season === 'autumn') return WEATHER_EFFECT.LEAVES;
  if (season === 'winter') return WEATHER_EFFECT.SNOW;
  return WEATHER_EFFECT.SUN;
}

/** 「自动」/「auto」/空串 → auto；同时接受钥匙与中文名。 */
export function normalizeEffectChoice(value) {
  const v = String(value ?? '').trim();
  if (!v || v === '自动' || v.toLowerCase() === 'auto') return 'auto';
  for (const [key, label] of Object.entries(WEATHER_EFFECT_LABEL)) {
    if (v === key || v === label) return key;
  }
  return 'auto';
}

/** 选择（自动或具体效果）+ 当前天气 → 真正要播的效果钥匙。 */
export function resolveEffectChoice(choice, conditions = {}) {
  const normalized = normalizeEffectChoice(choice);
  return normalized !== 'auto' ? normalized : resolveAutoEffect(conditions);
}

/** 效果钥匙 → 给人看的名字。 */
export function effectLabel(effect) {
  return WEATHER_EFFECT_LABEL[effect] || String(effect || '');
}
