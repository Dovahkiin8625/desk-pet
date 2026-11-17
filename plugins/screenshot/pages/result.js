// plugins/screenshot/pages/result.js
/**
 * 识别结果窗：把认出来的字摆着，能选中、能复制。
 */
(function () {
  const text = document.getElementById('text');
  const send = (message) => window.shot.send(message);

  document.getElementById('copy').addEventListener('click', () => send({ type: 'copy' }));
  document.getElementById('close').addEventListener('click', () => send({ type: 'close' }));

  window.shot.onMessage((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'text') text.textContent = message.text || '（没认出文字）';
  });
})();
