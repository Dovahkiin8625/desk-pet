import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEATHER_EFFECT,
  WEATHER_EFFECT_OPTIONS,
  isRainCode,
  isSnowCode,
  seasonForMonth,
  resolveAutoEffect,
  normalizeEffectChoice,
  resolveEffectChoice,
  effectLabel,
} from '../../src/shared/weatherEffect.js';

test('季节：0-based 月份按 12/1/2 冬、3/4/5 春、6/7/8 夏、9/10/11 秋', () => {
  assert.equal(seasonForMonth(0), 'winter');
  assert.equal(seasonForMonth(1), 'winter');
  assert.equal(seasonForMonth(2), 'spring');
  assert.equal(seasonForMonth(4), 'spring');
  assert.equal(seasonForMonth(5), 'summer');
  assert.equal(seasonForMonth(7), 'summer');
  assert.equal(seasonForMonth(8), 'autumn');
  assert.equal(seasonForMonth(10), 'autumn');
  assert.equal(seasonForMonth(11), 'winter');
  // 越界/非法值退回春天，不抛错
  assert.equal(seasonForMonth(99), 'spring');
  assert.equal(seasonForMonth(NaN), 'spring');
});

test('雨雪代码：WMO 覆盖常见代码', () => {
  for (const code of [51, 55, 61, 65, 80, 95, 99, 66]) assert.equal(isRainCode(code), true, `rain ${code}`);
  for (const code of [0, 3, 45, 71]) assert.equal(isRainCode(code), false, `not rain ${code}`);
  for (const code of [71, 73, 75, 77, 85, 86]) assert.equal(isSnowCode(code), true, `snow ${code}`);
  for (const code of [61, 0, 95]) assert.equal(isSnowCode(code), false, `not snow ${code}`);
});

test('自动：天气代码优先于季节（秋天下雨还是下雨）', () => {
  const autumnRain = { code: 63, wind: 0, month: 9 };
  assert.equal(resolveAutoEffect(autumnRain), WEATHER_EFFECT.RAIN);
  const winterSnow = { code: 73, wind: 0, month: 0 };
  assert.equal(resolveAutoEffect(winterSnow), WEATHER_EFFECT.SNOW);
});

test('自动：风速够高就是刮风', () => {
  assert.equal(resolveAutoEffect({ code: 0, wind: 30, month: 5 }), WEATHER_EFFECT.WIND);
  assert.equal(resolveAutoEffect({ code: 0, wind: 24.9, month: 5 }), WEATHER_EFFECT.SUN);
  // 下雨时风再大也是下雨
  assert.equal(resolveAutoEffect({ code: 61, wind: 60, month: 5 }), WEATHER_EFFECT.RAIN);
});

test('自动：没有天气信号时按季节（秋落叶、冬下雪，否则晴天）', () => {
  assert.equal(resolveAutoEffect({ month: 9 }), WEATHER_EFFECT.LEAVES);
  assert.equal(resolveAutoEffect({ month: 0 }), WEATHER_EFFECT.SNOW);
  assert.equal(resolveAutoEffect({ code: 0, month: 4 }), WEATHER_EFFECT.SUN);
  assert.equal(resolveAutoEffect({}), WEATHER_EFFECT.SUN);
});

test('选择归一：钥匙、中文名、自动/auto/空串', () => {
  assert.equal(normalizeEffectChoice('下雨'), 'rain');
  assert.equal(normalizeEffectChoice('rain'), 'rain');
  assert.equal(normalizeEffectChoice('落叶'), 'leaves');
  assert.equal(normalizeEffectChoice('自动'), 'auto');
  assert.equal(normalizeEffectChoice('auto'), 'auto');
  assert.equal(normalizeEffectChoice('AUTO'), 'auto');
  assert.equal(normalizeEffectChoice(''), 'auto');
  assert.equal(normalizeEffectChoice(undefined), 'auto');
  assert.equal(normalizeEffectChoice('什么都不是'), 'auto');
});

test('resolveEffectChoice：具体效果直接用，自动才按条件抽', () => {
  const winter = { code: 0, month: 0 };
  assert.equal(resolveEffectChoice('晴天', winter), 'sun');
  assert.equal(resolveEffectChoice('下雪', { code: 61, month: 0 }), 'snow'); // 用户点名优先于天气
  assert.equal(resolveEffectChoice('自动', winter), 'snow'); // 自动按冬天抽
  assert.equal(resolveEffectChoice('自动', { code: 63, month: 9 }), 'rain');
});

test('WEATHER_EFFECT_OPTIONS 与 label 一一对应', () => {
  for (const option of WEATHER_EFFECT_OPTIONS) {
    if (option === '自动') continue;
    assert.ok(effectLabel(normalizeEffectChoice(option)) === option, `option ${option}`);
  }
  assert.equal(effectLabel('rain'), '下雨');
});
