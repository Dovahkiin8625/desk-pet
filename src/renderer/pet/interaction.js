import { createDragController } from '../ui/drag.js';
import { hitZoneAt } from './hitZone.js';
import { reactionFor } from './behavior.js';

/**
 * 本模块是画布上**唯一**的指针事件入口——拖拽、点击、悬停、右键全部由此统一分发。
 * 不要再为拖拽单独挂监听器，否则同一批指针事件会被处理两次
 * （点击会同时触发「摸头」和「拖拽」，窗口也会跟着移动两次）。
 *
 * 模型通过 getModel()/getManifest() 每次实时读取：形象切换后
 * 拿到的必须是**当前**模型，不能缓存住上一个形象的引用。
 */
export function attachInteraction({
  canvas,
  getModel,
  getManifest,
  onTap,
  onHover,
  onDragStart,
  onDragMove,
  onDragEnd,
  onContextMenu,
  onInteract,
  onZoom,
  // 「这一点在不在形象上」。返回 false = 明确不在（这次点击不算），
  // 返回 null/undefined = 不知道（退回旧行为）。
  isOnFigure,
  // 拖拽状态变化时回调一次（true = 正在拖，第二个参数 = 指针还按着）。
  // 用来在按下/拖拽期间关掉「透明处穿透」——半路把窗口变成
  // 不吃鼠标事件的窗口，拖拽会当场断掉。
  onDragStateChange,
}) {
  const local = (clientX, clientY) => {
    // hitTest / focus 的入参是**世界坐标**（库内部用 worldTransform.applyInverse 换算）。
    // 这里画布铺满窗口且 stage 在原点，世界坐标与画布坐标数值相同；
    // 但一旦画布内缩或 stage 被平移，两者就不一样了——所以别把注释写成「以画布为原点」。
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const drag = createDragController({
    onTap: (clientX, clientY) => {
      const model = getModel();
      const manifest = getManifest();
      if (!model || !manifest) return;
      const { x, y } = local(clientX, clientY);
      // 可点击区域由**形象**决定：点在形象的透明留白上不算点到桌宠。
      //
      // 判定用渲染结果的 alpha（见 pet/silhouette.js），不是包围盒——
      // 包围盒里也有一大片透明。返回 null 表示「量不出来」，
      // 那时按旧行为处理，不能因为测量失败就让桌宠点不动。
      const onFigure = isOnFigure?.(x, y);
      if (onFigure === false) return;
      const zone = hitZoneAt(model, x, y);
      const reaction = reactionFor(manifest, zone);
      onInteract?.();
      onTap?.({ zone, x, y, reaction });
    },
    onDragStart: (clientX, clientY) => {
      onInteract?.();
      onDragStart?.(local(clientX, clientY));
    },
    onDragMove: ({ clientX, clientY, deltaX, deltaY }) => {
      onDragMove?.({ ...local(clientX, clientY), clientX, clientY, deltaX, deltaY });
    },
    onDragEnd: ({ clientX, clientY }) => {
      onDragEnd?.({ ...local(clientX, clientY), clientX, clientY });
    },
  });

  // 拖拽状态的变化只往外说一次：正在拖 / 按着不放 / 都没发生。
  let lastDragging = false;
  let lastPressed = false;
  const reportDragState = () => {
    if (drag.dragging === lastDragging && drag.pressed === lastPressed) return;
    lastDragging = drag.dragging;
    lastPressed = drag.pressed;
    onDragStateChange?.(lastDragging, lastPressed);
  };

  const handleMove = (e) => {
    drag.pointerMove(e);
    reportDragState();
    const { x, y } = local(e.clientX, e.clientY);
    // 悬停也算交互：空闲动画是给「用户走开了」的场景准备的，
    // 鼠标还在桌宠身上动的时候，桌宠正被看着，不该自说自话。
    onInteract?.();
    onHover?.(x, y);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    onInteract?.();
    onContextMenu?.();
  };

  const handleWheel = (e) => {
    // 只有按住 Ctrl 才响应：普通滚轮留给桌宠自己（目前没有别的用途），
    // 按住 Ctrl 是「调整大小」这个手势的明确标记。
    if (!e.ctrlKey) return;
    // 必须拦掉默认行为：在 Chromium 里 Ctrl+滚轮是**页面缩放**，
    // 不拦的话整个桌宠窗口会被浏览器放大，而不是模型变大。
    e.preventDefault();
    onInteract?.();
    onZoom?.(e.deltaY);
  };

  const handleDown = (e) => {
    // 指针捕获：没有它，光标一旦移出画布，pointermove/pointerup 就不再送达——
    // 拖拽会丢失增量、onDragEnd 永不触发。
    // 桌宠窗口是跟着光标走的（差一个 IPC 往返），快速移动时光标会跑出窗口。
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // 捕获失败不能默默吞掉：生产环境里拖拽会静默丢掉窗口外的事件。
      // NotFoundError 的含义是「未知的 pointer id」——规范规定此时必须抛。
      // 真实鼠标的 pointer id 是已知的（不会抛），用 dispatchEvent 造的
      // 合成事件带的是不存在的 id，于是抛错——那不是故障，是测试手法。
      // 其它错误（例如环境根本没有 setPointerCapture）才是真问题。
      const unknownPointerId = err?.name === 'NotFoundError';
      console.warn(
        `[desk-pet] 指针捕获失败${unknownPointerId ? '（未知的 pointer id）' : ''}，拖拽移出窗口后可能丢事件：`,
        err?.message || err
      );
    }
    drag.pointerDown(e);
    reportDragState();
  };

  const handleUp = (e) => {
    drag.pointerUp(e);
    reportDragState();
  };

  const handleCancel = () => {
    drag.pointerCancel();
    reportDragState();
  };

  canvas.addEventListener('pointerdown', handleDown);
  canvas.addEventListener('pointermove', handleMove);
  canvas.addEventListener('pointerup', handleUp);
  canvas.addEventListener('pointercancel', handleCancel);
  canvas.addEventListener('contextmenu', handleContextMenu);
  // passive: false 是显式声明：wheel 监听器默认是被动的，
  // 被动监听器里 preventDefault() 不生效，浏览器缩放就拦不住。
  canvas.addEventListener('wheel', handleWheel, { passive: false });
}
