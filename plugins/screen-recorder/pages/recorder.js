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
    sourceVideo: null,
    audioContext: null,
    stopped: false,
    cancelled: false,
  };

  /** 等源的第一帧：没有帧就没有画面尺寸，也就没法开录。 */
  const SOURCE_TIMEOUT_MS = 15000;

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

      // GIF 走的是**完全不同的**一路：MediaRecorder 产不出 GIF，
      // 这里自己逐帧取像素、量化、编码。
      //
      // 这个分支要放在「选区裁剪」之前：GIF 自己管缩放与裁剪，
      // 别让前面的 canvas 裁剪把它处理两遍。
      if (payload.format === 'gif') {
        await beginGif(payload, stream);
        if (state.stopped) report('cancelled', {});
        return;
      }

      // 画面从哪儿来：直接用源，还是先过一块画布。
      let outputTrack = videoTrack;
      if (payload.crop && payload.snapshotSize) {
        // 选区：把整屏流裁一块出来。
        outputTrack = await startCropCanvas(payload, stream);
      } else if (payload.mode === 'window') {
        // 窗口：源会跟着窗口改尺寸，得先过一块固定大小的画布。
        outputTrack = await startWindowCanvas(payload, stream);
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
          // **后缀要跟着实际格式走**：容器不是 mp4 时还叫 .mp4，
          // 播放器按后缀猜格式就打不开了。
          reportSaved(buffer, mime.includes('mp4') ? 'mp4' : 'webm');
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
   * 打开源，并且拿到它的**真实画面尺寸**。
   *
   * **尺寸不能用 track.getSettings() 拿**：对窗口来说，那报的是
   * 「逻辑表面」的尺寸——实测一个 886×692 的窗口报的是 2560×1440，
   * 跟真正送来的帧根本不是一回事。拿它算比例，录出来是拉变形的。
   *
   * 真正送来的帧有多大，看 <video> 自己（videoWidth）。
   *
   * @param {MediaStream} stream
   * @returns {Promise<{video:HTMLVideoElement,size:() => {width:number,height:number}}>}
   */
  async function openSource(stream) {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    // 等第一帧：没有帧就不知道画面多大（也就没法定画布多大）。
    const deadline = Date.now() + SOURCE_TIMEOUT_MS;
    while (!video.videoWidth && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!video.videoWidth) throw new Error('等不到画面');
    state.sourceVideo = video;
    return {
      video,
      // 尺寸会变：窗口一改大小，送来的帧就换了个尺寸。
      size: () => ({ width: video.videoWidth, height: video.videoHeight }),
    };
  }

  /**
   * 选区：把整屏流裁一块出来，画到一块**固定大小**的画布上。
   *
   * 画布大小从头到尾不变，所以录出来的文件始终是用户框的那一块。
   *
   * @returns {Promise<MediaStreamTrack>} 画布那条轨（录它，别录源）
   */
  async function startCropCanvas(payload, stream) {
    const source = await openSource(stream);
    const fps = payload.fps || 30;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // 裁剪块按**当前**的画面尺寸算：屏幕换了分辨率，框的那块也跟着换算。
    const cropOf = (size) => G.scaleRect(payload.crop, payload.snapshotSize, size);
    const first = cropOf(source.size());
    canvas.width = Math.max(2, first.width);
    canvas.height = Math.max(2, first.height);

    const draw = () => {
      const crop = cropOf(source.size());
      const fit = G.fitContain(crop, { width: canvas.width, height: canvas.height });
      ctx.drawImage(
        source.video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        fit.x,
        fit.y,
        fit.width,
        fit.height
      );
    };

    state.canvas = canvas;
    state.drawTimer = setInterval(draw, 1000 / fps);
    draw();
    // captureStream 只能调一次：调两次会多出一条轨，白占一份带宽。
    state.canvasStream = canvas.captureStream(fps);
    return state.canvasStream.getVideoTracks()[0];
  }

  /**
   * 窗口模式：先把画面画到一块**固定大小**的画布上，再录画布。
   *
   * **为什么不能直接录源**：窗口一改尺寸，源送来的帧就换了个大小，
   * 而 Chromium 的 MediaRecorder 处理不了「录到一半画面变了尺寸」——
   * 容器里记的还是开头那个分辨率，后面的帧全成了灰的
   * （实测 886×692 的窗口录成 486×392，ffmpeg 解出来一堆解码错误，
   * 浏览器里放出来是一块死灰）。
   *
   * 所以画布的大小从头到尾不变：窗口改了尺寸，就把新画面缩放适配
   * 进画布（比例不变，多出来的留黑边）。跟 OBS 一个路子——
   * 画布多大，录出来就多大。
   *
   * @returns {Promise<MediaStreamTrack>} 画布那条轨（录它，别录源）
   */
  async function startWindowCanvas(payload, stream) {
    const source = await openSource(stream);
    const fps = payload.fps || 30;
    const start = source.size();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, start.width);
    canvas.height = Math.max(2, start.height);
    const ctx = canvas.getContext('2d');

    const draw = () => {
      const size = source.size();
      const fit = G.fitContain(size, { width: canvas.width, height: canvas.height });
      // 缩放适配会留边，边上补黑：留透明的话编码出来是花的。
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        source.video,
        0,
        0,
        size.width,
        size.height,
        fit.x,
        fit.y,
        fit.width,
        fit.height
      );
    };

    state.canvas = canvas;
    state.drawTimer = setInterval(draw, 1000 / fps);
    draw();
    // captureStream 只能调一次：调两次会多出一条轨，白占一份带宽。
    state.canvasStream = canvas.captureStream(fps);
    return state.canvasStream.getVideoTracks()[0];
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
   *
   * @param {object} payload
   * @param {MediaStream} stream
   */
  async function beginGif(payload, stream) {
    const source = await openSource(stream);

    // 裁剪块要先算出来：目标尺寸要按**裁剪后**的比例算，
    // 按整条轨的比例算的话，选区会被拉变形。
    //
    // 每一帧都重算：屏幕（或者被录的窗口）改了尺寸，
    // 框的那一块在画面里的位置也跟着变了。
    const cropOf = (size) =>
      payload.crop && payload.snapshotSize
        ? G.scaleRect(payload.crop, payload.snapshotSize, size)
        : null;
    const first = source.size();
    const firstCrop = cropOf(first);
    const sourceWidth = firstCrop ? firstCrop.width : first.width;
    const sourceHeight = firstCrop ? firstCrop.height : first.height;

    // 目标尺寸：宽度不超过配置值，高度按比例。
    const targetWidth = Math.max(2, Math.min(payload.gif?.width || 480, sourceWidth));
    const targetHeight = Math.max(2, Math.round((targetWidth * sourceHeight) / sourceWidth));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const encoder = new GIF.GifEncoder({ width: targetWidth, height: targetHeight });
    state.gifEncoder = encoder;

    const frameMs = Math.round(1000 / (payload.gif?.fps || 12));
    state.drawTimer = setInterval(() => {
      const size = source.size();
      const crop = cropOf(size);
      const region = crop || { x: 0, y: 0, width: size.width, height: size.height };
      const fit = G.fitContain(region, { width: targetWidth, height: targetHeight });
      ctx.drawImage(
        source.video,
        region.x,
        region.y,
        region.width,
        region.height,
        fit.x,
        fit.y,
        fit.width,
        fit.height
      );
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
    // 那个 <video> 也要停：捕获页是**复用**的，
    // 不停的话解码器一直占着，下一段录制才开始解码。
    if (state.sourceVideo) {
      state.sourceVideo.pause();
      state.sourceVideo.srcObject = null;
      state.sourceVideo = null;
    }
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
