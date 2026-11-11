// plugins/music-player/pages/engine.js
/**
 * 播放引擎：一个 `<audio>` 元素，主进程通过 mp 桥发命令。
 *
 * 这个页面藏在看不见的窗口里——它只管放声音，
 * 别的（画界面、找歌、歌词）都在主进程那边。
 */
const audio = document.getElementById('audio');

/** 报给主进程一句话。 */
function report(payload) {
  window.mp.send({ role: 'engine', ...payload });
}

audio.addEventListener('loadedmetadata', () => {
  report({ type: 'time', current: audio.currentTime, duration: audio.duration || 0 });
});

audio.addEventListener('timeupdate', () => {
  report({ type: 'time', current: audio.currentTime, duration: audio.duration || 0 });
});

audio.addEventListener('play', () => report({ type: 'state', playing: true }));
audio.addEventListener('pause', () => report({ type: 'state', playing: false }));
audio.addEventListener('ended', () => report({ type: 'ended' }));

audio.addEventListener('error', () => {
  const code = audio.error?.code;
  const why = code === 3 ? '这个文件解不了' : code === 4 ? '这个文件找不到' : '这个文件放不了';
  report({ type: 'error', message: why });
});

window.mp.onMessage((message) => {
  if (message?.type !== 'cmd') return;
  switch (message.cmd) {
    case 'load':
      audio.src = message.url;
      audio.load();
      break;
    case 'play':
      audio.play().catch((err) => {
        // 换歌的时候打断上一首是常事：那种拒绝不算错。
        if (err?.name === 'AbortError') return;
        report({ type: 'error', message: err?.message || '放不了' });
      });
      break;
    case 'pause':
      audio.pause();
      break;
    case 'seek':
      audio.currentTime = Number(message.seconds) || 0;
      break;
    case 'volume':
      audio.volume = Number(message.value) || 0;
      break;
    default:
      break;
  }
});

report({ type: 'ready' });
