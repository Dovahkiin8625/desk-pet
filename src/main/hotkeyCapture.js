/**
 * 快捷键录制的按键捕获。
 *
 * 单独成文件是为了能单测：这段接线在浏览器里按不出来
 * （Playwright 的合成按键不经过 webContents 的 before-input-event），
 * 而它是「全局快捷键」这个功能**唯一**的按键入口——
 * 没有测试的话，录制坏了没有任何东西会响。
 *
 * 这个文件**不得 import Electron**：本仓库的单元测试用 `node --test` 跑，
 * 没有 Electron 环境。
 */

/**
 * 造一个 before-input-event 的处理器。
 *
 * @param {object} controller 系统控制器（只需要 isRecording 与 handleInput）
 * @returns {(event: object, input: object) => void}
 */
export function makeHotkeyCapture(controller) {
  return (event, input) => {
    // 没在录制时**不**拦按键：设置窗口里别的输入框还要正常打字。
    if (!controller?.isRecording?.()) return;
    // 拦掉这次按键：不然它会漏进页面的输入框
    // （规格 §4.3②）。
    event.preventDefault();
    controller.handleInput(input);
  };
}
