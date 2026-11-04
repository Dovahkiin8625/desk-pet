// plugins/screen-recorder/main.js
import { app, dialog } from 'electron';
import { readConfig, writeConfig } from './lib/config.js';
import { buildPanelPage } from './lib/page.js';

/**
 * 录屏插件。
 *
 * 插件跑在**主进程**里（宿主用动态 import 加载它），所以 electron 的 API
 * 直接就能用——这里没有沙箱，插件与宿主之间靠的是约定，不是权限边界。
 */
export default function createScreenRecorderPlugin(ctx) {
  /** 配置只在第一次用时读盘，之后走缓存。 */
  let config = null;
  /** 底部那行提示：做完某个动作的结果。 */
  let status = '';
  /** 可录的目标（显示器/窗口），随模式变。 */
  let targets = [];
  let recording = false;

  async function ensureConfig() {
    if (!config) config = await readConfig(app.getPath('userData'));
    return config;
  }

  async function save(next) {
    config = await writeConfig(app.getPath('userData'), { ...(await ensureConfig()), ...next });
    return config;
  }

  /** 面板页面。 */
  async function page() {
    const cfg = await ensureConfig();
    return buildPanelPage(ctx.ui, { config: cfg, targets, recording, status });
  }

  /** 面板里的一个动作。 */
  async function action(currentCtx, actionId, value) {
    const cfg = await ensureConfig();
    if (actionId.startsWith('mode:')) {
      const mode = actionId.slice('mode:'.length);
      await save({ mode });
      targets = [];
      status = '';
    } else if (actionId.startsWith('format:')) {
      await save({ format: actionId.slice('format:'.length) });
    } else if (actionId === 'mic') {
      await save({ mic: value === 'true' });
    } else if (actionId === 'speaker') {
      await save({ speaker: value === 'true' });
    } else if (actionId === 'outputDir') {
      const dir = String(value || '').trim();
      await save({ outputDir: dir });
      status = dir ? `输出目录：${dir}` : '输出目录：视频文件夹';
    } else if (actionId === 'pick-dir') {
      const picked = await pickDirectory();
      if (picked) {
        await save({ outputDir: picked });
        status = `输出目录：${picked}`;
      }
    } else {
      // 「开始录制」「停止录制」「设置…」在后面的任务里接上。
      status = '';
    }
    return page();
  }

  /** 选输出目录：原生对话框。 */
  async function pickDirectory() {
    const result = await dialog.showOpenDialog({
      title: '录屏文件放哪儿',
      defaultPath: (await ensureConfig()).outputDir || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return '';
    return result.filePaths[0];
  }

  return { page, action };
}
