// plugins/screenshot/pages/pinned.js
/**
 * 置顶窗：把截出来的那块留在桌面上，一直挂在最前。
 */
(function () {
  const img = document.getElementById('img');
  document.getElementById('close').addEventListener('click', () => {
    window.shot.send({ type: 'close' });
  });

  window.shot.onMessage((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'image') img.src = message.file;
  });
})();
