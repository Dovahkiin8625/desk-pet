/**
 * 桌宠天气特效：盖在模型画布上面的一层透明画布，只画粒子。
 *
 * 主进程偶尔推过来（或用户在天气插件里点了「预览效果」），
 * 一波约 10 秒后自动收尾。画布 pointer-events: none，
 * 不挡桌宠的命中区与拖拽。
 */

import { EFFECT_DURATION_MS, WEATHER_EFFECT } from '../../shared/weatherEffect.js';

const TAU = Math.PI * 2;
const DPR = () => window.devicePixelRatio || 1;

let canvas = null;
let ctx = null;
let raf = null;
let stopTimer = null;
let particles = [];
let current = null; // { name, startedAt }
let playCount = 0;
let time = 0; // 特效内的时间（秒）
let lastFrame = 0;
let windDirection = 1;

const LEAF_COLORS = ['#d9880f', '#c95c12', '#e0a32e', '#a94f1e', '#8a5a18'];

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'pet-weather-effect';
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: 5,
  });
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  window.addEventListener('resize', syncSize);
  syncSize();
}

function syncSize() {
  if (!canvas) return;
  const dpr = DPR();
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// —— 各效果的粒子 ——————————————————————————————

function spawnRain(spread) {
  const w = window.innerWidth;
  return {
    kind: 'drop',
    x: rand(-40, w + 40),
    y: spread ? rand(-window.innerHeight, window.innerHeight) : rand(-120, -20),
    len: rand(14, 30),
    speed: rand(620, 880),
    slant: rand(60, 110),
    width: rand(1, 2),
    alpha: rand(0.35, 0.65),
  };
}

function spawnSnow(spread) {
  const w = window.innerWidth;
  return {
    kind: 'flake',
    x: rand(0, w),
    y: spread ? rand(-window.innerHeight, window.innerHeight) : rand(-40, -5),
    r: rand(1.5, 3.5),
    speed: rand(40, 90),
    swayAmp: rand(15, 40),
    swaySpeed: rand(0.6, 1.4),
    phase: rand(0, TAU),
    alpha: rand(0.6, 0.95),
  };
}

function spawnLeaf(spread) {
  const w = window.innerWidth;
  return {
    kind: 'leaf',
    x: rand(0, w),
    y: spread ? rand(-window.innerHeight, window.innerHeight) : rand(-60, -10),
    rx: rand(8, 14),
    ry: rand(5, 8),
    rot: rand(0, TAU),
    vr: rand(-1.5, 1.5),
    vy: rand(55, 105),
    swayAmp: rand(30, 60),
    swaySpeed: rand(0.8, 1.6),
    phase: rand(0, TAU),
    color: pick(LEAF_COLORS),
  };
}

function spawnStreak(spread) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // 从迎风的那一侧进场。
  const offLeft = windDirection > 0;
  return {
    kind: 'streak',
    x: spread ? rand(0, w) : (offLeft ? rand(-300, -40) : rand(w + 40, w + 300)),
    y: rand(h * 0.15, h * 0.85),
    len: rand(60, 140),
    speed: rand(500, 900),
    amp: rand(6, 18),
    freq: rand(2, 4),
    phase: rand(0, TAU),
    alpha: rand(0.18, 0.4),
  };
}

function spawnMote(spread, rising = false) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    kind: 'mote',
    x: rand(0, w),
    y: spread ? rand(0, h) : (rising ? h + rand(2, 40) : rand(0, h)),
    vx: rising ? rand(-10, 10) : windDirection * rand(140, 320),
    vy: rising ? rand(-20, -8) : rand(-20, 20),
    r: rand(1, 2.5),
    phase: rand(0, TAU),
    alpha: rand(0.3, 0.6),
    rising,
  };
}

function spawn(effect) {
  switch (effect) {
    case WEATHER_EFFECT.RAIN:
      return Array.from({ length: 90 }, () => spawnRain(true));
    case WEATHER_EFFECT.SNOW:
      return Array.from({ length: 80 }, () => spawnSnow(true));
    case WEATHER_EFFECT.LEAVES:
      return Array.from({ length: 26 }, () => spawnLeaf(true));
    case WEATHER_EFFECT.WIND:
      return [
        ...Array.from({ length: 22 }, () => spawnStreak(true)),
        ...Array.from({ length: 14 }, () => spawnMote(true)),
      ];
    case WEATHER_EFFECT.SUN:
      return Array.from({ length: 16 }, () => spawnMote(true, true));
    default:
      return [];
  }
}

// —— 更新与绘制 —————————————————————————————————

function update(p, dt, w, h) {
  switch (p.kind) {
    case 'drop':
      p.y += p.speed * dt;
      p.x += p.slant * dt;
      if (p.y > h + p.len) Object.assign(p, spawnRain(false));
      break;
    case 'flake':
      p.y += p.speed * dt;
      p.x += Math.sin(time * p.swaySpeed + p.phase) * p.swayAmp * dt;
      if (p.y > h + p.r * 2) Object.assign(p, spawnSnow(false));
      break;
    case 'leaf':
      p.y += p.vy * dt;
      p.x += Math.sin(time * p.swaySpeed + p.phase) * p.swayAmp * dt;
      p.rot += p.vr * dt;
      if (p.y > h + 30) Object.assign(p, spawnLeaf(false));
      break;
    case 'streak': {
      p.x += windDirection * p.speed * dt;
      if ((windDirection > 0 && p.x > w + 320) || (windDirection < 0 && p.x < -320)) {
        Object.assign(p, spawnStreak(false));
      }
      break;
    }
    case 'mote':
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.rising) {
        if (p.y < -10) Object.assign(p, spawnMote(false, true));
      } else if ((windDirection > 0 && p.x > w + 10) || (windDirection < 0 && p.x < -10) || p.y < -10 || p.y > h + 10) {
        Object.assign(p, spawnMote(false));
      }
      break;
  }
}

function draw(p) {
  switch (p.kind) {
    case 'drop': {
      const kx = (p.slant * p.len) / p.speed;
      ctx.strokeStyle = `rgba(170, 195, 225, ${p.alpha})`;
      ctx.lineWidth = p.width;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - kx, p.y - p.len);
      ctx.stroke();
      break;
    }
    case 'flake':
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
      break;
    case 'leaf': {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.rx, p.ry, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60, 30, 5, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-p.rx * 0.8, 0);
      ctx.lineTo(p.rx * 0.8, 0);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'streak': {
      const midX = p.x - windDirection * (p.len / 2);
      const lift = Math.sin(time * p.freq + p.phase) * p.amp;
      ctx.strokeStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(midX, p.y + lift, p.x - windDirection * p.len, p.y);
      ctx.stroke();
      break;
    }
    case 'mote': {
      const twinkle = p.rising ? 0.55 + 0.45 * Math.sin(time * 2 + p.phase) : 1;
      ctx.fillStyle = p.rising
        ? `rgba(255, 236, 170, ${p.alpha * twinkle})`
        : `rgba(255, 255, 255, ${p.alpha * twinkle})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
      break;
    }
  }
}

/** 各效果的一缕底色：压一点氛围，但不盖住桌宠。 */
function drawBackdrop(effect, w, h) {
  switch (effect) {
    case WEATHER_EFFECT.RAIN:
      ctx.fillStyle = 'rgba(28, 38, 58, 0.10)';
      ctx.fillRect(0, 0, w, h);
      break;
    case WEATHER_EFFECT.SNOW:
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(0, 0, w, h);
      break;
    case WEATHER_EFFECT.LEAVES:
      ctx.fillStyle = 'rgba(120, 70, 20, 0.05)';
      ctx.fillRect(0, 0, w, h);
      break;
    case WEATHER_EFFECT.SUN: {
      const gx = w * 0.8;
      const gy = h * 0.16;
      const radius = Math.max(w, h) * 0.55;
      const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius);
      glow.addColorStop(0, 'rgba(255, 224, 140, 0.30)');
      glow.addColorStop(1, 'rgba(255, 224, 140, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      // 缓慢旋转的光束。
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(time * 0.05);
      ctx.fillStyle = 'rgba(255, 228, 160, 0.07)';
      const L = Math.max(w, h) * 1.3;
      for (let i = 0; i < 10; i += 1) {
        ctx.rotate(TAU / 10);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(L, -L * 0.06);
        ctx.lineTo(L, L * 0.06);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
  }
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  if (!lastFrame) lastFrame = now;
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  time += dt;
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  if (current) drawBackdrop(current.name, w, h);
  for (const p of particles) update(p, dt, w, h);
  for (const p of particles) draw(p);
}

function reportDiagnostics(active) {
  if (!window.__pet) return;
  window.__pet.weatherEffect = {
    active,
    name: current?.name || null,
    startedAt: current?.startedAt || 0,
    plays: playCount,
  };
}

/** 播一阵特效；同时只播一阵，新的会顶掉旧的。 */
export function playWeatherEffect(name, durationMs = EFFECT_DURATION_MS) {
  const effect = String(name || '');
  if (!Object.values(WEATHER_EFFECT).includes(effect)) return null;
  ensureCanvas();
  stopWeatherEffect();
  current = { name: effect, startedAt: Date.now() };
  playCount += 1;
  time = 0;
  lastFrame = 0;
  windDirection = Math.random() < 0.5 ? -1 : 1;
  particles = spawn(effect);
  syncSize();
  raf = requestAnimationFrame(frame);
  stopTimer = setTimeout(() => stopWeatherEffect(), durationMs);
  reportDiagnostics(true);
  return window.__pet?.weatherEffect || null;
}

/** 收掉当前的特效（新的特效要播、或一波结束时调）。 */
export function stopWeatherEffect() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  particles = [];
  current = null;
  if (ctx && canvas) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  reportDiagnostics(false);
}
