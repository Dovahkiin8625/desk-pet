import { createStage } from './pet/stage.js';
import { loadManifest, resolveMotionSpec } from './pet/manifest.js';
import { loadPetModel, disposePetModel } from './pet/model.js';
import { disposeTexturesUnderPath } from './pet/texture.js';
import { attachInteraction } from './pet/interaction.js';
import { idleReaction } from './pet/behavior.js';
import {
  EVENT,
  applyEvent,
  boredomLevel,
  clampMood,
  createEmotionState,
  decayMood,
  eventRule,
  expressionNameFor,
  touch,
} from './pet/emotion.js';
import {
  playTap,
  playSpeech,
  playSuccess,
  playAlarm,
  playError,
  setAudioEnabled,
  setMasterVolume,
  getMasterVolume,
  getSpeechOutput,
} from './pet/audio.js';
import { attachLipSync } from './pet/lipSync.js';
import { SCALE_RANGE, SCALE_STEP } from '../shared/viewport.js';
import { DEFAULT_VOLUME } from '../shared/volume.js';

window.__pet = {
  ready: false,
  modelLoaded: false,
  modelId: null,
  expressions: [],
  hitAreas: [],
  naturalSize: null,
  // 最近一次切换释放掉的纹理数量。0 表示「一个都没释放」——
  // 那是显存泄漏的信号，必须能从诊断面读到。
  lastReleasedTextures: 0,
  switchError: null,
  // 最近一次启动/加载失败的错误文本。null 表示没有失败过。
  error: null,
  // 交互诊断面：最近一次点击命中的语义区域、触发的表情名与动作 spec，
  // 以及当前视线跟随的目标点。null 表示「还没有发生过」。
  lastZone: null,
  lastExpression: null,
  lastMotion: null,
  focusPoint: null,
  // 最近一次拖拽**送出的一段**增量（相对上一次移动事件）。
  // 注意它只是最后一段，不代表整段拖拽的总量——
  // 窗口与光标是否脱节，要看 e2e 里「窗口位移」与「光标位移」的比较。
  lastDragDelta: null,
  // 空闲计时器的间隔（毫秒）。暴露出来，测试不必真的等 20 秒。
  idleMs: null,
  // 当前生效的缩放与透明度。缩放由渲染层应用，透明度由主进程
  // setOpacity 施加——这里只是把「现在是多少」暴露出来供测试断言。
  scale: 1,
  opacity: 1,
  // 当前的心情值与语义情绪。诊断面：测试要能断言「被摸头之后心情变好了」。
  mood: 0,
  emotion: 'neutral',
  // 最近一次由**系统光标**轮询得到的窗口内坐标（与 focusPoint 分开：
  // focusPoint 是指针事件驱动的，既有断言依赖它的语义，不能被光标覆盖）。
  cursorPoint: null,
  // 语音诊断：收到几段语音、最近一段多少字节。
  speechCount: 0,
  lastSpeechBytes: 0,
  // 当前总音量（0..1）。诊断面：测试要能断言「音量真的传到了渲染层」。
  volume: DEFAULT_VOLUME,
  // 语音输出接到了哪个节点（'masterGain' / 'destination' / null）。
  // 「桌宠说话也受音量控制」只有这一个可断言的出口。
  speechOutput: null,
  // 最近一次的口型幅度（0..1）：证明 beforeModelUpdate 钩子真的在驱动参数，
  // 而不只是「播放了一个音频」。
  mouthAmplitude: 0,
};

let stage = null;
let currentModel = null;
let currentManifest = null;
let userScale = 1;
// 滚轮缩放的待落盘值与「已排队」标记。
//
// 每滚一格就发一次 IPC 会让连续滚动又卡又抖：
// 本地先改（手感立刻跟手），攒到下一帧再一次性落盘。
let pendingScale = null;
let scaleSaveQueued = false;

// 上一次拖拽事件里光标的**屏幕**坐标。见 onDragMove 的说明：
// 增量必须在屏幕坐标系里算，否则窗口追着光标跑会把增量吃掉一半。
let lastPointerScreen = null;
// 启动失败时画在画布上的占位提示（用户看得见的失败）。
let failurePlaceholder = null;

// 切换请求序号：并发切换时只有最后一次请求允许提交到舞台，
// 否则「谁先加载完谁上屏」，屏幕上可能不是用户最后选的那个。
let switchSeq = 0;

// 切换串行化：同一时刻只允许一次加载在进行。
//
// pixi 的纹理缓存以 URL 为键，两次**并发**加载同一形象会拿到同一批
// Texture 实例（Texture.from 命中缓存就直接返回那个对象）。
// 先完成的那次一旦销毁自己的模型，就会把另一次正在用的纹理一起销毁——
// 胜出的模型变成「没有绑定纹理的空壳」，而 switchModel 仍然报告成功。
// 串行化之后任何时刻只有一个模型在被加载，不存在共享纹理。
let switchChain = Promise.resolve();

// ---------------------------------------------------------------------------
// 情绪系统
//
// 心情值与语义情绪都住在渲染层：表情与动作都在这边表演，
// 主进程只负责把「发生了什么」转成事件发过来。
// ---------------------------------------------------------------------------

let emotionState = createEmotionState();

// 最近几次点击的时间戳：用来判断「被连续猛点」。
//
// 只保留窗口内的点击：时间戳太老的直接丢掉，
// 否则数组会随着使用一直增长。
const tapTimes = [];

// 连续猛点的判定：2 秒内 3 次。
const SPAM_WINDOW_MS = 2000;
const SPAM_THRESHOLD = 3;

// 上一次落到的「无聊程度」（null / idle-long / timeout）。
// 只在**等级变化**时才换表情：否则每 30 秒检查一次就会把
// 同一张「难过脸」反复重播一遍。
let boredomEvent = null;

// 上一次做心情衰减的时间点。
let lastDecayAt = Date.now();

// 拖拽摇摆的 ticker 回调（null 表示当前没有在摇摆）。
let dragWobble = null;

// 口型驱动的句柄（null 表示当前模型没有口型参数）。
let lipSync = null;

/**
 * 施加一个情绪事件：更新心情，必要时换上对应表情。
 *
 * 表情名一律走清单解析（expressionNameFor）：清单里没这个语义就返回 null，
 * 此时**不套表情**（spec §4.4 的降级规则），只保留动作与心情变化。
 */
function applyEmotion(event) {
  const rule = eventRule(event);
  emotionState = applyEvent(emotionState, event);
  window.__pet.mood = emotionState.mood;
  window.__pet.emotion = emotionState.emotion;
  if (!rule?.express) return;
  showEmotion(emotionState.emotion);
}

/**
 * 直接换上某个语义情绪的表情。
 *
 * 与 applyEmotion 分开：助理那边来的事件已经带着**语义情绪**
 * （「惊讶」「开心」），不需要再走一遍「事件 → 情绪」的映射，
 * 也不该改动心情值——心情反映的是用户怎么对待桌宠。
 */
function showEmotion(emotion) {
  if (!emotion) return;
  emotionState = { ...emotionState, emotion };
  window.__pet.emotion = emotion;
  const name = expressionNameFor(currentManifest, emotion);
  if (!name || !currentModel?.expression) return;
  try {
    currentModel.expression(name)?.catch?.(() => {});
  } catch {
    /* 表情缺失时静默跳过 */
  }
}

/** 记录一次用户互动：重置「多久没人理」的计时。 */
function markInteraction() {
  emotionState = touch(emotionState);
}

/**
 * 记录一次点击，并判断是不是「被连续猛点」。
 *
 * 触发过一次就把计数清空：否则用户继续点的话每一下都会再气一次，
 * 那不是生气，那是卡死。
 */
function recordTap() {
  const now = Date.now();
  tapTimes.push(now);
  while (tapTimes.length > 0 && now - tapTimes[0] > SPAM_WINDOW_MS) tapTimes.shift();
  if (tapTimes.length >= SPAM_THRESHOLD) {
    tapTimes.length = 0;
    applyEmotion(EVENT.SPAM);
  }
}

/**
 * 拖拽时的钟摆摇摆：被拎在半空的挣扎感。
 *
 * 绕**脚下的锚点**转（模型的 anchor 是 [0.5, 1.0]），
 * 所以是「站着晃」而不是「整个人转圈」。
 */
function startDragWobble() {
  if (dragWobble || !stage?.app?.ticker) return;
  const tick = () => {
    const model = currentModel;
    if (!model || model.destroyed) return;
    model.rotation = Math.sin((performance.now() / 1000) * 9) * 0.05;
  };
  stage.app.ticker.add(tick);
  dragWobble = tick;
}

/** 停止摇摆并把模型摆正。 */
function stopDragWobble() {
  if (!dragWobble) return;
  stage?.app?.ticker?.remove(dragWobble);
  dragWobble = null;
  if (currentModel && !currentModel.destroyed) currentModel.rotation = 0;
}

/**
 * 设定用户缩放。
 *
 * 缩放**不直接作用在模型上**：主进程拿到新缩放后把窗口放大，
 * 画布随之变大，渲染层按画布重新适配模型。
 * 「模型永远在画布里」因此是构造上的保证——放多大都不会被切掉上半身。
 */
function setUserScale(next) {
  // 对齐到设置窗口滑块的刻度（0.05）：滚轮按比例换算出来的值常常是 1.36 这种，
  // 落盘后设置窗口的滑块会把它吸附到最近的刻度，滑块与显示的数字就对不上了。
  const stepped = Math.round(next / SCALE_STEP) * SCALE_STEP;
  // 再抹掉浮点误差：0.05 * 27 在 IEEE754 下是 1.3500000000000001，
  // 这种值会原样落进 settings.json。
  const clamped = Math.min(
    SCALE_RANGE.max,
    Math.max(SCALE_RANGE.min, Math.round(stepped * 1000) / 1000),
  );
  if (clamped === userScale) return;
  userScale = clamped;
  window.__pet.scale = clamped;
  pendingScale = clamped;
  if (scaleSaveQueued) return;
  scaleSaveQueued = true;
  requestAnimationFrame(() => {
    scaleSaveQueued = false;
    const value = pendingScale;
    pendingScale = null;
    // invoke 返回 promise：窗口在滚动途中被拆掉时它会拒绝，
    // 渲染层没有全局 unhandledrejection 兜底——拒绝必须吃掉。
    window.pet.saveSettings?.({ scale: value })?.catch?.((err) => {
      console.warn('[desk-pet] 缩放保存失败：', err?.message || err);
    });
  });
}

/**
 * 排队一次形象切换。
 *
 * 请求序号在**调用时**就取好：并发请求里只有最后取到序号的那个允许提交，
 * 先到的那些直接作废，连模型都不加载。
 *
 * `initial: true` 用于**启动时的首次挂载**：它的序号固定为 0，
 * 因此不会顶掉任何用户请求（用户请求的序号从 1 开始），
 * 但仍会被任何后来的用户请求顶掉——启动期间用户切了形象，
 * 该由用户的请求说了算。
 */
function mountModel(modelId, opts = {}) {
  const token = opts.initial ? 0 : ++switchSeq;
  const run = switchChain.then(
    () => doMountModel(modelId, token),
    () => doMountModel(modelId, token),
  );
  // 链条本身不能被拒绝打断：某一次切换失败不能卡死后面的切换。
  switchChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 加载并挂载一个形象（串行化后的实际执行体）。
 *
 * 顺序很重要：**先加载新模型，再销毁旧模型**。反过来的话中间会出现
 * 一帧空舞台，而且一旦新模型加载失败，旧模型也已经被销毁了——
 * 用户的桌宠就彻底没了。
 */
async function doMountModel(modelId, token) {
  // 还没开始就已经被更新的请求顶掉了：什么都不用做。
  if (token !== switchSeq) return null;

  const manifest = await loadManifest(modelId);

  // 切换到**当前已挂载的同一个形象**时直接返回。
  // pixi 对已缓存的 URL 会返回同一个 Texture 实例，新旧模型因此共享同一批
  // 纹理对象；紧接着调用 disposeTextures 会把新模型自己的纹理销毁掉——
  // 桌宠变成「没有绑定纹理的空壳」，而 switchModel 仍然报告成功。
  if (currentModel && manifest.id === currentManifest?.id) {
    return currentModel;
  }

  let model;
  try {
    model = await loadPetModel(manifest);
  } catch (err) {
    // 加载失败时旧模型仍挂在舞台上，用户不会看到桌宠凭空消失。
    // 但失败的加载可能已经把纹理塞进了全局缓存，必须清掉，
    // 否则反复失败的切换会不断堆积显存。
    disposeTexturesUnderPath(`/assets/live2d/models/${manifest.id}/`);
    throw err;
  }

  // 缩放每次挂载时重读：userScale 是启动时抓的，
  // 用户在设置里改过缩放后再切换形象，新模型必须用新缩放。
  //
  // 这一句必须放在**提交之前**：提交段（销毁旧模型 → 挂载新模型 → 更新状态）
  // 要保持整体同步，中途 await 会让并发请求插进来，导致舞台上同时挂着两个模型。
  const settings = await window.pet.getSettings();
  if (typeof settings?.scale === 'number') userScale = settings.scale;

  // 加载期间可能又发起了新的切换——过期请求直接放弃，不要动舞台。
  if (token !== switchSeq) {
    disposePetModel(model);
    return null;
  }

  let released = 0;
  if (currentModel) {
    // 先把旧模型摘出舞台：它马上要被销毁，留在渲染列表里只会
    // 让渲染循环去访问已经释放的纹理。
    if (currentModel.parent) currentModel.parent.removeChild(currentModel);
    // 口型驱动也要拆：它闭包引用着旧模型的 coreModel，
    // 不拆的话旧模型销毁后仍会被每帧回调碰到。
    lipSync?.detach();
    lipSync = null;
    released = disposePetModel(currentModel);
    currentModel = null;
  }
  window.__pet.lastReleasedTextures = released;

  stage.app.stage.addChild(model);
  // 口型驱动挂在**新模型**上：模型没有口型参数时 attachLipSync 返回 null，
  // 整个功能静默关闭。
  lipSync = attachLipSync(model);
  const fit = stage.fitModel(model, manifest);
  currentModel = model;
  currentManifest = manifest;
  // 模型上屏了：启动失败时画的那块占位提示该撤掉了。
  removeFailurePlaceholder();

  // manifest.id 是注册表里的 id：未知的 modelId 会在 loadManifest 里
  // 回退到注册表首个形象，这里直接把回退后的 id 呈现出来。
  window.__pet.modelId = manifest.id;
  window.__pet.modelLoaded = true;
  // window.__pet.expressions = 模型**原始**表情名列表（如 Haru 的 F01..F08）
  // 语义映射（happy/angry/...）在 window.__pet.manifest.expressions 里。
  // 两者不要混淆：交互层要语义，测试与诊断要原始名。
  window.__pet.expressions = manifest.availableExpressions || [];
  // 命中区同样要跟着新模型重读——沿用旧模型的命中区会让点击落在
  // 新模型身上却不触发任何反应。
  window.__pet.hitAreas = Object.keys(model.internalModel?.hitAreas || {});
  window.__pet.naturalSize = { w: fit.naturalWidth, h: fit.naturalHeight };
  window.__pet.model = model;
  window.__pet.manifest = manifest;
  return model;
}

/**
 * 启动失败时画在画布上的占位提示。
 *
 * 失败必须**看得见**：渲染层的 console.* 不进终端，用户在 `npm start` 里
 * 只看到一份干净的日志和一个全透明的空窗口——完全不可见的失败。
 * 除了报告给主进程（终端里有痕迹），画一块占位提示，
 * 让「桌宠没出来」这件事在桌面上也有个解释。
 */
function showFailurePlaceholder(message) {
  removeFailurePlaceholder();
  try {
    const PIXI = window.PIXI;
    if (!PIXI || !stage?.app) return;
    const box = new PIXI.Graphics();
    box.beginFill(0x2a2a36, 0.92).drawRoundedRect(24, 150, 252, 180, 12).endFill();
    box.lineStyle(2, 0xd06a6a).drawRoundedRect(24, 150, 252, 180, 12);
    const title = new PIXI.Text('模型加载失败', { fontSize: 20, fill: 0xffd7d7, align: 'center' });
    title.anchor.set(0.5, 0);
    title.position.set(150, 176);
    const detail = new PIXI.Text(String(message || '').slice(0, 120), {
      fontSize: 12,
      fill: 0xcfcfd8,
      align: 'center',
      wordWrap: true,
      wordWrapWidth: 220,
    });
    detail.anchor.set(0.5, 0);
    detail.position.set(150, 212);
    stage.app.stage.addChild(box, title, detail);
    failurePlaceholder = [box, title, detail];
  } catch (err) {
    // 占位图画不出来也不能让启动崩掉：失败已经报告给主进程了。
    console.warn('[desk-pet] 失败占位绘制失败：', err?.message || err);
  }
}

function removeFailurePlaceholder() {
  if (!failurePlaceholder) return;
  for (const node of failurePlaceholder) {
    try {
      node.parent?.removeChild(node);
      node.destroy?.({ children: true });
    } catch {
      /* ignore */
    }
  }
  failurePlaceholder = null;
}

/**
 * 注册渲染层的推送频道监听器。
 *
 * 必须在第一次 mountModel **之前**调用：Electron 的 webContents.send
 * 对尚未注册监听器的渲染层是**丢弃**而不是排队。启动期间
 * （首次 mountModel 要加载 model3.json + moc3 + 2048² 贴图，约 0.5~2 秒）
 * 发出的切换请求与设置广播会凭空消失：磁盘写着 Natori、
 * 下拉框显示 Natori，桌面上跑的还是 Haru。
 */
function registerChannels() {
  // 主进程请求切换形象（pet:modelSwitchRequest）。
  // 这是既有的唯一切换入口，不另开 IPC 通道。
  window.pet.onModelSwitchRequest(async (modelId, requestId) => {
    try {
      const mounted = await mountModel(modelId);
      if (mounted === null) {
        // 被**更新的**请求顶掉了：这一次没有上屏，交给那一次请求回报结果。
        window.pet?.reportModelSwitchResult?.({
          requestId,
          ok: false,
          superseded: true,
          modelId: currentManifest?.id || null,
        });
        return;
      }
      window.__pet.switchError = null;
      // 回报主进程：**必须**让它知道模型真的上屏了。
      // 没有回执的话，主进程无法知道该落盘哪个 id——
      // 磁盘上的 modelId 会指向一个没上屏的形象，
      // 而设置窗口还会若无其事地显示「已切换到 …」。
      window.pet?.reportModelSwitchResult?.({
        requestId,
        ok: true,
        modelId: currentManifest?.id || modelId,
      });
    } catch (err) {
      const message = String(err?.message || err);
      window.__pet.switchError = message;
      // 屏幕上**一个模型都没有**时，必须画一块占位提示：
      // 启动期的用户请求可能顶掉了首次挂载，若它又失败，窗口就是一个
      // 全透明的空矩形——用户看不到任何解释（占位提示原先只接在启动路径上）。
      if (!currentModel) showFailurePlaceholder(message);
      // 失败也要回报：主进程要把磁盘上的 modelId 回滚到**屏幕上那个**形象，
      // 设置窗口要显示失败而不是「已切换到 …」（spec §4.5 第 4 步）。
      window.pet?.reportModelSwitchResult?.({
        requestId,
        ok: false,
        modelId: currentManifest?.id || null,
        error: message,
      });
    }
  });

  // 设置窗口改了缩放/透明度，主进程会把新设置广播过来。
  // 缩放要在这里立刻重新适配：切换形象走的是 mountModel，
  // 而只改缩放时并没有换模型，不重新适配的话画面不会变。
  window.pet.onSettingsChanged((s) => {
    if (!s) return;
    if (typeof s.scale === 'number' && s.scale !== userScale) {
      // 只有缩放**真的变了**才重新适配：广播带的是完整设置对象，
      // 拖动**透明度**滑块时 scale 也在里面，不比较就会每次都白白 fit 一次。
      //
      // 滚轮缩放时本地已经先改过 userScale（见 setUserScale），
      // 所以这里只在**外部**（设置窗口）改了缩放时才会走到。
      userScale = s.scale;
      window.__pet.scale = userScale;
      if (currentModel && currentManifest) {
        stage.fitModel(currentModel, currentManifest);
      }
    }
    if (typeof s.opacity === 'number') {
      // 透明度实际由主进程 setOpacity 施加在宠物窗口上，
      // 这里只是把生效值记到诊断面上。
      window.__pet.opacity = s.opacity;
    }
  });

  // —— 桌面助理的事件 ——
  // 情绪：主进程那边发生了「提醒到了」「太热了」之类的事。
  window.pet.onEmotion?.((emotion, moodDelta) => {
    if (!emotion) return;
    // 心情值可以跟着动一点（比如任务完成让桌宠也开心）。
    if (typeof moodDelta === 'number' && moodDelta !== 0) {
      emotionState = { ...emotionState, mood: clampMood(emotionState.mood + moodDelta) };
      window.__pet.mood = emotionState.mood;
    }
    showEmotion(emotion);
  });

  // 合成好的语音：播放它，并用响度包络驱动口型。
  window.pet.onSpeak?.((audio, mime) => {
    if (!audio) return;
    // IPC 传过来的是 Uint8Array；字节序由 StructuredClone 保证。
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    window.__pet.speechCount += 1;
    window.__pet.lastSpeechBytes = bytes.length;
    void playSpeech(bytes, (amplitude) => {
      lipSync?.setAmplitude(amplitude);
      window.__pet.mouthAmplitude = amplitude;
    })
      .then(() => {
        // 播完之后才拿得到：连接是在 decodeAudioData 之后才做的。
        window.__pet.speechOutput = getSpeechOutput();
      })
      .catch((err) => {
        console.warn('[desk-pet] 语音播放失败：', err?.message || err);
      });
  });

  // 提示音：待办完成、提醒响起之类的界面反馈。
  window.pet.onSound?.((name) => {
    if (name === 'success') playSuccess();
    else if (name === 'alarm') playAlarm();
    else if (name === 'error') playError();
    else if (name === 'tap') playTap();
  });

  // 音效总开关（设置窗口改的）。
  window.pet.onSoundEnabled?.((enabled) => setAudioEnabled(enabled));

  // 总音量：主进程把它推过来。
  window.pet.onVolume?.((v) => {
    if (typeof v !== 'number') return;
    window.__pet.volume = setMasterVolume(v);
  });

  // 系统光标位置：主进程以 10Hz 轮询发过来（窗口内坐标）。
  //
  // 只在光标**不在桌宠窗口里**时才驱动视线：
  // 光标在窗口内时，指针事件（pointermove）已经在管这件事了，
  // 两边同时驱动会让视线在两个目标之间来回跳。
  window.pet.onCursorPoint?.((p) => {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
    window.__pet.cursorPoint = { x: p.x, y: p.y };
    const canvas = stage?.app?.view;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // 主进程发的是**窗口内**坐标；画布未必铺满窗口（rect.left/top 不为 0）。
    // 换算成画布坐标再判断「光标在不在桌宠身上」——
    // 与指针事件那条路径（interaction.js 的 local()）保持同一套坐标。
    const x = p.x - rect.left;
    const y = p.y - rect.top;
    const inside = x >= 0 && x <= rect.width && y >= 0 && y <= rect.height;
    if (inside) return;
    if (!currentModel?.focus) return;
    try {
      // model.focus 吃的是画布/世界坐标，与指针路径传的是同一个空间。
      currentModel.focus(x, y);
    } catch {
      /* ignore */
    }
  });
}

async function boot() {
  const container = document.getElementById('stage');
  stage = createStage(container);
  window.__pet.stage = stage;

  // 监听器先注册、ready 信号先发：启动期间主进程推过来的东西不能丢。
  registerChannels();
  window.pet?.reportRendererReady?.();

  const settings = await window.pet.getSettings();
  userScale = settings?.scale ?? 1;
  window.__pet.scale = userScale;
  window.__pet.opacity = typeof settings?.opacity === 'number' ? settings.opacity : 1;
  // 音量：启动时先按默认值摆好，主进程随后会推真值过来。
  window.__pet.volume = getMasterVolume();
  try {
    // 不在这里写死任何形象 id：loadManifest 对未知/缺失的 id 会回退到注册表首个形象。
    // initial: true —— 首次挂载不顶掉用户请求，但会被用户请求顶掉。
    await mountModel(settings?.modelId, { initial: true });
  } catch (err) {
    // 模型加载失败必须让主进程知道（spec §4.5 第 4 步的「提示」）。
    // 渲染层的 console.* 不进终端：只写 window.__pet.error 的话，
    // 用户在 npm start 里只看到一份干净的日志和一个全透明的空窗口。
    window.__pet.error = String(err?.stack ? err.stack : err);
    window.pet?.reportModelError?.({
      // kind 必须区分开：「模型加载失败」与「渲染层自己崩了」是两件事。
      // 主进程只在**真的**模型加载失败时才回退磁盘上的 modelId——
      // 否则一次与模型无关的崩溃会把用户选好的形象悄悄丢掉。
      kind: 'model-load',
      message: String(err?.message || err),
      stack: window.__pet.error,
    });
    showFailurePlaceholder(err?.message || err);
  }

  const canvas = stage.app.view;

  /**
   * 文件拖放：把文件拖到桌宠身上。
   *
   * 路径要用 `webUtils.getPathForFile` 取：Electron 32 起 `File.path` 已被移除，
   * 而 webUtils 只能在 preload 里调，所以由 preload 代劳（window.pet.pathForFile）。
   *
   * dragover **必须** preventDefault：不 preventDefault 浏览器就不会触发 drop。
   */
  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const path = window.pet.pathForFile?.(file) || '';
    if (!path) return;
    window.pet.reportDroppedFile?.(path);
  });

  // 空闲计时：20 秒无交互则播一次 idle 动作（spec §5.1）
  const DEFAULT_IDLE_MS = 20000;
  let idleMs = DEFAULT_IDLE_MS;
  let idleTimer = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!currentModel || !currentManifest) {
        resetIdleTimer();
        return;
      }
      const r = idleReaction(currentManifest);
      // 「随机待机动作」：motion 只给组名、不给索引，库会随机挑该组里的一个动作。
      // 给固定索引就不是随机的了。
      if (r.motionSpec && currentModel?.motion) {
        try {
          currentModel.motion(r.motionSpec.group)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
      // 同时把表情换成**当前情绪**对应的那个。
      //
      // 以前这里固定换回 normal（idleReaction 的语义键就是 normal），
      // 可那样一来「久没人理」的难过脸会被每 20 秒的待机动作盖掉，
      // 而无聊程度的判定只在**等级变化**时才换脸——
      // 于是桌宠顶多难过 20 秒，之后就一直是一张若无其事的普通脸。
      //
      // 现在由情绪系统决定脸：默认情绪是 neutral → normal（与原来完全一样），
      // 犯困/难过时就会一直保持那张脸。
      //
      // 当前情绪在清单里没映射时**退回 normal**：
      // 降级模型（没有 pet.json）只按名字认得 normal，
      // 若这里什么都不套，那张脸就一直停在上一个表情上——
      // 而 spec §4.3 的降级规则是「按名字套上 Normal」。
      const emotionName =
        expressionNameFor(currentManifest, emotionState.emotion) || r.expressionName;
      if (emotionName && currentModel?.expression) {
        try {
          currentModel.expression(emotionName)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
      // 重新武装：独处一会的桌宠不该只动一次就再也不动了。
      resetIdleTimer();
    }, idleMs);
  }
  resetIdleTimer();
  // 暴露出来，测试不必真的等 20 秒。
  window.__pet.idleMs = idleMs;
  // 测试缝：允许把空闲间隔调短以验证「重新武装」——
  // 没有它，重新武装只能靠代码审读确认。
  window.__pet.setIdleMs = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return idleMs;
    idleMs = ms;
    window.__pet.idleMs = idleMs;
    resetIdleTimer();
    return idleMs;
  };

  // 心情的后台维护：心情自然回落，久没人理会露出难过/困倦的脸。
  //
  // 30 秒一次足够：这些状态的变化本来就慢，
  // 而「心情回落」这种每分钟才动几个点的效果没必要更频繁。
  setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastDecayAt;
    lastDecayAt = now;
    const mood = decayMood(emotionState.mood, elapsed);
    if (mood !== emotionState.mood) {
      emotionState = { ...emotionState, mood };
      window.__pet.mood = mood;
    }
    // 只在**等级变化**时换表情：否则每 30 秒就把同一张难过脸重播一遍。
    const level = boredomLevel(emotionState, now);
    if (level !== boredomEvent) {
      boredomEvent = level;
      if (level) applyEmotion(level);
      return;
    }
    // 心情淡到接近 0 时，情绪回到中性。
    //
    // 不然的话：摸一次头（心情 +12）之后，开心脸会一直挂着——
    // 心情在淡，脸却不会自己回去。
    if (!level && emotionState.mood <= 3 && emotionState.emotion !== 'neutral') {
      showEmotion('neutral');
    }
  }, 30000);

  // 画布上唯一的指针事件入口。模型与清单都在**回调里实时读取**：
  // 切换形象后拿到的必须是当前模型，不能是上一个形象的引用。
  attachInteraction({
    canvas,
    getModel: () => currentModel,
    getManifest: () => currentManifest,
    onInteract: () => {
      // 空闲计时（spec §5.1）与「多久没人理」是两件事：
      // 前者决定什么时候播 idle 动作，后者决定什么时候露出无聊/困倦的脸。
      resetIdleTimer();
      markInteraction();
    },
    onTap: ({ zone, reaction }) => {
      window.__pet.lastZone = zone;
      window.__pet.lastExpression = reaction.expressionName;
      window.__pet.lastMotion = reaction.motionSpec;
      if (reaction.expressionName && currentModel?.expression) {
        try {
          // expression() / motion() 返回 promise，try/catch 抓不到异步拒绝——
          // 被拒绝的 promise 会变成未处理拒绝，违反「渲染进程不得产生未捕获错误」。
          currentModel.expression(reaction.expressionName)?.catch?.(() => {});
        } catch {
          /* 表情缺失时静默跳过 */
        }
      }
      if (reaction.motionSpec && currentModel?.motion) {
        try {
          currentModel.motion(reaction.motionSpec.group, reaction.motionSpec.index)?.catch?.(() => {});
        } catch {
          /* 动作缺失时静默跳过 */
        }
      }
      // 触摸反馈音效：角色的台词由模型自带，这里只是「碰了一下」的界面反馈。
      playTap();
      // 左键点桌宠 → 弹出插件面板（搜索框）。
      //
      // 摸头的表情与音效**照旧**：面板是入口，不是把角色的反应抢走。
      // invoke 返回 promise：窗口在点击后被拆掉时它会拒绝，
      // 而渲染层没有全局 unhandledrejection 兜底——拒绝必须吃掉。
      window.pet.openPanel?.()?.catch?.(() => {});
      // 情绪：点击只改心情，**不换表情**——
      // spec §5.1 已经给摸头/点击身体指定了表情（happy / smile），
      // 情绪系统不该把它覆盖掉。
      //
      // 顺序要紧：先记这次点击的普通情绪，**再**判猛点——
      // 反过来的话「生气」会被紧接着的普通情绪盖掉，生气永远显示不出来。
      applyEmotion(zone === 'head' ? EVENT.TAP_HEAD : EVENT.TAP_BODY);
      recordTap();
    },
    onHover: (x, y) => {
      window.__pet.focusPoint = { x, y };
      if (currentModel?.focus) {
        try {
          currentModel.focus(x, y);
        } catch {
          /* ignore */
        }
      }
    },
    onDragStart: () => {
      // 告诉主进程「新一次拖拽开始」，让它把期望位置重新对齐当前窗口位置。
      // ipcRenderer.invoke 返回 promise：主进程抛错或帧被拆除时会拒绝，
      // 而渲染层没有全局 unhandledrejection 兜底——拒绝会变成未处理错误。
      window.pet.dragStart?.()?.catch?.(() => {});
      // 每次拖拽重新开始：屏幕坐标的累计基准要清零，
      // 否则上一次拖拽的终点会被当成本次的起点。
      lastPointerScreen = null;
      const r = currentManifest ? resolveMotionSpec(currentManifest, 'drag') : null;
      if (r && currentModel?.motion) {
        try {
          currentModel.motion(r.group, r.index)?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
      // 被拎起来：惊讶脸 + 钟摆摇摆（悬空挣扎的观感）。
      applyEmotion(EVENT.DRAG_START);
      startDragWobble();
    },
    onDragMove: ({ deltaX, deltaY, clientX, clientY }) => {
      // 增量必须换算到**屏幕**坐标再累加。
      //
      // clientX/clientY 是窗口内的坐标：窗口追着光标跑，窗口每移动 1px，
      // 下一个事件的 clientX 就少 1px。于是「所有 clientX 增量之和」
      // = 光标的屏幕位移 − 窗口自己的位移，角色只走到光标位移的一半
      // （实测拖 120px 只走了 60px，角色落在光标后面）。
      //
      // window.screenX + clientX 才是光标在**屏幕**上的位置，
      // 它的增量就是光标真实的屏幕位移：累加起来正好等于光标走过的距离，
      // 角色才会严丝合缝地跟着光标走。
      // 传给主进程的仍然是增量，主进程照旧累加、夹紧、持久化。
      const pointer = { x: window.screenX + clientX, y: window.screenY + clientY };
      let dx = deltaX;
      let dy = deltaY;
      if (lastPointerScreen) {
        dx = pointer.x - lastPointerScreen.x;
        dy = pointer.y - lastPointerScreen.y;
      }
      // 第一次移动时窗口还没动过，clientX 的增量本身就是屏幕位移，
      // 直接用；之后一律用屏幕坐标的增量。
      lastPointerScreen = pointer;
      window.__pet.lastDragDelta = { deltaX: dx, deltaY: dy };
      // invoke 返回 promise：窗口在拖拽途中被拆掉时它会拒绝。
      // 这是最热的路径（每个 pointermove 一次），但拒绝必须吃掉——
      // 渲染层没有全局 unhandledrejection 兜底。
      window.pet.moveWindowBy?.(dx, dy)?.catch?.(() => {});
    },
    onDragEnd: () => {
      // 拖拽结束同样通知主进程清掉累加器：
      // 累加器的正确性不该依赖 pet:dragStart 这个信号一定送达。
      // （主进程已在每次 moveWindowBy 时持久化位置，这里无需额外持久化。）
      window.pet.dragEnd?.()?.catch?.(() => {});
      // 落地：停止摇摆，把脸从惊讶换回平常。
      stopDragWobble();
      applyEmotion(EVENT.DRAG_END);
    },
    onContextMenu: () => {
      // 同上：invoke 的 promise 必须处理掉，不能变成未处理拒绝。
      window.pet.showContextMenu?.()?.catch?.(() => {});
    },
    onZoom: (deltaY) => {
      // 滚轮向上（deltaY < 0）放大。
      //
      // 一个滚轮刻度记作 100：Windows 鼠标一格是 100~120，
      // 触控板的小增量按比例换算，滚起来才跟手。
      setUserScale(userScale - (deltaY / 100) * SCALE_STEP);
    },
  });

  // 诊断钩子：**直接**挂载模型，绕过主进程——
  // 不落盘、不广播，也不走主进程的 resolveModelId 解析。
  //
  // 与 window.pet.switchModel（走 IPC、会持久化并广播）是两套语义：
  // 别把这个当设置路径用，它只服务于「在测试里直接换个模型跑一下」。
  window.__pet.switchModel = async (modelId) => {
    try {
      await mountModel(modelId);
      window.__pet.switchError = null;
      return true;
    } catch (err) {
      window.__pet.switchError = String(err && err.message ? err.message : err);
      return false;
    }
  };

  window.__pet.ready = true;
}

boot().catch((err) => {
  // 启动过程本身崩了（不只是模型加载失败）：同样必须让主进程知道。
  // 只写 window.__pet.error 的话，用户在终端里看不到任何线索。
  //
  // kind 是 'renderer-error' 而不是 'model-load'：模型可能好好的，
  // 崩的是渲染层。这时主进程**不应该**回退磁盘上的 modelId——
  // 否则一次与模型无关的崩溃会把用户选好的形象悄悄丢掉。
  window.__pet.error = String(err && err.stack ? err.stack : err);
  window.pet?.reportModelError?.({
    kind: 'renderer-error',
    message: String(err?.message || err),
    stack: window.__pet.error,
  });
  showFailurePlaceholder(err?.message || err);
  window.__pet.ready = true;
});
