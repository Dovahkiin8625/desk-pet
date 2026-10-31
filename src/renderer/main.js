import { createStage } from './pet/stage.js';
import { loadManifest, resolveMotionSpec } from './pet/manifest.js';
import { loadPetModel, disposePetModel } from './pet/model.js';
import { disposeTexturesUnderPath } from './pet/texture.js';
import { attachInteraction } from './pet/interaction.js';
import { idleReaction } from './pet/behavior.js';

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
};

let stage = null;
let currentModel = null;
let currentManifest = null;
let userScale = 1;
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
    released = disposePetModel(currentModel);
    currentModel = null;
  }
  window.__pet.lastReleasedTextures = released;

  stage.app.stage.addChild(model);
  const fit = stage.fitModel(model, manifest, userScale);
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
      userScale = s.scale;
      window.__pet.scale = userScale;
      if (currentModel && currentManifest) {
        stage.fitModel(currentModel, currentManifest, userScale);
      }
    }
    if (typeof s.opacity === 'number') {
      // 透明度实际由主进程 setOpacity 施加在宠物窗口上，
      // 这里只是把生效值记到诊断面上。
      window.__pet.opacity = s.opacity;
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
      message: String(err?.message || err),
      stack: window.__pet.error,
    });
    showFailurePlaceholder(err?.message || err);
  }

  const canvas = stage.app.view;

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
      // 同时回到 normal 表情——idleReaction 的语义键就是 normal。
      if (r.expressionName && currentModel?.expression) {
        try {
          currentModel.expression(r.expressionName)?.catch?.(() => {});
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

  // 画布上唯一的指针事件入口。模型与清单都在**回调里实时读取**：
  // 切换形象后拿到的必须是当前模型，不能是上一个形象的引用。
  attachInteraction({
    canvas,
    getModel: () => currentModel,
    getManifest: () => currentManifest,
    onInteract: resetIdleTimer,
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
    },
    onContextMenu: () => {
      // 同上：invoke 的 promise 必须处理掉，不能变成未处理拒绝。
      window.pet.showContextMenu?.()?.catch?.(() => {});
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
  window.__pet.error = String(err && err.stack ? err.stack : err);
  window.pet?.reportModelError?.({
    message: String(err?.message || err),
    stack: window.__pet.error,
  });
  showFailurePlaceholder(err?.message || err);
  window.__pet.ready = true;
});
