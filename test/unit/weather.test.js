import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWeather,
  geocode,
  weatherLine,
  weatherText,
} from '../../src/main/assistant/weather.js';

/** 造一个只按 URL 前缀匹配的假 fetch。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [prefix, response] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        if (response.throw) throw new Error(response.throw);
        return {
          ok: response.status ? response.status < 400 : true,
          status: response.status || 200,
          json: async () => response.json,
        };
      }
    }
    throw new Error(`没有为 ${url} 准备响应`);
  };
  impl.calls = calls;
  return impl;
}

test('WMO 天气码映射成中文', () => {
  assert.equal(weatherText(0), '晴');
  assert.equal(weatherText(3), '阴');
  assert.equal(weatherText(45), '有雾');
  assert.equal(weatherText(61), '小雨');
  assert.equal(weatherText(63), '中雨');
  assert.equal(weatherText(65), '大雨');
  assert.equal(weatherText(71), '小雪');
  assert.equal(weatherText(95), '雷阵雨');
  // 没列出的代码：说「未知」，不要瞎猜
  assert.equal(weatherText(123), '未知');
});

test('地理编码：城市名 → 经纬度', async () => {
  const fetchImpl = fakeFetch({
    'https://geocoding-api.open-meteo.com': {
      json: {
        results: [
          { name: '北京', admin1: '北京市', country: '中国', latitude: 39.9, longitude: 116.4 },
        ],
      },
    },
  });
  const place = await geocode('北京', fetchImpl);
  assert.equal(place.name, '北京');
  assert.equal(place.latitude, 39.9);
  assert.equal(place.longitude, 116.4);
  // 城市名要 URL 编码
  assert.match(fetchImpl.calls[0], /name=%E5%8C%97%E4%BA%AC/);
});

test('地理编码：查不到时返回 null', async () => {
  const fetchImpl = fakeFetch({
    'https://geocoding-api.open-meteo.com': { json: { results: [] } },
  });
  assert.equal(await geocode('不存在的地方', fetchImpl), null);
  // 空城市名根本不该发请求
  const empty = fakeFetch({});
  assert.equal(await geocode('  ', empty), null);
  assert.equal(empty.calls.length, 0);
});

test('取当前天气', async () => {
  const fetchImpl = fakeFetch({
    'https://api.open-meteo.com': {
      json: {
        current: {
          temperature_2m: 26.4,
          relative_humidity_2m: 55,
          weather_code: 61,
          wind_speed_10m: 12,
        },
      },
    },
  });
  const w = await fetchWeather(39.9, 116.4, fetchImpl);
  assert.equal(w.temperature, 26);
  assert.equal(w.humidity, 55);
  assert.equal(w.code, 61);
  assert.equal(w.text, '小雨');
});

test('天气数据不完整时抛错', async () => {
  const fetchImpl = fakeFetch({
    'https://api.open-meteo.com': { json: { current: {} } },
  });
  await assert.rejects(() => fetchWeather(1, 2, fetchImpl), /天气数据不完整/);
});

test('天气播报文本用用户填的城市名', async () => {
  // 用户填「北京」，回他「北京市朝阳区」是答非所问。
  const w = { text: '晴', temperature: 26, humidity: 40, code: 0 };
  const line = weatherLine('北京', w);
  assert.match(line, /北京/);
  assert.match(line, /晴/);
  assert.match(line, /26°C/);
  assert.equal(weatherLine('北京', null), '天气暂时查不到');
});
