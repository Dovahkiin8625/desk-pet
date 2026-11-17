/**
 * 渲染层的「人设名」小工具。
 *
 * 页面里原先写死「桌宠 / 桌面宠物」的地方，运行时一律换成
 * **人设名**（默认「小桌」，用户在设置里改过之后就跟着改）。
 *
 * 机制：
 * - HTML 静态文案可以写出 `{name}` 占位符；
 * - `applyPersonaName(root)` 把 root 子树里所有文本节点与
 *   placeholder / title / aria-label / alt 属性里的
 *   `{name}`、「桌宠」、「桌面宠物」换成当前人设名；
 * - 换名时原文被**原样记住**（WeakMap），再换一次从原文重来——
 *   反复换几次也不会把名字套娃套坏；
 * - `initPersonaName()` 还装了一个 MutationObserver：
 *   之后任何脚本动态加上的文字里的上述词，也会被换掉，
 *   插件页面 / 设置页不用每个渲染点都手动过一遍。
 */
import { DEFAULT_PERSONA_NAME } from '../../shared/personaName.js';

/** 当前生效的人设名（渲染层各自一份）。 */
let current = DEFAULT_PERSONA_NAME;

/** 取当前人设名。 */
export function personaNameText() {
  return current;
}

function substitute(s) {
  return String(s)
    .replaceAll('{name}', current)
    .replaceAll('桌面宠物', current)
    .replaceAll('桌宠', current);
}

/** 界面文案里的「桌宠 / 桌面宠物」统一换成人设名（也认 {name}）。 */
export function personaText(text) {
  if (text == null) return '';
  return substitute(text);
}

/** 换名的**原文**：每次按当前名字从头替换，不把旧名字当原文。 */
const pristineText = new WeakMap(); // Text → 原文
const pristineAttrs = new WeakMap(); // Element → Map<属性名, 原值>
let pristineTitle; // document.title 的原文

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

/** observer 自己改 DOM 时别再触发自己。 */
let applying = false;

function substituteNode(node) {
  let pristine = pristineText.get(node);
  if (pristine === undefined) {
    pristine = node.nodeValue ?? '';
    pristineText.set(node, pristine);
  }
  const next = substitute(pristine);
  if (node.nodeValue !== next) node.nodeValue = next;
}

function walkText(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) substituteNode(node);
}

function substituteAttr(el, attr) {
  let map = pristineAttrs.get(el);
  if (!map) {
    map = new Map();
    pristineAttrs.set(el, map);
  }
  let pristine = map.get(attr);
  if (pristine === undefined) {
    pristine = el.getAttribute(attr) ?? '';
    map.set(attr, pristine);
  }
  const next = substitute(pristine);
  if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
}

function walkAttrs(root) {
  if (!root) return;
  const selector = ATTRS.map((a) => `[${a}]`).join(',');
  const els = root.nodeType === 1 && root.matches?.(selector) ? [root] : [];
  if (typeof root.querySelectorAll === 'function') {
    els.push(...root.querySelectorAll(selector));
  }
  for (const el of els) {
    for (const attr of ATTRS) {
      if (el.hasAttribute(attr)) substituteAttr(el, attr);
    }
  }
}

function substituteDocumentTitle() {
  if (typeof document === 'undefined' || typeof document.title !== 'string') return;
  if (pristineTitle === undefined) pristineTitle = document.title;
  const next = substitute(pristineTitle);
  if (document.title !== next) document.title = next;
}

/** 把 root 子树（默认整个 document）里的动态名字换成人设名。 */
export function applyPersonaName(root) {
  if (typeof document === 'undefined') return;
  applying = true;
  try {
    if (!root || root === document || root.nodeType === 9) {
      walkText(document.body ?? document.documentElement);
      walkAttrs(document.body ?? document.documentElement);
      substituteDocumentTitle();
      return;
    }
    walkText(root);
    walkAttrs(root);
  } finally {
    applying = false;
  }
}

/** 找到「能取人设名」的通道：按优先级试，认 personaName 这个能力。 */
function grabApi() {
  try {
    const parent = window.parent && window.parent !== window ? window.parent : null;
    const surface = window.panel?.surface || parent?.panel?.surface || null;
    const candidates = [
      window.pet,
      window.plugin,
      window.bubble,
      surface,
      parent?.plugin,
      parent?.bubble,
      window.panel,
      parent?.panel,
    ];
    for (const c of candidates) {
      if (c && typeof c.personaName === 'function') return c;
    }
    return null;
  } catch {
    // 跨域读 parent 会抛：当作没有通道，保持默认名字。
    return null;
  }
}

function sanitizeName(name) {
  const n = String(name ?? '').trim();
  return n || DEFAULT_PERSONA_NAME;
}

/**
 * 初始化：先按当前人设名过一遍静态文案，再订阅换名广播。
 *
 * @param {ParentNode} [root] 要替换的根（默认整个 document）
 */
export function initPersonaName(root) {
  const api = grabApi();
  // 先按默认名字过一遍静态文案，IPC 回来再覆盖：
  // 窗口是 ready-to-show 之后才亮的，闪不出来。
  applyPersonaName(root);
  // 动态加进 DOM 的文字也一并换掉。
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
    const observer = new MutationObserver((records) => {
      if (applying) return;
      applying = true;
      try {
        for (const record of records) {
          if (record.type === 'characterData') {
            substituteNode(record.target);
          } else if (record.type === 'childList') {
            for (const node of record.addedNodes) {
              if (node.nodeType === 3) substituteNode(node);
              else if (node.nodeType === 1) {
                walkText(node);
                walkAttrs(node);
              }
            }
          } else if (record.type === 'attributes' && record.attributeName) {
            substituteAttr(record.target, record.attributeName);
          }
        }
      } finally {
        applying = false;
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }
  // 当前人设名
  try {
    const pending = api?.personaName?.();
    if (pending && typeof pending.then === 'function') {
      void pending
        .then((name) => {
          current = sanitizeName(name);
          applyPersonaName(root);
        })
        .catch(() => {});
    }
  } catch {
    // 拿不到就保持默认名字。
  }
  // 换名广播
  try {
    api?.onPersonaName?.((name) => {
      current = sanitizeName(name);
      // 各 Text/属性的原文已记在 WeakMap 里：按新名字重新替换即可。
      applyPersonaName(document);
    });
  } catch {
    // 没这条通道就算了。
  }
  return current;
}
