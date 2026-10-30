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

  const handleMove = (e) => {
    drag.pointerMove(e);
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

  const handleDown = (e) => {
    // 指针捕获：没有它，光标一旦移出画布，pointermove/pointerup 就不再送达——
    // 拖拽会丢失增量、onDragEnd 永不触发。
    // 桌宠窗口是跟着光标走的（差一个 IPC 往返），快速移动时光标会跑出窗口。
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 个别环境不支持捕获，忽略即可 */
    }
    drag.pointerDown(e);
  };

  const handleUp = (e) => drag.pointerUp(e);

  const handleCancel = () => drag.pointerCancel();

  canvas.addEventListener('pointerdown', handleDown);
  canvas.addEventListener('pointermove', handleMove);
  canvas.addEventListener('pointerup', handleUp);
  canvas.addEventListener('pointercancel', handleCancel);
  canvas.addEventListener('contextmenu', handleContextMenu);

  return {
    dispose() {
      canvas.removeEventListener('pointerdown', handleDown);
      canvas.removeEventListener('pointermove', handleMove);
      canvas.removeEventListener('pointerup', handleUp);
      canvas.removeEventListener('pointercancel', handleCancel);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    },
    get dragging() {
      return drag.dragging;
    },
  };
}
