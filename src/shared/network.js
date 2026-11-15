/**
 * 网络指标的显示格式。
 *
 * 主进程采数、渲染层画字，两边共用这一份格式。
 */

/**
 * 速率（字节每秒）写成一句人话。
 *
 * 采不到就是 null：这时候写「—」，不写 0 B/s。
 */
export function formatRate(bytesPerSecond) {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) return '—';
  const b = Math.max(0, bytesPerSecond);
  if (b < 1024) return `${Math.round(b)} B/s`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB/s`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB/s`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}

/**
 * 网络状况写成一行。
 *
 * @param {object|null} net { down, up, signal, wifi, connected, ip }
 */
export function formatNetwork(net) {
  if (!net) return '';
  const parts = [];
  if (typeof net.down === 'number' || typeof net.up === 'number') {
    parts.push(`↓ ${formatRate(net.down)} ↑ ${formatRate(net.up)}`);
  }
  if (typeof net.signal === 'number') parts.push(`Wi-Fi ${net.signal}%`);
  if (net.connected) parts.push(net.ip ? `已连接 ${net.ip}` : '已连接');
  else parts.push('未连接');
  return parts.join(' · ');
}

/**
 * 网络状况写成短短一句（放得进小部件的那种）。
 *
 * @param {object|null} net
 */
export function formatNetworkShort(net) {
  if (!net) return '';
  const parts = [];
  if (typeof net.down === 'number' || typeof net.up === 'number') {
    parts.push(`↓${formatRate(net.down)} ↑${formatRate(net.up)}`);
  }
  if (typeof net.signal === 'number') parts.push(`Wi-Fi ${net.signal}%`);
  return parts.join(' ');
}
