import { ipcMain } from 'electron';

// 只注册渲染层实际用得到的通道；托盘/右键菜单的行为由主进程直接执行，不走 IPC。
export function registerIpc({
  getSettings,
  saveSettings,
  listModels,
  switchModel,
  onOpenSettings,
  onShowContextMenu,
  onOpenPanel,
  onMoveBy,
  onDragStart,
  onDragEnd,
  onRendererReady,
  onModelSwitchResult,
  onModelError,
  getAssistantState,
  saveAssistantPrefs,
  getTtsStatus,
  setTtsApiKey,
  getLlmStatus,
  setLlmApiKey,
  onDroppedFile,
}) {
  ipcMain.handle('pet:getSettings', () => getSettings());
  ipcMain.handle('pet:saveSettings', (_e, patch) => saveSettings(patch));
  ipcMain.handle('pet:listModels', () => listModels());
  ipcMain.handle('pet:switchModel', (_e, modelId) => switchModel(modelId));
  ipcMain.handle('pet:showContextMenu', () => onShowContextMenu());
  ipcMain.handle('pet:openSettings', () => onOpenSettings());
  // 左键点桌宠 → 弹出插件面板。
  ipcMain.handle('pet:openPanel', () => onOpenPanel());
  // 以下三个是**单向**通道（send 而非 invoke）：
  // 渲染层只是回报结果，主进程不需要回执；单向通道也不会产生
  // 「invoke 找不到处理器」的拒绝。
  ipcMain.on('pet:rendererReady', () => onRendererReady());
  ipcMain.on('pet:modelSwitchResult', (_e, result) => onModelSwitchResult(result));
  ipcMain.on('pet:modelError', (_e, info) => onModelError(info));
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

  // —— 桌面助理 ——
  // 助理状态：设置窗口用它显示与修改偏好（待办/提醒在插件面板里管）。
  ipcMain.handle('pet:getAssistantState', () => getAssistantState());
  ipcMain.handle('pet:saveAssistantPrefs', (_e, patch) => saveAssistantPrefs(patch));
  // 语音状态：只回掩码，**绝不回明文 key**。
  ipcMain.handle('pet:getTtsStatus', () => getTtsStatus());
  ipcMain.handle('pet:setTtsApiKey', (_e, key) => setTtsApiKey(key));
  // 对话（LLM）的 key 状态：同样只回掩码。
  ipcMain.handle('pet:getLlmStatus', () => getLlmStatus());
  ipcMain.handle('pet:setLlmApiKey', (_e, key) => setLlmApiKey(key));
  // 渲染层报告拖放上来的文件路径（路径本身由渲染层用 webUtils 取）。
  ipcMain.on('pet:droppedFile', (_e, filePath) => onDroppedFile(filePath));
}
