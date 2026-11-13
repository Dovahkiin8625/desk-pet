/**
 * 设置抽屉。
 *
 * 插件的设置项都收在这一块里：从右边滑出来的那一栏。
 * 面板、插件的独立窗口、插件自己的页面**共用这一份**——
 * 同一个插件在三个地方必须长一个样（抄一份迟早会漂移）。
 *
 * 样子在 theme.css 里（`.dp-drawer` / `.dp-scrim`），
 * 与剪贴板插件自己的抽屉一致。
 */

/**
 * 造一个抽屉。
 *
 * @param {object} [options]
 * @param {HTMLElement} [options.button] 打开抽屉的按钮（齿轮）
 * @param {HTMLElement} [options.container] 抽屉挂在哪儿（默认 `document.body`）
 * @param {number|Function} [options.top] 抽屉的上边距（像素）：让开宿主自己的标题栏
 * @param {string} [options.title] 抽屉头上那一行字
 * @returns {object} 抽屉本体
 */
export function createDrawer({ button = null, container = null, top = 0, title = '设置' } = {}) {
  const root = container || document.body;

  const scrim = document.createElement('div');
  scrim.className = 'dp-scrim';
  scrim.hidden = true;

  const aside = document.createElement('aside');
  aside.className = 'dp-drawer';
  aside.hidden = true;
  aside.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'dp-drawer-head';

  const heading = document.createElement('h2');
  heading.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dp-drawer-close';
  closeBtn.title = '关上';
  closeBtn.textContent = '✕';

  head.append(heading, closeBtn);

  const body = document.createElement('div');
  body.className = 'dp-drawer-body';

  aside.append(head, body);
  root.append(scrim, aside);

  /** 关抽屉的动画定时器（滑出去走完才真的藏起来）。 */
  let hideTimer = null;

  /**
   * 让开标题栏：抽屉不盖住宿主自己的按钮（面板的「关闭」在那一行里）。
   *
   * **每次打开时才量**：标题栏那会儿可能还藏着（量出来是 0）。
   */
  function applyTop() {
    const offset = typeof top === 'function' ? Number(top()) : Number(top);
    if (!Number.isFinite(offset) || offset <= 0) return;
    scrim.style.top = `${offset}px`;
    aside.style.top = `${offset}px`;
  }

  function open() {
    if (!aside.hidden) return;
    // 上一次关抽屉的动画还没走完：别让它把刚打开的抽屉又藏了。
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    applyTop();
    aside.hidden = false;
    scrim.hidden = false;
    // 下一帧再挂 .open：少了这一下就没有滑进来的动画。
    requestAnimationFrame(() => aside.classList.add('open'));
  }

  function close() {
    if (aside.hidden) return;
    aside.classList.remove('open');
    scrim.hidden = true;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!aside.classList.contains('open')) aside.hidden = true;
    }, 180);
  }

  function toggle() {
    if (aside.hidden) open();
    else close();
  }

  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', close);
  button?.addEventListener('click', toggle);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || aside.hidden) return;
    event.preventDefault();
    close();
  });

  return {
    /** 往抽屉里放东西的容器。 */
    body,
    open,
    close,
    toggle,
    /** 抽屉开着吗。 */
    isOpen: () => !aside.hidden,
    /**
     * 有没有东西可放。
     *
     * 没东西时齿轮整个藏起来：留一个点不动的按钮只会让人以为坏了。
     */
    setAvailable(available) {
      const on = Boolean(available);
      if (button) button.hidden = !on;
      if (!on) close();
    },
  };
}
