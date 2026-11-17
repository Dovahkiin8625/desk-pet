import { iconSvg } from './icons.js';
import { applyPersonaName } from './persona.js';

/**
 * 插件页面里「块」的画法。
 *
 * 面板（双击桌宠弹出来的那个）与插件的独立窗口共用这一份：
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
 * 天气主卡：图标 + 大字温度 + 条件 + 一行细节 chips。
 *
 * 数值缺多少认多少：block 里没有的字段不画（旧数据可能缺）。
 */
function renderWeatherBlock(block) {
  const card = document.createElement('div');
  card.className = 'block-weather';

  const main = document.createElement('div');
  main.className = 'weather-main';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'weather-icon';
  iconWrap.append(iconSvg(block.icon || 'cloud'));

  const temp = document.createElement('div');
  temp.className = 'weather-temp';
  temp.textContent = Number.isFinite(block.temperature) ? `${block.temperature}°` : '—';

  const meta = document.createElement('div');
  meta.className = 'weather-meta';
  const city = document.createElement('div');
  city.className = 'weather-city';
  city.textContent = block.city || '还没设置城市';
  const text = document.createElement('div');
  text.className = 'weather-text';
  text.textContent = block.text || '还没有天气数据';
  meta.append(city, text);

  main.append(iconWrap, temp, meta);
  card.append(main);

  // 细节 chips：有什么画什么。
  const chips = document.createElement('div');
  chips.className = 'weather-chips';
  const addChip = (icon, label) => {
    if (!label) return;
    const chip = document.createElement('span');
    chip.className = 'weather-chip';
    chip.append(iconSvg(icon), document.createTextNode(label));
    chips.append(chip);
  };
  if (Number.isFinite(block.humidity)) addChip('droplet', `湿度 ${block.humidity}%`);
  if (Number.isFinite(block.wind)) addChip('wind', `风 ${block.wind} km/h`);
  const at = formatTime(block.at);
  if (at) addChip('clock', `更新于 ${at}`);
  if (chips.childElementCount) card.append(chips);

  return card;
}

// —— 天气效果的小方框预览 ————————————————————————————
//
// 每个选项下面的小方框里画一波粒子，选的时候心里有数。
// 画布很小（120×64 逻辑像素），粒子也少——开六个动画也吃不了多少 CPU。
// 页面被重画（textContent 清空）时 canvas 会从文档里摘掉，
// 下一帧发现 isConnected === false 就自己停掉，不会泄漏 rAF。

const PREVIEW_W = 120;
const PREVIEW_H = 64;
const AUTO_CYCLE = ['sun', 'rain', 'snow', 'leaves', 'wind'];
const PREVIEW_LEAVES = ['#d9880f', '#c95c12', '#e0a32e', '#a94f1e', '#8a5a18'];

const previewRand = (min, max) => min + Math.random() * (max - min);

function spawnPreviewParticles(kind) {
  switch (kind) {
    case 'rain':
      return Array.from({ length: 22 }, () => ({
        kind: 'drop',
        x: previewRand(-10, PREVIEW_W + 10),
        y: previewRand(-PREVIEW_H, PREVIEW_H),
        len: previewRand(6, 12),
        speed: previewRand(120, 180),
        slant: previewRand(14, 26),
        alpha: previewRand(0.4, 0.75),
      }));
    case 'snow':
      return Array.from({ length: 20 }, () => ({
        kind: 'flake',
        x: previewRand(0, PREVIEW_W),
        y: previewRand(-PREVIEW_H, PREVIEW_H),
        r: previewRand(1, 2.2),
        speed: previewRand(12, 26),
        sway: previewRand(0.5, 1.5),
        phase: previewRand(0, Math.PI * 2),
        alpha: previewRand(0.65, 0.95),
      }));
    case 'leaves':
      return Array.from({ length: 10 }, () => ({
        kind: 'leaf',
        x: previewRand(0, PREVIEW_W),
        y: previewRand(-PREVIEW_H, PREVIEW_H),
        rx: previewRand(2.6, 4.2),
        ry: previewRand(1.5, 2.4),
        rot: previewRand(0, Math.PI * 2),
        vr: previewRand(-1.6, 1.6),
        vy: previewRand(16, 30),
        sway: previewRand(0.8, 1.6),
        phase: previewRand(0, Math.PI * 2),
        color: PREVIEW_LEAVES[Math.floor(Math.random() * PREVIEW_LEAVES.length)],
      }));
    case 'wind':
      return Array.from({ length: 7 }, () => ({
        kind: 'streak',
        x: previewRand(-PREVIEW_W, PREVIEW_W),
        y: previewRand(PREVIEW_H * 0.15, PREVIEW_H * 0.85),
        len: previewRand(14, 30),
        speed: previewRand(70, 120),
        amp: previewRand(2, 5),
        freq: previewRand(2, 3.4),
        phase: previewRand(0, Math.PI * 2),
        alpha: previewRand(0.25, 0.5),
      }));
    case 'sun':
      // 太阳效果没有下落物：几颗缓缓上升、忽明忽暗的光尘。
      return Array.from({ length: 12 }, () => ({
        kind: 'mote',
        x: previewRand(0, PREVIEW_W),
        y: previewRand(0, PREVIEW_H),
        vx: previewRand(-3, 3),
        vy: previewRand(-8, -4),
        r: previewRand(0.7, 1.6),
        phase: previewRand(0, Math.PI * 2),
        alpha: previewRand(0.35, 0.75),
      }));
    default:
      return [];
  }
}

function updatePreviewParticle(p, dt, t) {
  switch (p.kind) {
    case 'drop':
      p.y += p.speed * dt;
      p.x += p.slant * dt;
      if (p.y > PREVIEW_H + p.len) {
        p.y = previewRand(-30, -5);
        p.x = previewRand(-10, PREVIEW_W + 10);
      }
      break;
    case 'flake':
      p.y += p.speed * dt;
      p.x += Math.sin(t * p.sway + p.phase) * 6 * dt;
      if (p.y > PREVIEW_H + 2) {
        p.y = previewRand(-8, -2);
        p.x = previewRand(0, PREVIEW_W);
      }
      break;
    case 'leaf':
      p.y += p.vy * dt;
      p.x += Math.sin(t * p.sway + p.phase) * 9 * dt;
      p.rot += p.vr * dt;
      if (p.y > PREVIEW_H + 6) {
        p.y = previewRand(-12, -2);
        p.x = previewRand(0, PREVIEW_W);
      }
      break;
    case 'streak':
      p.x += p.speed * dt;
      if (p.x - p.len > PREVIEW_W + 8) {
        p.x = previewRand(-40, -8);
        p.y = previewRand(PREVIEW_H * 0.15, PREVIEW_H * 0.85);
      }
      break;
    case 'mote':
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y < -2) {
        p.y = PREVIEW_H + 2;
        p.x = previewRand(0, PREVIEW_W);
      }
      break;
  }
}

function drawPreviewParticle(ctx, p, t) {
  switch (p.kind) {
    case 'drop':
      ctx.strokeStyle = `rgba(150, 190, 235, ${p.alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - (p.slant * p.len) / p.speed, p.y - p.len);
      ctx.stroke();
      break;
    case 'flake':
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'leaf':
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.rx, p.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    case 'streak': {
      const lift = Math.sin(t * p.freq + p.phase) * p.amp;
      ctx.strokeStyle = `rgba(235, 242, 255, ${p.alpha})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(p.x - p.len / 2, p.y + lift, p.x - p.len, p.y);
      ctx.stroke();
      break;
    }
    case 'mote': {
      const twinkle = 0.55 + 0.45 * Math.sin(t * 2.4 + p.phase);
      ctx.fillStyle = `rgba(255, 232, 150, ${p.alpha * twinkle})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
}

function drawPreviewBackdrop(ctx, kind, t) {
  if (kind !== 'sun') return;
  // 一轮暖阳：径向光晕 + 缓慢旋转的光束。
  const gx = PREVIEW_W / 2;
  const gy = PREVIEW_H + 6;
  const glow = ctx.createRadialGradient(gx, gy, 2, gx, gy, PREVIEW_W * 0.62);
  glow.addColorStop(0, 'rgba(255, 222, 130, 0.55)');
  glow.addColorStop(1, 'rgba(255, 222, 130, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
  ctx.save();
  ctx.translate(gx, gy);
  ctx.rotate(t * 0.08);
  ctx.fillStyle = 'rgba(255, 226, 150, 0.16)';
  for (let i = 0; i < 8; i += 1) {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(PREVIEW_W, -5);
    ctx.lineTo(PREVIEW_W, 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * 在一个画布里循环演示一种效果。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} effect 'auto'（每隔几秒换一种演示）/ 'rain' / 'wind' / 'snow' / 'sun' / 'leaves'
 */
function startPreview(canvas, effect) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = PREVIEW_W * dpr;
  canvas.height = PREVIEW_H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 「自动」轮着演示五种：选的时候直接看到「它到底会播什么」。
  const cycle = effect === 'auto';
  let current = cycle ? AUTO_CYCLE[0] : effect;
  let particles = spawnPreviewParticles(current);
  let cycleAt = 0;
  let t = 0;
  let last = 0;

  function frame(now) {
    // 页面被重画（textContent 清空）时 canvas 会从文档里摘掉——停掉循环。
    if (!canvas.isConnected) return;
    requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    t += dt;

    if (cycle) {
      cycleAt += dt;
      if (cycleAt >= 3.2) {
        cycleAt = 0;
        const index = (AUTO_CYCLE.indexOf(current) + 1) % AUTO_CYCLE.length;
        current = AUTO_CYCLE[index];
        particles = spawnPreviewParticles(current);
      }
    }

    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    drawPreviewBackdrop(ctx, current, t);
    for (const p of particles) updatePreviewParticle(p, dt, t);
    for (const p of particles) drawPreviewParticle(ctx, p, t);
  }
  requestAnimationFrame(frame);
}

/** 桌宠天气效果：开关 + 一排带小方框预览的选项。 */
function renderEffectsBlock(block, { onAction } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'block-effects';

  // 开关行：标签 + 一句人话说明。
  const head = document.createElement('label');
  head.className = 'effects-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = Boolean(block.enabled);
  toggle.addEventListener('change', () => {
    onAction?.('settings:effectEnabled', String(toggle.checked));
  });
  const headText = document.createElement('span');
  headText.className = 'effects-toggle-text';
  const headTitle = document.createElement('span');
  headTitle.className = 'effects-toggle-title';
  headTitle.textContent = '桌宠天气效果';
  const headHint = document.createElement('span');
  headHint.className = 'effects-toggle-hint';
  headHint.textContent = block.hint || '开着时桌宠会随机偶尔播一阵雨 / 风 / 雪 / 晴 / 落叶';
  headText.append(headTitle, headHint);
  head.append(toggle, headText);
  wrap.append(head);

  // 效果选择：每项一个小方框，框里循环演示这个效果。
  const grid = document.createElement('div');
  grid.className = 'effects-grid';
  for (const option of block.options || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'effect-option';
    btn.dataset.effect = option.effect || '';
    btn.dataset.value = option.value || '';
    const selected = option.value === block.choice;
    if (selected) {
      btn.classList.add('selected');
      btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.setAttribute('aria-pressed', 'false');
    }

    const box = document.createElement('span');
    box.className = 'effect-box';
    const canvas = document.createElement('canvas');
    canvas.className = 'effect-preview';
    box.append(canvas);
    if (selected) {
      const badge = document.createElement('span');
      badge.className = 'effect-badge';
      badge.append(iconSvg('check'));
      box.append(badge);
    }

    const label = document.createElement('span');
    label.className = 'effect-label';
    label.textContent = option.label || option.value || '';

    btn.append(box, label);
    if (option.sub) {
      const sub = document.createElement('span');
      sub.className = 'effect-sub';
      sub.textContent = option.sub;
      btn.append(sub);
    }

    btn.addEventListener('click', () => {
      onAction?.('settings:effect', option.value || '');
    });
    grid.append(btn);
    startPreview(canvas, option.effect || 'auto');
  }
  wrap.append(grid);

  // 底部那颗满宽的「预览」：预览是这个区域最想让人点的动作。
  if (block.preview?.label) {
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'effects-preview';
    previewBtn.append(iconSvg('sparkles'), document.createTextNode(block.preview.label));
    previewBtn.addEventListener('click', () => {
      onAction?.(block.preview.actionId || 'preview', '');
    });
    wrap.append(previewBtn);
  }

  return wrap;
}

/** 倒计时圆环（番茄钟）。 */
function renderTimerBlock(block) {
  const card = document.createElement('div');
  card.className = 'block-timer';
  card.dataset.variant = block.variant || 'idle';

  const phaseRow = document.createElement('div');
  phaseRow.className = 'timer-phase';
  const dot = document.createElement('span');
  dot.className = 'timer-dot';
  const phaseText = document.createElement('span');
  phaseText.textContent = block.phase || '';
  phaseRow.append(dot, phaseText);

  const R = 52;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - (Number.isFinite(block.progress) ? block.progress : 0));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'timer-ring');
  svg.innerHTML =
    `<circle class="ring-track" cx="60" cy="60" r="${R}"></circle>` +
    `<circle class="ring-progress" cx="60" cy="60" r="${R}" ` +
    `stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>`;

  const time = document.createElement('div');
  time.className = 'timer-time';
  time.textContent = block.remainingText || '--:--';

  const face = document.createElement('div');
  face.className = 'timer-face';
  face.append(svg, time);

  card.append(phaseRow, face);
  if (block.sub) {
    const sub = document.createElement('div');
    sub.className = 'timer-sub';
    sub.textContent = block.sub;
    card.append(sub);
  }
  return card;
}

/** 一组数据卡（系统状态）。 */
function renderStatsBlock(block) {
  const grid = document.createElement('div');
  grid.className = 'block-stats';
  for (const item of block.items || []) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    if (item.hot) card.classList.add('hot');

    const head = document.createElement('div');
    head.className = 'stat-head';
    const tile = document.createElement('span');
    tile.className = 'stat-icon';
    tile.append(iconSvg(item.icon || 'activity'));
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = item.label || '';
    head.append(tile, label);

    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = item.text || '—';

    card.append(head, value);

    if (Number.isFinite(item.value)) {
      const bar = document.createElement('div');
      bar.className = 'stat-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(100, item.value))}%`;
      bar.append(fill);
      card.append(bar);
    }
    grid.append(card);
  }
  return grid;
}

/** 页面的主角：图标 + 大标题 + 一行小字。 */
function renderHeroBlock(block) {
  const hero = document.createElement('div');
  hero.className = 'block-hero';
  const tile = document.createElement('div');
  tile.className = 'hero-icon';
  tile.append(iconSvg(block.icon || 'sparkles'));
  const meta = document.createElement('div');
  meta.className = 'hero-meta';
  const title = document.createElement('div');
  title.className = 'hero-title';
  title.textContent = block.title || '';
  meta.append(title);
  if (block.subtitle) {
    const subtitle = document.createElement('div');
    subtitle.className = 'hero-subtitle';
    subtitle.textContent = block.subtitle;
    meta.append(subtitle);
  }
  hero.append(tile, meta);
  return hero;
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
    case 'weather':
      return renderWeatherBlock(block);
    case 'effects':
      return renderEffectsBlock(block, { onAction });
    case 'timer':
      return renderTimerBlock(block);
    case 'stats':
      return renderStatsBlock(block);
    case 'hero':
      return renderHeroBlock(block);
    case 'text': {
      const div = document.createElement('div');
      div.className = 'block-text';
      div.textContent = block.text || '';
      return div;
    }
    case 'empty': {
      const div = document.createElement('div');
      div.className = 'block-empty';
      if (block.icon) {
        // 带图标的空态：大一点的圆形图标在上，文案在下——空荡荡的不像「坏了」，像「还没开始」。
        const iconWrap = document.createElement('div');
        iconWrap.className = 'block-empty-icon';
        iconWrap.append(iconSvg(block.icon));
        div.append(iconWrap);
      }
      const text = document.createElement('div');
      text.className = 'block-empty-text';
      text.textContent = block.text || '';
      div.append(text);
      return div;
    }
    case 'list': {
      const ul = document.createElement('ul');
      ul.className = 'block-list';
      for (const item of block.items || []) {
        const li = document.createElement('li');
        if (item.done) li.classList.add('done');
        // 左侧的小图标块（待办/提醒/剪贴板都用它让列表「活」起来）。
        if (item.icon) {
          const tile = document.createElement('span');
          tile.className = 'item-icon';
          if (item.done) tile.classList.add('done');
          tile.append(iconSvg(item.icon));
          li.prepend(tile);
        } else if (item.done) {
          // 没有图标但已完成：给一个对勾块，别让 done 行看起来和普通行一样。
          const tile = document.createElement('span');
          tile.className = 'item-icon done';
          tile.append(iconSvg('check'));
          li.prepend(tile);
        }
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
          remove.append(iconSvg('close'));
          remove.title = '删除';
          remove.addEventListener('click', (e) => {
            e.stopPropagation();
            onAction?.(item.removeId, item.id);
          });
          li.append(remove);
        }
        // 列表行本身可激活：键盘用户要能选中它（鼠标用户点哪都行）。
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        const activate = () => {
          onAction?.(item.actionId || item.id, item.id);
        };
        li.addEventListener('click', activate);
        li.addEventListener('keydown', (e) => {
          if (e.target !== li) return; // 焦点在里面的「删除」按钮上时，别代激活整行
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
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
        // 图标是可选的：有就画在文字前面（图标名见 shared/icons.js）。
        if (item.icon) btn.append(iconSvg(item.icon));
        btn.append(document.createTextNode(item.label || '确定'));
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
    case 'settings': {
      const wrap = document.createElement('div');
      wrap.className = 'block-settings';
      for (const item of block.items || []) {
        const row = document.createElement('div');
        row.className = 'config-row';
        row.dataset.settingKey = item.key || '';

        const label = document.createElement('label');
        label.className = 'config-label';
        label.textContent = item.label || item.key || '';
        if (item.hint) label.title = item.hint;

        let input;
        if (item.type === 'boolean') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = item.value === true || item.value === 'true';
        } else if (item.type === 'number') {
          input = document.createElement('input');
          input.type = 'number';
          input.value = String(item.value ?? '');
        } else if (item.type === 'select') {
          input = document.createElement('select');
          for (const opt of item.options || []) {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            input.appendChild(option);
          }
          input.value = String(item.value ?? '');
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.value = String(item.value ?? '');
        }

        input.addEventListener('change', () => {
          onAction?.(`settings:${item.key || ''}`, input.type === 'checkbox' ? String(input.checked) : input.value);
        });

        row.append(label, input);
        wrap.append(row);
      }
      return wrap;
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
 * @param {HTMLElement} [options.drawer] 设置抽屉的容器（没有就画在正文末尾）
 * @param {Function} [options.onAction]
 */
export function renderPage(page, { body, drawer, onAction } = {}) {
  if (!body) return;
  body.textContent = '';
  for (const block of page?.blocks || []) {
    const node = renderBlock(block, { onAction });
    if (node) body.append(node);
  }
  // 设置项：画在右边的抽屉里。
  //
  // 没有抽屉可画（老界面）时退回正文末尾——设置不能因为没有抽屉就丢了。
  const target = drawer || body;
  if (target !== body) target.textContent = '';
  for (const block of page?.drawer || []) {
    const node = renderBlock(block, { onAction });
    if (node) target.append(node);
  }
  // 页面里凡是「桌宠 / 桌面宠物」的文字，换成人设名（默认「小桌」）。
  applyPersonaName(body);
  if (target !== body) applyPersonaName(target);
}
