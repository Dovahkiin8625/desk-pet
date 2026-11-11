// plugins/music-player/main.js
import { formatTime } from './lib/format.js';
import { createPlayer } from './lib/player.js';
import { createTools } from './lib/tools.js';

/**
 * 音乐播放器。
 *
 * 三处界面，一份状态：
 *
 * - **面板 / 独立窗口**（`pages/player.html`）：曲库、进度、音量；
 * - **桌面小部件**（`pages/widget.html`）：挂在桌面上的迷你播放器；
 * - **桌面歌词**（`pages/lyrics.html`）：一直浮在桌面上的歌词。
 *
 * 前两处由宿主管（宿主推数据、页面送动作），歌词窗是插件自建的
 * ——宿主那套「一个插件一个窗口」容不下它。
 */
export default function createMusicPlayerPlugin(ctx) {
  const player = createPlayer({ ctx, pluginDir: ctx.plugin.dir });

  /** 界面上的一个动作。返回的 state 是完整的一份，界面照着画就行。 */
  async function runAction(actionId, payload = {}) {
    await player.ensureStarted();
    let r;
    switch (actionId) {
      case 'play':
        r = await player.play(payload.index);
        break;
      case 'pause':
        r = player.pause();
        break;
      case 'toggle':
        r = await player.toggle();
        break;
      case 'next':
        r = await player.next();
        break;
      case 'prev':
        r = await player.prev();
        break;
      case 'select':
        r = await player.play(payload.index);
        break;
      case 'seek':
        r = player.seek(payload.seconds);
        break;
      case 'volume':
        r = await player.setVolume(payload.value);
        break;
      case 'mode':
        r = await player.setMode(payload.value);
        break;
      case 'lyrics':
        // 声明式界面里那是个按钮（没有值）：那就反过来开关。
        r = await player.setLyrics(
          payload.enabled === undefined ? !player.snapshot().lyricsOpen : payload.enabled
        );
        break;
      case 'scan':
        r = await player.scan();
        break;
      case 'choose-folder':
        r = await player.chooseFolder();
        break;
      default:
        r = { ok: false, message: '不认识的作' };
    }
    return {
      ok: Boolean(r?.ok),
      message: String(r?.message || ''),
      state: player.snapshot(true),
    };
  }

  /** 声明式界面（页面文件不在时宿主退回的那一套）。 */
  function page(ctx2) {
    const s = player.snapshot(true);
    const blocks = [];
    if (!s.trackCount) {
      blocks.push(ctx2.ui.emptyBlock('还没有音乐库。点下面的「选择音乐文件夹」挑一个文件夹。'));
    } else {
      const cur = s.current;
      blocks.push(
        ctx2.ui.textBlock(
          cur ? `《${cur.title}》${cur.artist ? ` — ${cur.artist}` : ''}` : '还没在放'
        ),
        ctx2.ui.textBlock(
          `${formatTime(s.position)} / ${formatTime(s.duration)}${s.playing ? '' : '（暂停）'}`
        ),
        ctx2.ui.buttonsBlock([
          { id: 'prev', label: '⏮' },
          { id: 'toggle', label: s.playing ? '⏸' : '▶', primary: true },
          { id: 'next', label: '⏭' },
          { id: 'lyrics', label: s.lyricsOpen ? '关掉桌面歌词' : '桌面歌词' },
        ]),
        ctx2.ui.listBlock(
          s.tracks.slice(0, 100).map((t, i) => ({
            id: String(i),
            label: t.artist ? `${t.title} — ${t.artist}` : t.title,
            hint: i === s.index ? '在放' : '',
            actionId: 'select',
          }))
        )
      );
    }
    blocks.push(
      ctx2.ui.buttonsBlock([
        { id: 'choose-folder', label: '选择音乐文件夹' },
        { id: 'scan', label: '重新扫描' },
      ])
    );
    return ctx2.ui.makePage({
      pluginId: 'music-player',
      title: '音乐播放器',
      subtitle: s.folder || '还没有音乐库',
      status: s.status,
      blocks,
    });
  }

  return {
    /** 面板顶上那行字（要便宜，别在这儿干重活）。 */
    meta() {
      const s = player.snapshot();
      return {
        title: '音乐播放器',
        subtitle: s.current
          ? `《${s.current.title}》${s.current.artist ? ` — ${s.current.artist}` : ''}`
          : s.trackCount
            ? `曲库里 ${s.trackCount} 首`
            : '还没有音乐库',
      };
    },

    page,

    /** 打开时给的第一份（带整份曲库）。 */
    async data() {
      await player.ensureStarted();
      return player.snapshot(true);
    },

    /** 周期刷新（不带曲库：列表不变，不必每回都重发一遍）。 */
    async tick() {
      await player.ensureStarted();
      return player.snapshot(false);
    },

    /** 自带页面里的动作。 */
    act(ctx2, actionId, payload) {
      return runAction(actionId, payload || {});
    },

    /** 声明式界面里的动作。 */
    async action(ctx2, actionId, value) {
      const payload = actionId === 'select' ? { index: Number(value) } : {};
      const r = await runAction(actionId, payload);
      return { ...page(ctx2), status: r.message };
    },

    /**
     * 给 agent 用的工具。
     *
     * 清单里声明、这里实现，两边必须同名。
     */
    tools() {
      return createTools(player);
    },
  };
}
