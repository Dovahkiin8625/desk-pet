// plugins/music-player/lib/format.js

/** 秒变成 mm:ss。 */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
