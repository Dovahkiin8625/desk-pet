// plugins/music-player/lib/tools.js
import { formatTime } from './format.js';

/**
 * 给 agent 用的工具。
 *
 * 清单里**声明**、这里**实现**，两边必须同名——对不上那个工具就不注册
 * （宿主宽容得很：一个工具有问题不该把整个插件拖垮）。
 *
 * 报错要**抛出去**：错误会喂回模型，模型能换个参数再试。
 */
export function createTools(player) {
  /** 每个工具开跑前先把曲库备好。 */
  const ready = () => player.ensureStarted();

  return [
    {
      name: 'music.play',
      async run(args) {
        await ready();
        const r = await player.playMatch(args?.song);
        if (!r?.ok) throw new Error(r?.message || '放不了');
        const s = player.snapshot();
        return {
          text: r.message,
          data: { title: s.current?.title || '', artist: s.current?.artist || '' },
        };
      },
    },
    {
      name: 'music.pause',
      async run() {
        await ready();
        const r = player.pause();
        if (!r?.ok) throw new Error(r?.message || '暂停不了');
        return { text: r.message, data: {} };
      },
    },
    {
      name: 'music.next',
      async run() {
        await ready();
        const r = await player.next();
        if (!r?.ok) throw new Error(r?.message || '切不了');
        const s = player.snapshot();
        return { text: r.message, data: { title: s.current?.title || '' } };
      },
    },
    {
      name: 'music.prev',
      async run() {
        await ready();
        const r = await player.prev();
        if (!r?.ok) throw new Error(r?.message || '切不了');
        const s = player.snapshot();
        return { text: r.message, data: { title: s.current?.title || '' } };
      },
    },
    {
      name: 'music.search',
      async run(args) {
        await ready();
        const song = String(args?.song || '').trim();
        if (!song) throw new Error('找哪首歌？给个 song');
        const found = player.search(song);
        const s = player.snapshot();
        const text = found.length
          ? found.map((t) => (t.artist ? `${t.title} — ${t.artist}` : t.title)).join('；')
          : `曲库里没有「${song}」`;
        return {
          text: `曲库里一共 ${s.trackCount} 首。${text}`,
          data: { found },
        };
      },
    },
    {
      name: 'music.status',
      async run() {
        await ready();
        const s = player.snapshot();
        const cur = s.current
          ? `《${s.current.title}》${s.current.artist ? ` — ${s.current.artist}` : ''}`
          : '还没在放';
        const text = `${cur}，${formatTime(s.position)} / ${formatTime(s.duration)}，${
          s.playing ? '在放' : '暂停了'
        }。音量 ${Math.round(s.volume * 100)}，曲库里 ${s.trackCount} 首，${s.modeLabel}。`;
        return {
          text,
          data: {
            playing: s.playing,
            position: s.position,
            duration: s.duration,
            trackCount: s.trackCount,
            volume: s.volume,
            mode: s.mode,
          },
        };
      },
    },
    {
      name: 'music.lyrics',
      async run(args) {
        await ready();
        const on = args?.enabled === true || args?.enabled === 'true';
        const r = await player.setLyrics(on);
        return { text: r.message, data: { enabled: on } };
      },
    },
  ];
}
