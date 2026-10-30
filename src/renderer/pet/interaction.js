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
  // 画布坐标：hitTest / focus 都以画布左上角为原点。
  // 画布铺满窗口时画布坐标与窗口坐标重合，但仍按 getBoundingClientRect() 计算——
  // 假设画布一定在 (0,0) 迟早会在窗口内边距或布局变化时算错。
  const local = (clientX, clientY) => {
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

  const handleDown = (e) => drag.pointerDown(e);

  const handleMove = (e) => {
    drag.pointerMove(e);
    const { x, y } = local(e.clientX, e.clientY);
    onHover?.(x, y);
  };

  const handleUp = (e) => drag.pointerUp(e);

  const handleCancel = () => drag.pointerCancel();

  const handleContextMenu = (e) => {
    e.preventDefault();
    onInteract?.();
    onContextMenu?.();
  };

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
