/**
 * 加载一个视频形象。
 *
 * 模型目录 = avatar.json + 被引用到的视频（透明 WebM VP9）。
 * 与 Live2D 走**同一块画布**（pixi 6）：视频是普通 Sprite，
 * 现有的适配、轮廓测量、穿透判定、拖拽摇摆对它原样成立。
 *
 * URL 的基址来自清单的 base（内置在项目目录里，导入的在 userData 里）。
 * 视频不直接用 app:// 当 <video> 的 src：Chromium 的媒体管线需要
 * Range 响应，而 app:// 的实现没有——先整个 fetch 下来做成 blob URL。
 * 单个视频一两 MB，无所谓。
 */
import { getMasterVolume, onMasterVolumeChange, isOtherAudioActive } from '../pet/audio.js';

// 切换视频的淡入淡出时长（毫秒）。
// 视频带 alpha 通道，做法是「新视频在旧视频上方淡入」而不是两个都半透明——
// 后者在切换瞬间会让桌宠整体变淡（背景透出来）。
const FADE_MS = 240;
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

export async function loadVideoModel(manifest) {
  const PIXI = window.PIXI;
  if (!PIXI?.Sprite || !PIXI?.Texture) throw new Error('PIXI 运行时没有加载');
  const base = manifest?.base || '/assets/models';
  const dir = `${base}/${manifest.id}`;
  const clips = Array.isArray(manifest?.clips) ? manifest.clips.filter((v) => v.file) : [];
  if (clips.length === 0) throw new Error('视频形象没有任何可用的视频');

  // 逐个把视频读成 blob URL，并建出 <video> 与对应 Texture。
  const loaded = [];
  try {
    for (const clip of clips) {
      // 清单是用户提供的文件：file 可能指向目录外的东西。
      // 这里只认模型目录内的相对路径，与主进程的 resolveInside 同规格。
      const rel = String(clip.file).replace(/\\/g, '/');
      if (/^([a-zA-Z]:)?\//.test(rel) || rel.split('/').includes('..')) {
        throw new Error(`视频路径越界：${clip.file}`);
      }
      const res = await fetch(`${dir}/${rel.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`视频加载失败：${clip.file}（HTTP ${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.muted = !clip.sound;
      video.volume = getMasterVolume();
      video.preload = 'auto';
      video.loop = false;
      video.playsInline = true;
      // 一次性动作不打断观感：播完切回待机（见 motion()）。
      video.src = url;
      // 等第一帧到手再往下走：loadedmetadata 只说明拿到了尺寸，
      // 屏幕上画出什么来要等到第一帧解码完（loadeddata）。
      await new Promise((resolveMeta, rejectMeta) => {
        const ok = () => {
          video.removeEventListener('error', fail);
          resolveMeta();
        };
        const fail = () => {
          video.removeEventListener('loadeddata', ok);
          rejectMeta(new Error(`视频无法读取：${clip.file}`));
        };
        video.addEventListener('loadeddata', ok, { once: true });
        video.addEventListener('error', fail, { once: true });
        if (video.readyState >= 2 && video.videoWidth > 0) ok();
      });
      loaded.push({ clip, video, url, texture: null });
    }
  } catch (err) {
    for (const item of loaded) {
      URL.revokeObjectURL(item.url);
    }
    throw err;
  }

  for (const item of loaded) {
    // VideoResource 默认 autoPlay：交给 PIXI 自己播的话，十条视频会同时解码，
    // 而休息态屏幕上只显示一个。这里关掉，播哪条由 motion() 决定。
    if (PIXI.VideoResource) {
      const resource = new PIXI.VideoResource(item.video, { autoPlay: false });
      item.texture = new PIXI.Texture(new PIXI.BaseTexture(resource));
    } else {
      item.texture = PIXI.Texture.from(item.video);
    }
  }

  // 待机池：semantic === 'idle' 的全部条目。
  // 池里有多条时：每条播一次，播完随机/按序换下一条（idleStrategy，默认 random）；
  // 只有一条时：照旧按 config 的 loop 循环。
  const idlePool = loaded.filter((i) => i.clip.semantic === 'idle');
  const inPoolMode = idlePool.length > 1;
  const rotation = manifest?.idleStrategy === 'sequence' ? 'sequence' : 'random';
  const isIdleClip = (item) => item.clip.semantic === 'idle';
  const pickNextIdle = (currentItem) => {
    if (idlePool.length <= 1) return idlePool[0];
    if (rotation === 'sequence') {
      const idx = idlePool.indexOf(currentItem);
      return idlePool[(idx + 1) % idlePool.length];
    }
    // 随机，但不重复同一条
    let next = currentItem;
    while (next === currentItem) {
      next = idlePool[Math.floor(Math.random() * idlePool.length)];
    }
    return next;
  };

  // 待机：优先池里随机挑一条，否则退回第一个 loop 的，再退回第一个。
  let idleItem;
  if (idlePool.length > 0) {
    idleItem = inPoolMode
      ? idlePool[Math.floor(Math.random() * idlePool.length)]
      : idlePool[0];
  } else {
    idleItem = loaded.find((i) => i.clip.loop) || loaded[0];
  }
  // 只让待机那条解码：其余条 paused 着，画面停在首帧。
  for (const item of loaded) {
    if (item !== idleItem) item.video.pause();
  }

  const sprite = new PIXI.Sprite(idleItem.texture);
  sprite.__kind = 'video';
  sprite.__videoItems = loaded;
  sprite.__currentClip = idleItem;
  sprite.__idleClip = idleItem;
  // 切换视频时的淡入淡出状态（见 fadeTo / finishFade）；null = 没有进行中的淡入
  sprite.__fade = null;
  // 原声响度跟随总音量：淡入淡出期间覆盖层与本体共用同一个 <video>，
  // 改这里就够了，不用分别对两个 Sprite 做处理。
  // __halved（切 clip 那一刻别的声音在响，原声减半）记在条目上：
  // 之后总音量变了也照着折半走，不会忽然跳回全响。
  sprite.__unsubscribeVolume = onMasterVolumeChange((v) => {
    for (const item of loaded) item.video.volume = v * (item.__halved ? 0.5 : 1);
  });

  const playItem = (item) => {
    const v = item.video;
    v.muted = !item.clip.sound;
    // 切 clip 的这一刻，如果别的声音正在响（音乐 / 桌宠在说话 / 提示音没收完），
    // 原声折半——不然两种声音叠在一起，谁也听不清。
    // 记到条目上：之后总音量变了、或这一段里又响起别的声音，都不再变动，
    // 这个决定只在「切 clip」这个时刻做。
    item.__halved = item.clip.sound === true && isOtherAudioActive();
    v.volume = getMasterVolume() * (item.__halved ? 0.5 : 1);
    // 池化模式：待机条目按一次性片段播放（播完换下一条），loop 失效。
    v.loop = item.clip.loop === true && !(inPoolMode && isIdleClip(item));
    try {
      v.currentTime = 0;
    } catch {
      /* 元数据还没就绪时设 currentTime 会抛——忽略，播就行了 */
    }
    v.play()?.catch?.(() => {});
  };

  // 待机视频先跑着——第一个上屏的画面就是它的第一帧。
  playItem(idleItem);

  /**
   * 收尾中的淡入淡出：立即让本体显示目标纹理，并移除覆盖层。
   * 换视频时如果上一次淡入还没结束，先走这条路——
   * 舞台上最多只挂一个覆盖层，快速连切也不会叠出一串残影。
   */
  const finishFade = () => {
    const fade = sprite.__fade;
    if (!fade) return;
    sprite.__fade = null;
    sprite.texture = fade.to.texture;
    if (fade.overlay.parent) fade.overlay.parent.removeChild(fade.overlay);
    // 覆盖层和本体共用同一张纹理：销毁覆盖层时不能连纹理一起销毁
    fade.overlay.destroy({ texture: false, baseTexture: false });
  };

  /**
   * 切到 item 的画面：淡入而不是硬切。
   * 本体（旧视频的定格帧）保持不透明，覆盖层（新视频）从 0 淡入到 1，
   * 结束后纹理归本体、覆盖层移除——视觉上新旧无缝交接。
   */
  const fadeTo = (item) => {
    finishFade();
    sprite.__currentClip = item;
    const parent = sprite.parent;
    // 还没上屏（加载阶段）：没有旧画面可淡，直接切
    if (!parent) {
      sprite.texture = item.texture;
      return;
    }
    const overlay = new PIXI.Sprite(item.texture);
    overlay.anchor.copyFrom(sprite.anchor);
    overlay.scale.copyFrom(sprite.scale);
    overlay.position.copyFrom(sprite.position);
    overlay.alpha = 0;
    parent.addChild(overlay);
    sprite.__fade = { overlay, to: item, start: performance.now() };
    const tick = () => {
      const fade = sprite.__fade;
      if (!fade || fade.overlay !== overlay) return; // 已被收尾或顶掉
      // 每帧对齐到本体：淡入过程中窗口可能被拖动/缩放
      overlay.anchor.copyFrom(sprite.anchor);
      overlay.scale.copyFrom(sprite.scale);
      overlay.position.copyFrom(sprite.position);
      const t = Math.min(1, (performance.now() - fade.start) / FADE_MS);
      overlay.alpha = easeOutQuad(t);
      if (t >= 1) {
        finishFade();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /** 切到下一条待机（池里随机/按序的下一条）。 */
  const playNextIdle = (fromItem) => {
    const next = pickNextIdle(fromItem || sprite.__idleClip);
    sprite.__currentClip?.video.pause();
    sprite.__idleClip = next;
    fadeTo(next);
    playItem(next);
  };

  const backToIdle = () => {
    if (inPoolMode) {
      playNextIdle(sprite.__currentClip);
      return;
    }
    const idle = sprite.__idleClip;
    if (sprite.__currentClip === idle) return;
    sprite.__currentClip.video.pause();
    fadeTo(idle);
    playItem(idle);
  };

  for (const item of loaded) {
    // 池化待机条目的 'ended' = 轮到下一条，不切回"待机"这一固定 clip。
    if (inPoolMode && isIdleClip(item)) {
      item.video.addEventListener('ended', () => {
        if (sprite.__currentClip === item) playNextIdle(item);
      });
      continue;
    }
    if (item.clip.loop) continue;
    // 一次性动作播完回待机：循环类视频永远不会触发 'ended'。
    item.video.addEventListener('ended', () => {
      // 这个监听挂在**所有**一次性视频上：只认当前上屏的是自己时才回切。
      if (sprite.__currentClip === item) backToIdle();
    });
  }

  /**
   * 语义 → 视频动作。group 就是 clips[].id；每个视频恒为 1 个动作。
   *
   * index 的存在与否区分两种调用：右键菜单点播 index=0（显式请求），
   * 空闲计时器只传 group（背景重播）。待机池轮换时，背景重播是 no-op——
   * 它不该在 laugh 或另一个待机播放到一半时把画面切走。
   *
   * loop 的视频 = 换一个「常驻待机」；一次性的 = 播完自动回待机。
   * 未知 group 返回 false：交互层据此知道「这个形象没有这个能力」。
   */
  sprite.motion = (group, index) => {
    const explicit = typeof index === 'number';
    const item = loaded.find((i) => i.clip.id === group);
    if (!item) return Promise.resolve(false);
    if (inPoolMode && isIdleClip(item) && !explicit) {
      const cur = sprite.__currentClip;
      if (cur && !cur.video.paused) return Promise.resolve(true);
    }
    if (item.clip.loop) {
      sprite.__idleClip = item;
    }
    if (sprite.__currentClip === item) {
      // 待机本来就在播：菜单/计时器再触发一次不重置它——
      // 每 20 秒被 idle 计时器重置第 0 帧，待机会一顿一顿的。
      const playing = !item.video.paused && item.video.currentTime > 0;
      if ((item.clip.loop || isIdleClip(item)) && playing) {
        return Promise.resolve(true);
      }
      playItem(item);
      return Promise.resolve(true);
    }
    sprite.__currentClip.video.pause();
    fadeTo(item);
    playItem(item);
    return Promise.resolve(true);
  };

  return sprite;
}

/** 释放视频形象占用的资源：暂停视频、撤销 blob URL、销毁纹理与 Sprite。 */
export function disposeVideoModel(model) {
  if (!model) return 0;
  let released = 0;
  // 淡入淡出进行到一半时来销毁：覆盖层是本体的**兄弟节点**，不在本体里面，
  // 默认的 destroy({ children: true }) 带不走它，必须先手动摘掉；
  // __fade 置 null 也会让未完的 rAF tick 直接退出。
  const fade = model.__fade;
  if (fade) {
    if (fade.overlay.parent) fade.overlay.parent.removeChild(fade.overlay);
    try {
      fade.overlay.destroy({ texture: false, baseTexture: false });
    } catch {
      /* ignore */
    }
    model.__fade = null;
  }
  model.__unsubscribeVolume?.();
  for (const item of model.__videoItems || []) {
    try {
      item.video.pause();
      item.video.removeAttribute('src');
      item.video.load?.();
    } catch {
      /* ignore */
    }
    try {
      item.texture?.destroy(true);
      released += 1;
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(item.url);
    } catch {
      /* ignore */
    }
  }
  try {
    if (model.parent) model.parent.removeChild(model);
    model.destroy({ children: true });
  } catch {
    /* ignore */
  }
  return released;
}
