// 「别的声音在不在响」的判定：切 clip 时按它决定 sound:true 的原声要不要折半。
//
// 三种声音都算数：
//   1. 音乐插件在放歌（主进程推过来的布尔值）；
//   2. 桌宠在说话；
//   3. 一声提示音还没收完。
//
// 第 3 条不指望任何计数器：按「这一声预计会响到什么时刻」算，
// 等那个时刻过去自然失效。
import test from 'node:test';
import assert from 'node:assert/strict';

// 给 blip 用的假 WebAudio：只实现它真正摸到的东西。
class FakeParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class FakeNode {
  connect() {
    return this;
  }
}
class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.type = '';
    this.frequency = new FakeParam();
  }
  start() {}
  stop() {}
}
class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeParam();
  }
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  resume() {
    return Promise.resolve();
  }
  createGain() {
    return new FakeGain();
  }
  createOscillator() {
    return new FakeOscillator();
  }
}
globalThis.window = { AudioContext: FakeAudioContext };

// window 必须先立住再 import：audio.js 顶层不碰 window，但顺序稳妥一些。
const { playTap, setMusicPlaying, isOtherAudioActive } = await import('../../src/renderer/pet/audio.js');

test('默认：别的声音都不响', () => {
  assert.equal(isOtherAudioActive(), false);
});

test('音乐在放：算别的声音在响', () => {
  setMusicPlaying(true);
  assert.equal(isOtherAudioActive(), true);
  setMusicPlaying(false);
  assert.equal(isOtherAudioActive(), false);
});

test('提示音刚响完没多久也算在响；过了之后自己恢复', async () => {
  setMusicPlaying(false);
  playTap();
  assert.equal(isOtherAudioActive(), true);
  // 提示音最长约 0.15 秒：多等一会儿肯定过了。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(isOtherAudioActive(), false);
});
