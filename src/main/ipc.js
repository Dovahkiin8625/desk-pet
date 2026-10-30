import { ipcMain } from 'electron';

// 只注册渲染层实际用得到的通道；托盘/右键菜单的行为由主进程直接执行，不走 IPC。
export function registerIpc({
  getSettings,
  saveSettings,
  listModels,
  switchModel,
  onOpenSettings,
  onShowContextMenu,
}) {
  ipcMain.handle('pet:getSettings', () => getSettings());
  ipcMain.handle('pet:saveSettings', (_e, patch) => saveSettings(patch));
  ipcMain.handle('pet:listModels', () => listModels());
  ipcMain.handle('pet:switchModel', (_e, modelId) => switchModel(modelId));
  ipcMain.handle('pet:showContextMenu', () => onShowContextMenu());
  ipcMain.handle('pet:openSettings', () => onOpenSettings());
}
