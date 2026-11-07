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

  // 窗口模式选的是窗口、其余模式选的是显示器：各记各的。
  const selectedId = config.mode === 'window' ? config.windowId : config.sourceId;

  if (targets.length) {
    blocks.push(
      ui.listBlock(
        targets.map((t) => ({
          id: t.id,
          // 动作名要**自己指定**：默认会用条目的 id 当动作名，
          // 而条目的 id 是系统的源 id（`window:1234:0` 这种），
          // 跟插件自己的动作名混在一起迟早认错。
          actionId: 'select-target',
          label: t.label,
          // 选中的那个标出来：不然用户不知道这次会录哪一块。
          hint: t.id === selectedId ? '● 已选' : t.hint || '',
        }))
      )
    );
  }

  blocks.push(ui.toggleBlock('mic', '录制麦克风', config.mic));
  blocks.push(ui.toggleBlock('speaker', '录制扬声器', config.speaker));

  if (config.format === 'gif') {
    // GIF 存不了声音——不说清楚，用户会以为录的时候哑了。
    blocks.push(ui.textBlock('GIF 存不了声音——切到 GIF 时不会录声音。'));
  }

  blocks.push(
    ui.buttonsBlock([
      { id: 'format:video', label: `${config.format === 'video' ? '●' : '○'} 视频` },
      { id: 'format:gif', label: `${config.format === 'gif' ? '●' : '○'} GIF` },
    ])
  );

  // **这里没有输出目录**：设置（输出目录、快捷键……）只在插件自己的页面里
  // （pages/studio.html 的抽屉）。主页面只管「录什么、怎么录」。
  //
  // 这一页是退路（页面文件不在磁盘上时宿主换用它），
  // 所以退到这里也就没有抽屉——界面简单一点，但不会白屏。

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
