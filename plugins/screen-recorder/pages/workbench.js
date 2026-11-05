// plugins/screen-recorder/pages/workbench.js
/**
 * 工作台：设置与快捷键。
 *
 * 快捷键的「录制」是**在这个页面里捕获按键**：
 * 页面拿到 keydown，翻译成 Electron 的快捷键写法，发给主进程注册。
 */
(function () {
  const outputDir = document.getElementById('outputDir');
  const hotkey = document.getElementById('hotkey');
  const fps = document.getElementById('fps');
  const gifWidth = document.getElementById('gifWidth');
  const status = document.getElementById('status');
  const hotkeyError = document.getElementById('hotkeyError');

  let recording = false;

  /** 按键 → Electron 的快捷键写法。 */
  function toAccelerator(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');
    const code = event.code || '';
    let key = '';
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F[0-9]{1,2}$/.test(code)) key = code;
    else if (code === 'Space') key = 'Space';
    else if (code === 'Enter') key = 'Return';
    else if (code === 'Escape') key = 'Escape';
    else if (code === 'Backspace') key = 'Backspace';
    else if (code.startsWith('Arrow')) {
      key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[code] || '';
    }
    if (!key) return '';
    // 裸键会劫持所有的字母键，不要。
    if (!parts.length) return '';
    return [...parts, key].join('+');
  }

  document.getElementById('recordHotkey').addEventListener('click', () => {
    hotkey.value = '按下新的组合键…';
    hotkeyError.textContent = '';
    recording = true;
  });

  document.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      recording = false;
      hotkey.value = '';
      return;
    }
    const accel = toAccelerator(event);
    if (!accel) return;
    recording = false;
    hotkey.value = accel;
    window.rec.send({ type: 'hotkey', payload: { accel } });
  });

  document.getElementById('pickDir').addEventListener('click', () => {
    window.rec.send({ type: 'workbench-pick-dir' });
  });

  document.getElementById('openDir').addEventListener('click', () => {
    window.rec.send({ type: 'workbench-open-dir' });
  });

  function commit() {
    window.rec.send({
      type: 'workbench-set',
      payload: {
        outputDir: outputDir.value.trim(),
        fps: Number(fps.value),
        gifWidth: Number(gifWidth.value),
      },
    });
  }
  outputDir.addEventListener('change', commit);
  fps.addEventListener('change', commit);
  gifWidth.addEventListener('change', commit);

  window.rec.onMessage((message) => {
    if (message.type !== 'workbench') return;
    const payload = message.payload || {};
    const config = payload.config || {};
    if (document.activeElement !== outputDir) outputDir.value = config.outputDir || '';
    if (document.activeElement !== hotkey) hotkey.value = config.hotkey || '';
    if (document.activeElement !== fps) fps.value = String(config.fps ?? 30);
    if (document.activeElement !== gifWidth) gifWidth.value = String(config.gifWidth ?? 480);
    hotkeyError.textContent = payload.hotkeyError || '';
    status.textContent = payload.status || '';
  });
})();
