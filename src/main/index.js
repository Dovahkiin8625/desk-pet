import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';

if (process.env.DESK_PET_USER_DATA) {
  // setPath 要求目标目录已存在，否则会抛错。
  mkdirSync(process.env.DESK_PET_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.DESK_PET_USER_DATA);
}

if (!process.env.DESK_PET_E2E && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 300,
    height: 560,
    show: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // 注意：此时 src/preload/index.cjs 还不存在（Task 3 才创建），先不挂 preload
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 标题必须是 "Desk Pet"：本任务的冒烟测试会断言 window.title()
  win.loadURL(
    'data:text/html,<title>Desk Pet</title><body style="background:transparent">' +
      '<script>window.__pet={ready:true}</script></body>'
  );
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
