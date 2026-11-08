/**
 * 聊天记录页面上的**纯逻辑**：把一条记录变成一行字。
 *
 * ## 为什么单独一个文件
 *
 * 页面脚本（history.js）一上来就绑界面（`bindSurface()`），
 * 在普通 node 里跑不起来（没有 `window`、没有 DOM）。
 * 而「一行字长什么样」是能测的——所以它搬到这里：
 * 不碰 DOM，规矩直接被测。
 */

/** 一行最多留多少字（参数预览太长就没法看了）。 */
const MAX_PREVIEW = 60;

/**
 * 步骤的一行字。
 *
 * 规格 §10.4 画的是「`fs.list  src/`」——**工具名 + 它拿到的东西**。
 * 只画工具名的话，用户看到的是一串名字，看不出这个步骤到底做了什么。
 */
export function stepLabel(step) {
  const name = String(step?.text || step?.meta?.tool || '步骤');
  const preview = argsPreview(step?.meta?.args);
  return preview ? `${name}  ${preview}` : name;
}

/**
 * 参数的一行预览。
 *
 * 只看前两个参数、每个最多 60 字：一眼能看出「它动的是哪个文件」，
 * 又不会被一整屏的 JSON 淹掉。
 */
export function argsPreview(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) continue;
    parts.push(`${key}: ${text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text}`);
    if (parts.length >= 2) break;
  }
  return parts.join('  ');
}
