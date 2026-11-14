// test/unit/media-toolbox-export-graph.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportArgs, REF_WIDTH, REF_HEIGHT } from '../../plugins/media-toolbox/lib/export-graph.js';

/** 造一个最小可用的项目：一个视频素材 + 一段视频片段。 */
function makeProject(overrides = {}) {
  return {
    name: '测试',
    inPoint: null,
    outPoint: null,
    assets: [
      { id: 'v1', path: 'D:\\media\\a.mp4', kind: 'video', duration: 10, width: 1280, height: 720, hasAudio: true, fps: 30 },
      { id: 'img', path: 'D:\\media\\b.png', kind: 'image', duration: 5, width: 800, height: 600, hasAudio: false },
      { id: 'au1', path: 'D:\\media\\c.mp3', kind: 'audio', duration: 20, width: 0, height: 0, hasAudio: true },
    ],
    tracks: [
      {
        id: 't1', kind: 'video', name: '视频轨道 1', muted: false, locked: false,
        clips: [
          {
            id: 'c1', assetId: 'v1', start: 0, duration: 5, sourceIn: 2, speed: 1.5,
            volume: 0.8, fadeIn: 0.5, fadeOut: 0,
            transform: { x: 100, y: -50, scale: 0.5, rotation: 30, opacity: 0.7 },
            crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
          },
        ],
      },
      {
        id: 't2', kind: 'audio', name: '音频轨道 1', muted: false, locked: false,
        clips: [
          {
            id: 'c2', assetId: 'au1', start: 1, duration: 8, sourceIn: 0, speed: 2,
            volume: 1, fadeIn: 0, fadeOut: 1,
            transform: {}, crop: {},
          },
        ],
      },
      {
        id: 't3', kind: 'subtitle', name: '字幕轨道 1', muted: false, locked: false,
        clips: [
          {
            id: 'c3', assetId: null, start: 0.5, duration: 3, sourceIn: 0, speed: 1,
            volume: 1, fadeIn: 0, fadeOut: 0, transform: {}, crop: {},
            text: "你好: 世界 100%", font: 'Microsoft YaHei', fontSize: 64, color: '#FFFFFF', x: 300, y: 800,
          },
        ],
      },
    ],
    ...overrides,
  };
}

const OPTIONS = { width: 1920, height: 1080, fps: 30, videoBitrate: '8M', audioBitrate: '192k', sampleRate: 48000, channels: 2, range: 'all' };

test('空时间线报错', () => {
  const project = makeProject({ tracks: [] });
  assert.throws(() => buildExportArgs(project, OPTIONS, 'out.mp4'), /时间线是空的/);
});

test('全部范围导出：输入都进了命令行', () => {
  const { args, duration, range } = buildExportArgs(makeProject(), OPTIONS, 'out.mp4');
  assert.equal(range.start, 0);
  assert.equal(duration, 9); // 音频片段 1 + 8 = 9 秒，比视频的 5 秒长
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('D:\\media\\a.mp4'));
  assert.ok(args.includes('D:\\media\\c.mp3'));
  assert.ok(!args.includes('D:\\media\\b.png'), '没用到的素材不进输入');
  assert.ok(args[args.length - 1] === 'out.mp4');
});

test('变速：视频 setpts 除以速度、音频 atempo 链不超过 2 倍一段', () => {
  const { args } = buildExportArgs(makeProject(), OPTIONS, 'out.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /setpts=\(PTS-STARTPTS\)\/1\.5/);
  // 音频 2 倍速：atempo=2.0 一段即可
  assert.match(graph, /atempo=2(\.0)?/);
});

test('atempo 链：0.25 倍拆成 0.5 + 0.5', () => {
  const project = makeProject();
  project.tracks[1].clips[0].speed = 0.25;
  const { args } = buildExportArgs(project, OPTIONS, 'out.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /atempo=0\.5,atempo=0\.5/);
});

test('变换与裁切进了 filter（crop / scale / rotate / colorchannelmixer）', () => {
  const { args } = buildExportArgs(makeProject(), OPTIONS, 'out.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /crop=/);
  assert.match(graph, /scale=/);
  assert.match(graph, /rotate=/);
  assert.match(graph, /colorchannelmixer=aa=0\.7/);
  assert.match(graph, /overlay=/);
});

test('淡入淡出：视频 alpha fade、音频 afade', () => {
  const { args } = buildExportArgs(makeProject(), OPTIONS, 'out.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /fade=t=in:st=0:d=0\.5:alpha=1/);
  assert.match(graph, /afade=t=out:st=7:d=1/);
});

test('字幕：drawtext，文本里的冒号被转义进引号', () => {
  const { args } = buildExportArgs(makeProject(), OPTIONS, 'out.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /drawtext=/);
  assert.match(graph, /text='你好: 世界 100\\%'/);
  assert.match(graph, /enable='between\(t,0\.5,3\.5\)'/);
});

test('入出点范围：trim 截到范围，输出时长跟着变', () => {
  const project = makeProject({ inPoint: 2, outPoint: 6 });
  const { args, duration, range } = buildExportArgs(project, { ...OPTIONS, range: 'in-out' }, 'out.mp4');
  assert.deepEqual(range, { start: 2, end: 6 });
  assert.equal(duration, 4);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /trim=start=2:end=6,setpts=PTS-STARTPTS/);
  assert.match(graph, /atrim=start=2:end=6/);
});

test('入点不在出点之前：报错', () => {
  const project = makeProject({ inPoint: 6, outPoint: 2 });
  assert.throws(() => buildExportArgs(project, { ...OPTIONS, range: 'in-out' }, 'out.mp4'), /入点要在出点之前/);
});

test('静音轨道不进合成', () => {
  const project = makeProject();
  project.tracks[1].muted = true;
  const { args } = buildExportArgs(project, OPTIONS, 'out.mp4');
  assert.ok(!args.includes('D:\\media\\c.mp3'));
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.doesNotMatch(graph, /amix/);
});

test('图片素材按 -loop 1 进输入', () => {
  const project = makeProject();
  project.tracks[0].clips.push({
    id: 'c9', assetId: 'img', start: 5, duration: 3, sourceIn: 0, speed: 1,
    volume: 1, fadeIn: 0, fadeOut: 0, transform: {}, crop: {},
  });
  const { args } = buildExportArgs(project, OPTIONS, 'out.mp4');
  const imgIdx = args.indexOf('D:\\media\\b.png');
  const loopIdx = args.lastIndexOf('-loop', imgIdx);
  assert.ok(loopIdx !== -1 && loopIdx < imgIdx);
});

test('参考系常量：1920×1080', () => {
  assert.equal(REF_WIDTH, 1920);
  assert.equal(REF_HEIGHT, 1080);
});
