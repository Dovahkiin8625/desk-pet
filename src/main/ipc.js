import { ipcMain } from 'electron';

// 只注册渲染层实际用得到的通道；托盘/右键菜单的行为由主进程直接执行，不走 IPC。
export function registerIpc({
  getSettings,
  saveSettings,
  listModels,
  switchModel,
  onOpenSettings,
  onShowContextMenu,
  onMoveBy,
  onDragStart,
  onDragEnd,
}) {
  ipcMain.handle('pet:getSettings', () => getSettings());
  ipcMain.handle('pet:saveSettings', (_e, patch) => saveSettings(patch));
  ipcMain.handle('pet:listModels', () => listModels());
  ipcMain.handle('pet:switchModel', (_e, modelId) => switchModel(modelId));
  ipcMain.handle('pet:showContextMenu', () => onShowContextMenu());
  ipcMain.handle('pet:openSettings', () => onOpenSettings());
  // 增量位移：主进程负责累加、夹紧到可见区域并持久化位置。
  // 渲染层只负责把「这一段拖了多远」递过来，绝不传绝对坐标。
  ipcMain.handle('pet:moveWindowBy', (_e, delta) => {
    if (!delta) return;
    onMoveBy(Number(delta.dx) || 0, Number(delta.dy) || 0);
  });
  // 新一次拖拽开始：主进程清掉期望位置，让下一次增量从窗口的真实位置重新起算。
  ipcMain.handle('pet:dragStart', () => {
    onDragStart();
  });
  // 拖拽结束同样清掉累加器：即使 dragStart 信号在某次丢失，
  // 下一次拖拽也不会累加到上一次拖拽的未夹紧位置上。
  ipcMain.handle('pet:dragEnd', () => {
    onDragEnd();
  });
}
