/**
 * WMO 天气代码 → 线性图标名（见 shared/icons.js）。
 *
 * 天气面板的头像要画图标，图标名在主进程算（与 WMO_TEXT 同一处），
 * 渲染层只负责照着画（blocks.js 不做业务判断）。
 */
export function weatherIconName(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return 'cloud';
  if (n === 0) return 'sun';
  if (n === 1 || n === 2) return 'cloud-sun';
  if (n === 3) return 'cloud';
  if (n === 45 || n === 48) return 'cloud-fog';
  if (n === 51 || n === 53 || n === 55 || n === 56 || n === 57) return 'cloud-drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(n)) return 'cloud-rain';
  if ([71, 73, 75, 77, 85, 86].includes(n)) return 'cloud-snow';
  if ([95, 96, 99].includes(n)) return 'cloud-lightning';
  return 'cloud';
}
