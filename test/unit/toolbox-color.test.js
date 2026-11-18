import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatHsl,
  formatRgb,
  hexToRgb,
  hslToRgb,
  hsvToRgb,
  isLightColor,
  parseColor,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
} from '../../plugins/toolbox/lib/color.js';

/**
 * 颜色换算的纯逻辑。拾色器的状态是 HSV，
 * 展示给用户的是 HEX / RGB / HSL——三套换算必须来回对得上。
 */

test('hexToRgb：3 位与 6 位都认，坏的返回 null', () => {
  assert.deepEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hexToRgb('#4F8CFF'), { r: 79, g: 140, b: 255 });
  assert.equal(hexToRgb('#ffff'), null);
  assert.equal(hexToRgb('red'), null);
  assert.equal(hexToRgb(''), null);
});

test('rgbToHex：小写、补齐两位', () => {
  assert.equal(rgbToHex({ r: 79, g: 140, b: 255 }), '#4f8cff');
  assert.equal(rgbToHex({ r: 0, g: 0, b: 0 }), '#000000');
});

test('RGB ↔ HSL 往返', () => {
  for (const rgb of [
    { r: 79, g: 140, b: 255 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
    { r: 18, g: 200, b: 130 },
  ]) {
    const back = hslToRgb(rgbToHsl(rgb));
    assert.ok(Math.abs(back.r - rgb.r) <= 1, `r: ${back.r} vs ${rgb.r}`);
    assert.ok(Math.abs(back.g - rgb.g) <= 1, `g: ${back.g} vs ${rgb.g}`);
    assert.ok(Math.abs(back.b - rgb.b) <= 1, `b: ${back.b} vs ${rgb.b}`);
  }
});

test('RGB ↔ HSV 往返', () => {
  for (const rgb of [
    { r: 79, g: 140, b: 255 },
    { r: 255, g: 255, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
    { r: 128, g: 128, b: 128 },
  ]) {
    const back = hsvToRgb(rgbToHsv(rgb));
    assert.ok(Math.abs(back.r - rgb.r) <= 1);
    assert.ok(Math.abs(back.g - rgb.g) <= 1);
    assert.ok(Math.abs(back.b - rgb.b) <= 1);
  }
});

test('灰色：HSV 的饱和度是 0，HSL 同理', () => {
  const hsv = rgbToHsv({ r: 128, g: 128, b: 128 });
  assert.equal(hsv.h, 0);
  assert.equal(hsv.s, 0);
  assert.ok(Math.abs(hsv.v - 50.2) < 0.5, `v=${hsv.v}`);
  const grey = rgbToHsl({ r: 128, g: 128, b: 128 });
  assert.equal(grey.h, 0);
  assert.equal(grey.s, 0);
  assert.ok(Math.abs(grey.l - 50.2) < 0.5, `l=${grey.l}`);
});

test('parseColor：hex / rgb() / hsl() 都认', () => {
  assert.deepEqual(parseColor('#4f8cff'), { r: 79, g: 140, b: 255 });
  assert.deepEqual(parseColor('rgb(79, 140, 255)'), { r: 79, g: 140, b: 255 });
  assert.deepEqual(parseColor('rgba(79, 140, 255, 0.5)'), { r: 79, g: 140, b: 255 });
  assert.deepEqual(parseColor('hsl(219, 100%, 66%)'), hslToRgb({ h: 219, s: 100, l: 66 }));
  assert.equal(parseColor('rgb(999, 0, 0)'), null);
  assert.equal(parseColor('hsl(0, 150%, 50%)'), null);
  assert.equal(parseColor('nope'), null);
});

test('展示格式：rgb() 与 hsl() 带逗号', () => {
  assert.equal(formatRgb({ r: 79, g: 140, b: 255 }), 'rgb(79, 140, 255)');
  assert.equal(formatHsl({ h: 219, s: 100, l: 66 }), 'hsl(219, 100%, 66%)');
});

test('isLightColor：白算亮、黑算暗', () => {
  assert.equal(isLightColor({ r: 255, g: 255, b: 255 }), true);
  assert.equal(isLightColor({ r: 0, g: 0, b: 0 }), false);
});
