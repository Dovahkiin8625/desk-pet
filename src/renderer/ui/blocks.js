/**
 * 插件页面里「块」的画法。
 *
 * 面板（左键点桌宠弹出来的那个）与插件的独立窗口共用这一份：
 * 同一个插件在两个地方必须长一个样——抄一份迟早会漂移，
 * 而漂移出来的样子用户一眼就能看出不对。
 *
 * 这里**没有任何业务逻辑**：块的样子由主进程给的页面描述决定，
 * 这边只负责照着画；用户动了什么，通过 `onAction` 交回去。
 */

/** 时间戳说成人话（几点几分）。 */
export function formatTime(at) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

/**
 * 画一个块。
 *
 * @param {object} block 块描述（kind 决定画成什么样）
 * @param {object} [options]
 * @param {Function} [options.onAction] 用户动了：回调 (actionId, value)
 * @returns {HTMLElement|null} 画不出来的块返回 null
 */
export function renderBlock(block, { onAction } = {}) {
  switch (block?.kind) {
    case 'text': {
      const div = document.createElement('div');
      div.className = 'block-text';
      div.textContent = block.text || '';
      return div;
    }
    case 'empty': {
      const div = document.createElement('div');
      div.className = 'block-empty';
      div.textContent = block.text || '';
      return div;
    }
    case 'list': {
      const ul = document.createElement('ul');
      ul.className = 'block-list';
      for (const item of block.items || []) {
        const li = document.createElement('li');
        if (item.done) li.classList.add('done');
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = item.label || '';
        li.append(label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent = item.hint;
          li.append(hint);
        }
        if (item.removeId) {
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.type = 'button';
          remove.textContent = '✕';
          remove.title = '删除';
          remove.addEventListener('click', (e) => {
            e.stopPropagation();
            onAction?.(item.removeId, item.id);
          });
          li.append(remove);
        }
        li.addEventListener('click', () => {
          onAction?.(item.actionId || item.id, item.id);
        });
        ul.append(li);
      }
      return ul;
    }
    case 'input': {
      const row = document.createElement('div');
      row.className = 'block-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = block.placeholder || '';
      input.value = block.value || '';
      const submit = () => {
        onAction?.(block.id || '', input.value);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = block.submitLabel || '确定';
      btn.addEventListener('click', submit);
      row.append(input, btn);
      return row;
    }
    case 'buttons': {
      const row = document.createElement('div');
      row.className = 'block-buttons';
      for (const item of block.items || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label || '确定';
        if (item.primary) btn.classList.add('primary');
        btn.addEventListener('click', () => {
          onAction?.(item.id || '', '');
        });
        row.append(btn);
      }
      return row;
    }
    case 'messages': {
      const ul = document.createElement('ul');
      ul.className = 'block-messages';
      for (const item of block.items || []) {
        const li = document.createElement('li');
        li.className = item.role === 'user' ? 'user' : 'assistant';
        const role = document.createElement('span');
        role.className = 'role';
        role.textContent =
          item.role === 'user' ? '你' : item.proactive ? '桌宠（主动）' : '桌宠';
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = item.text || '';
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = formatTime(item.at);
        li.append(role, text, time);
        ul.append(li);
      }
      return ul;
    }
    case 'toggle': {
      const label = document.createElement('label');
      label.className = 'block-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(block.checked);
      input.addEventListener('change', () => {
        onAction?.(block.id || '', String(input.checked));
      });
      const text = document.createElement('span');
      text.textContent = block.label || '';
      label.append(input, text);
      return label;
    }
    default:
      return null;
  }
}

/**
 * 画一整个页面（标题 + 副标题 + 一串块）。
 *
 * @param {object} page 页面描述
 * @param {object} options
 * @param {HTMLElement} options.body 块的容器
 * @param {Function} [options.onAction]
 */
export function renderPage(page, { body, onAction } = {}) {
  if (!body) return;
  body.textContent = '';
  for (const block of page?.blocks || []) {
    const node = renderBlock(block, { onAction });
    if (node) body.append(node);
  }
}
