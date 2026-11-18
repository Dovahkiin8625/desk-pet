// plugins/toolbox/lib/color.js
/**
 * 颜色换算的纯函数。页面直接 import，单测也直接 import。
 *
 * 拾色器的状态是 HSV（h 0–360，s/v 0–100）；
 * 对外展示 HEX / RGB / HSL。灰度（s=0）没有色相，换算时给 0。
 */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function round(n) {
  return Math.round(n);
}

/** #rgb / #rrggbb → { r, g, b }，认不出返回 null。 */
export function hexToRgb(text) {
  const match = String(text ?? '')
    .trim()
    .toLowerCase()
    .match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** { r, g, b } → 小写 #rrggbb。 */
export function rgbToHex({ r, g, b }) {
  const to = (n) => clamp(round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** { r, g, b } → { h, s, l }（h 0–360，s/l 0–100）。 */
export function rgbToHsl({ r, g, b }) {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  switch (max) {
    case rn:
      h = 60 * (((gn - bn) / delta) % 6);
      break;
    case gn:
      h = 60 * ((bn - rn) / delta + 2);
      break;
    default:
      h = 60 * ((rn - gn) / delta + 4);
  }
  return { h: (h + 360) % 360, s: s * 100, l: l * 100 };
}

/** { h, s, l } → { r, g, b }。 */
export function hslToRgb({ h, s, l }) {
  const hn = (((Number(h) || 0) % 360) + 360) % 360;
  const sn = clamp(Number(s) || 0, 0, 100) / 100;
  const ln = clamp(Number(l) || 0, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hn < 60) [rn, gn, bn] = [c, x, 0];
  else if (hn < 120) [rn, gn, bn] = [x, c, 0];
  else if (hn < 180) [rn, gn, bn] = [0, c, x];
  else if (hn < 240) [rn, gn, bn] = [0, x, c];
  else if (hn < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return { r: round((rn + m) * 255), g: round((gn + m) * 255), b: round((bn + m) * 255) };
}

/** { r, g, b } → { h, s, v }（h 0–360，s/v 0–100）。 */
export function rgbToHsv({ r, g, b }) {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const v = max * 100;
  const s = max === 0 ? 0 : (delta / max) * 100;
  let h = 0;
  if (delta !== 0) {
    switch (max) {
      case rn:
        h = 60 * (((gn - bn) / delta) % 6);
        break;
      case gn:
        h = 60 * ((bn - rn) / delta + 2);
        break;
      default:
        h = 60 * ((rn - gn) / delta + 4);
    }
    h = (h + 360) % 360;
  }
  return { h, s, v };
}

/** { h, s, v } → { r, g, b }。 */
export function hsvToRgb({ h, s, v }) {
  const hn = (((Number(h) || 0) % 360) + 360) % 360;
  const sn = clamp(Number(s) || 0, 0, 100) / 100;
  const vn = clamp(Number(v) || 0, 0, 100) / 100;
  const c = vn * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = vn - c;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hn < 60) [rn, gn, bn] = [c, x, 0];
  else if (hn < 120) [rn, gn, bn] = [x, c, 0];
  else if (hn < 180) [rn, gn, bn] = [0, c, x];
  else if (hn < 240) [rn, gn, bn] = [0, x, c];
  else if (hn < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return { r: round((rn + m) * 255), g: round((gn + m) * 255), b: round((bn + m) * 255) };
}

/**
 * 认任意写法的颜色：#hex、rgb(r, g, b) / rgba(…)、hsl(h, s%, l%) / hsla(…)。
 * 认不出返回 null。
 */
export function parseColor(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  const hex = hexToRgb(raw);
  if (hex) return hex;
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if ([r, g, b].every((n) => n <= 255)) return { r, g, b };
    return null;
  }
  const hsl = raw.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
  if (hsl) {
    const h = Number(hsl[1]);
    const s = Number(hsl[2]);
    const l = Number(hsl[3]);
    if (s > 100 || l > 100) return null;
    return hslToRgb({ h, s, l });
  }
  return null;
}

/** 给定背景色，文字该用黑还是白（按感知亮度，够用就行）。 */
export function isLightColor({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

/** 对外显示的三种格式。 */
export function formatRgb({ r, g, b }) {
  return `rgb(${round(r)}, ${round(g)}, ${round(b)})`;
}

export function formatHsl({ h, s, l }) {
  return `hsl(${round(h)}, ${round(s)}%, ${round(l)}%)`;
}
