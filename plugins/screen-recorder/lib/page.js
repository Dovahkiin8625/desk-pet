// plugins/screen-recorder/lib/page.js

/**
 * 面板页面的拼装。
 *
 * 插件界面是**无状态**的：动作 → 重算一次页面 → 新的页面。
 * 这样只有一份「我现在长什么样」的代码，不会出现「改了数据但界面没跟着变」。
 */

export const MODE_LABELS = Object.freeze({ screen: '全屏', region: '选区', window: '窗口' });

/** 模式按钮：当前模式前面加个 ●，其余是 ○。 */
function modeButtons(ui, mode) {
  return ui.buttonsBlock(
    Object.keys(MODE_LABELS).map((key) => ({
      id: `mode:${key}`,
      label: `${mode === key ? '●' : '○'} ${MODE_LABELS[key]}`,
    }))
  );
}

/**
 * 拼出面板页面。
 *
 * @param {object} ui 宿主给的界面积木（ctx.ui）
 * @param {object} data
 * @param {object} data.config 当前配置
 * @param {Array<{id:string,label:string,hint?:string}>} data.targets 可录的目标（显示器/窗口）
 * @param {boolean} data.recording 正在录吗
 * @param {string} data.status 底部那行提示
 */
export function buildPanelPage(ui, data) {
  const { config, targets = [], recording = false, status = '' } = data;
  const blocks = [];

  blocks.push(modeButtons(ui, config.mode));

  if (targets.length) {
    blocks.push(ui.listBlock(targets.map((t) => ({ id: t.id, label: t.label, hint: t.hint || '' }))));
  }

  blocks.push(ui.toggleBlock('mic', '录制麦克风', config.mic));
  blocks.push(ui.toggleBlock('speaker', '录制扬声器', config.speaker));

  blocks.push(
    ui.buttonsBlock([
      { id: 'format:video', label: `${config.format === 'video' ? '●' : '○'} 视频` },
      { id: 'format:gif', label: `${config.format === 'gif' ? '●' : '○'} GIF` },
    ])
  );

  blocks.push(ui.inputBlock('outputDir', '输出目录（留空＝视频文件夹）', '保存', config.outputDir));

  blocks.push(
    ui.buttonsBlock([
      { id: 'pick-dir', label: '浏览…' },
      { id: 'open-workbench', label: '设置…' },
    ])
  );

  blocks.push(
    ui.buttonsBlock([
      recording
        ? { id: 'stop', label: '停止录制', primary: true }
        : { id: 'start', label: '开始录制', primary: true },
    ])
  );

  return ui.makePage({
    pluginId: 'screen-recorder',
    title: '录屏',
    subtitle: recording ? '正在录制' : MODE_LABELS[config.mode],
    status,
    blocks,
  });
}
