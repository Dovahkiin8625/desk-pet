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
    audioContext: null,
    stopped: false,
    cancelled: false,
  };

  function report(type, payload) {
    window.rec.send({ type, payload });
  }

  /** 开始录制。 */
  async function begin(payload) {
    try {
      // 捕获窗是复用的：上一段录完时这个页面还在，
      // 所以这里要把「已经停了」「已经取消」的标记清掉。
      state.stopped = false;
      state.cancelled = false;
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

      // GIF 走的是**完全不同的**一路：MediaRecorder 产不出 GIF，
      // 这里自己逐帧取像素、量化、编码。
      //
      // 这个分支要放在「选区裁剪」之前：GIF 自己管缩放与裁剪，
      // 别让前面的 canvas 裁剪把它处理两遍。
      if (payload.format === 'gif') {
        await beginGif(payload, stream, videoTrack);
        if (state.stopped) report('cancelled', {});
        return;
      }

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
      // 声音：系统声音（loopback）由主进程的 handler 给，麦克风自己取。
      const audioTracks = [];
      if (payload.audio?.speaker) {
        const systemTrack = stream.getAudioTracks()[0];
        if (systemTrack) audioTracks.push(systemTrack);
      }
      let micTrack = null;
      if (payload.audio?.mic) {
        try {
          micTrack = await openMic(payload.audio?.micDeviceIndex);
        } catch (err) {
          // 没有麦克风 / 用户不给权限：说清楚，别静默录不到声音。
          report('error', { message: `没有拿到麦克风：${err?.message || err}`, soft: true });
        }
      }

      let audioTrack = null;
      if (audioTracks.length && micTrack) {
        // 两边都要：进同一个混音口，录出来就是一条音轨。
        const context = new AudioContext();
        state.audioContext = context;
        const destination = context.createMediaStreamDestination();
        context.createMediaStreamSource(new MediaStream(audioTracks)).connect(destination);
        context.createMediaStreamSource(new MediaStream([micTrack])).connect(destination);
        audioTrack = destination.stream.getAudioTracks()[0] || null;
      } else if (audioTracks.length) {
        // 只有系统声音：直接用它的轨，不用开混音口。
        audioTrack = audioTracks[0];
      } else if (micTrack) {
        audioTrack = micTrack;
      }

      const tracks = [outputTrack];
      if (audioTrack) tracks.push(audioTrack);
      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });
      state.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.chunks.push(event.data);
      };
      recorder.onstop = () => {
        // 用户喊停的：什么都没录到，别存一个空文件出来。
        if (state.cancelled) return;
        const blob = new Blob(state.chunks, { type: mime });
        blob.arrayBuffer().then((buffer) => {
          reportSaved(buffer, 'mp4');
        });
        // 音频上下文在录器真的停下来之后再关：提前关会把最后一段声音切掉。
        closeAudio();
      };
      state.recorder = recorder;
      recorder.start(200);

      // **用户可能在「开始」还没走完时就喊停了**：
      // 这时候录器刚建好、还没录到东西，就别留下一个停不下来的录制。
      if (state.stopped) {
        state.cancelled = true;
        recorder.stop();
        report('cancelled', {});
      }
    } catch (err) {
      report('error', { message: err?.message || String(err) });
    }
  }

  /**
   * 打开用户选的那个麦克风。
   *
   * 配置里存的是**序号**（第几个麦克风），不是设备 id：
   * 设备 id 是**按来源**给的——面板里的 id 与这个隐藏页（file://）
   * 看到的不是同一个，拿面板那个 id 来这里用一定匹配不上。
   * 序号两边是同一套顺序，所以在这里换成自己的 deviceId。
   *
   * 指定的设备要是没了（拔了、换了机器）：退回系统默认，
   * 别让整段录制失败。
   *
   * @param {number} [index] 第几个麦克风
   * @returns {Promise<MediaStreamTrack|null>}
   */
  async function openMic(index) {
    let deviceId = '';
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const wanted = inputs[Number(index) || 0];
      deviceId = wanted?.deviceId || '';
    } catch {
      deviceId = '';
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      return mic.getAudioTracks()[0] || null;
    } catch (err) {
      if (!deviceId) throw err;
      // 指定的那个设备用不了了：退回到系统默认。
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      return mic.getAudioTracks()[0] || null;
    }
  }

  /**
   * GIF 模式。
   *
   * 走的是**完全不同的**一路：MediaRecorder 产不出 GIF，
   * 所以这里自己逐帧取像素、量化、编码（web/gif.js）。
   *
   * GIF 没有音频——格式本身不支持，界面上要写明。
   */
  async function beginGif(payload, stream, videoTrack) {
    const settings = videoTrack.getSettings();
    const trackWidth = settings.width || 1280;
    const trackHeight = settings.height || 720;

    // 裁剪块要先算出来：目标尺寸要按**裁剪后**的比例算，
    // 按整条轨的比例算的话，选区会被拉变形。
    let crop = null;
    if (payload.crop && payload.snapshotSize) {
      crop = G.scaleRect(payload.crop, payload.snapshotSize, {
        width: trackWidth,
        height: trackHeight,
      });
    }
    const sourceWidth = crop ? crop.width : trackWidth;
    const sourceHeight = crop ? crop.height : trackHeight;

    // 目标尺寸：宽度不超过配置值，高度按比例。
    const targetWidth = Math.max(2, Math.min(payload.gif?.width || 480, sourceWidth));
    const targetHeight = Math.max(2, Math.round((targetWidth * sourceHeight) / sourceWidth));

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const encoder = new GIF.GifEncoder({ width: targetWidth, height: targetHeight });
    state.gifEncoder = encoder;

    const frameMs = Math.round(1000 / (payload.gif?.fps || 12));
    state.drawTimer = setInterval(() => {
      if (crop) {
        ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, targetWidth, targetHeight);
      } else {
        ctx.drawImage(video, 0, 0, trackWidth, trackHeight, 0, 0, targetWidth, targetHeight);
      }
      const image = ctx.getImageData(0, 0, targetWidth, targetHeight);
      encoder.addFrame(image.data, frameMs);
    }, frameMs);

    // 用户在取流的路上喊停了：别留下一个停不下来的 GIF 录制。
    if (state.stopped) {
      clearInterval(state.drawTimer);
      state.drawTimer = null;
      state.gifEncoder = null;
      report('cancelled', {});
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

  /** 关掉音频上下文（不关的话它一直占着音频服务）。 */
  function closeAudio() {
    if (!state.audioContext) return;
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }

  /** 停止。 */
  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    if (state.drawTimer) clearInterval(state.drawTimer);
    if (state.gifEncoder) {
      // GIF 是自己一帧一帧攒出来的，停下来就把攒好的字节交回去。
      const bytes = state.gifEncoder.bytes();
      state.gifEncoder = null;
      reportSaved(bytes.buffer, 'gif');
    }
    if (state.recorder) {
      if (state.recorder.state !== 'inactive') state.recorder.stop();
    } else {
      // 录器还没建好（正在取流）：begin() 那边会看到 stopped 标记，
      // 自己收手——不然就留下一个停不下来的录制。
      state.pendingStop = true;
    }
    if (state.video) state.video.getTracks().forEach((t) => t.stop());
    // canvas 裁剪那条轨也要停：它不是源轨的附属，源轨停了它不一定停。
    if (state.canvasStream) {
      state.canvasStream.getTracks().forEach((t) => t.stop());
      state.canvasStream = null;
    }
    closeAudio();
  }

  /**
   * 停完之后，等一下再把结果交回去。
   *
   * 屏幕捕获会话的收尾是**异步**的：轨道停了之后它还要一会儿才真正松手。
   * 给它留点时间，文件落盘时它就已经收得差不多了。
   */
  const SETTLE_MS = 800;

  /** 交结果之前先等捕获会话松手。 */
  function reportSaved(bytes, ext) {
    setTimeout(() => report('saved', { bytes, ext }), SETTLE_MS);
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
