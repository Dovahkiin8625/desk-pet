/**
 * 天气：open-meteo（免密钥）。
 *
 * 两个接口：
 * - 地理编码：`geocoding-api.open-meteo.com/v1/search?name=<城市>`
 * - 当前天气：`api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=...`
 *
 * 天气**默认关闭**（见 state.js）：它要联网，
 * 不该在用户没要求的时候就开始。
 *
 * fetch 是注入的：单测用假实现，E2E 用本地桩服务，
 * 都不该打真实的外部接口。
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * WMO 天气代码 → 中文描述。
 *
 * 覆盖 open-meteo 会返回的常用代码；没列出的显示「未知」。
 */
export const WMO_TEXT = Object.freeze({
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '小雨',
  55: '中雨',
  56: '冻毛毛雨',
  57: '冻雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷暴伴冰雹',
});

/** 天气代码 → 中文。 */
export function weatherText(code) {
  return WMO_TEXT[code] || '未知';
}

/** 把城市名换成经纬度。 */
export async function geocode(city, fetchImpl = fetch) {
  const name = String(city || '').trim();
  if (!name) return null;
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`地理编码失败：HTTP ${res.status}`);
  const data = await res.json();
  const hit = Array.isArray(data?.results) ? data.results[0] : null;
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return null;
  return {
    name: hit.name || name,
    admin: hit.admin1 || '',
    country: hit.country || '',
    latitude: hit.latitude,
    longitude: hit.longitude,
  };
}

/** 取某个经纬度的当前天气。 */
export async function fetchWeather(latitude, longitude, fetchImpl = fetch) {
  const url =
    `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
    '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto';
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`天气查询失败：HTTP ${res.status}`);
  const data = await res.json();
  const current = data?.current;
  if (!current || !Number.isFinite(current.temperature_2m)) {
    throw new Error('天气数据不完整');
  }
  return {
    temperature: Math.round(current.temperature_2m),
    humidity: Number.isFinite(current.relative_humidity_2m) ? Math.round(current.relative_humidity_2m) : null,
    wind: Number.isFinite(current.wind_speed_10m) ? Math.round(current.wind_speed_10m) : null,
    code: current.weather_code,
    text: weatherText(current.weather_code),
  };
}

/**
 * 播报文本：「北京 晴 26°C」。
 *
 * 城市名用用户填的那个（而不是 API 返回的规范名）：
 * 用户填「北京」，回他「北京市朝阳区」是答非所问。
 */
export function weatherLine(city, weather) {
  if (!weather) return '天气暂时查不到';
  const parts = [city || '这里'];
  // **每一项都要看有没有**：磁盘上的旧数据可能缺字段，
  // 拼出来是「北京　undefined　undefined°C」——那种话不能给用户看。
  if (weather.text) parts.push(weather.text);
  if (Number.isFinite(weather.temperature)) parts.push(`${weather.temperature}°C`);
  if (Number.isFinite(weather.humidity)) parts.push(`湿度 ${weather.humidity}%`);
  return parts.join('　');
}
