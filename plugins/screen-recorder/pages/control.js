// plugins/screen-recorder/pages/control.js
/**
 * 悬浮控制条：计时 + 停止。
 *
 * 录屏的时候用户往往找不到桌宠在哪——控制条是置顶的，
 * 一直看得见，才知道「还在录」以及「怎么停」。
 */
(function () {
  const time = document.getElementById('time');

  function format(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  document.getElementById('stop').addEventListener('click', () => {
    window.rec.send({ type: 'stop' });
  });

  window.rec.onMessage((message) => {
    if (message.type !== 'state') return;
    const payload = message.payload || {};
    time.textContent = format(payload.elapsedMs || 0);
  });
})();
