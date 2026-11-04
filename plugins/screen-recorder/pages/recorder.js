// plugins/screen-recorder/pages/recorder.js
/**
 * 捕获页。
 *
 * 这个页面是隐藏窗口里的真正干活的地方：
 * 取流 → 混音 → 编码 → 把字节交回主进程。
 *
 * 页面用 file:// 加载，所以这里的脚本是**经典脚本**，
 * 不能 import——web/ 下的公共逻辑用 <script src> 引进来。
 */
(function () {
  const G = globalThis.ScreenRecorderGeometry;
  const GIF = globalThis.ScreenRecorderGif;

  const state = {
    recorder: null,
    chunks: [],
    gifEncoder: null,
    canvas: null,
    canvasStream: null,
    drawTimer: null,
    video: null,
    stopped: false,
  };

  function report(type, payload) {
    window.rec.send({ type, payload });
  }

  /** 开始录制。 */
  async function begin(payload) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: Boolean(payload.audio?.speaker),
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('没拿到画面');
      state.video = stream;

      // 被录的窗口被关掉时，轨道会结束。
      // 这时候要**自动停止并保存已有内容**，而不是让录制一直挂着。
      videoTrack.addEventListener('ended', () => {
        report('ended', {});
        stop();
      });

      const settings = videoTrack.getSettings();
      const trackWidth = settings.width || 1280;
      const trackHeight = settings.height || 720;

      // 选区：把整屏流裁一块出来。
      let outputTrack = videoTrack;
      if (payload.crop && payload.snapshotSize) {
        const crop = G.scaleRect(payload.crop, payload.snapshotSize, {
          width: trackWidth,
          height: trackHeight,
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, crop.width);
        canvas.height = Math.max(2, crop.height);
        const ctx = canvas.getContext('2d');
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        const draw = () => {
          ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        };
        state.canvas = canvas;
        state.drawTimer = setInterval(draw, 1000 / (payload.fps || 30));
        draw();
        // captureStream 只能调一次：调两次会多出一条轨，白占一份带宽。
        state.canvasStream = canvas.captureStream(payload.fps || 30);
        outputTrack = state.canvasStream.getVideoTracks()[0];
      }

      const mime = pickMime();
      const recorder = new MediaRecorder(new MediaStream([outputTrack]), {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });
      state.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(state.chunks, { type: mime });
        blob.arrayBuffer().then((buffer) => {
          report('saved', { bytes: buffer, ext: 'mp4' });
        });
      };
      state.recorder = recorder;
      recorder.start(200);
    } catch (err) {
      report('error', { message: err?.message || String(err) });
    }
  }

  /** 挑一个浏览器支持的容器：优先 MP4（H.264 + AAC）。 */
  function pickMime() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  /** 停止。 */
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.drawTimer) clearInterval(state.drawTimer);
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    if (state.video) state.video.getTracks().forEach((t) => t.stop());
  }

  window.rec.onMessage(async (message) => {
    if (message.type === 'begin') {
      await begin(message.payload || {});
    } else if (message.type === 'stop') {
      stop();
    }
  });

  report('ready');
})();
