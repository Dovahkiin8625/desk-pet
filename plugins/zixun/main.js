/**
 * 资讯：百度/微博/知乎/抖音的热搜榜 + 人民网/IT之家/少数派的 RSS 资讯。
 *
 * 两个接口族都免密钥，都带 User-Agent。新闻源是 RSS，只取 title/link/pubDate。
 * 小部件（widget.html）看当前选中的榜；面板/独立窗口用积木界面，也看同一个。
 */

const HOT_FEEDS = [
  { id: 'baidu', label: '百度' },
  { id: 'weibo', label: '微博' },
  { id: 'zhihu', label: '知乎' },
  { id: 'douyin', label: '抖音' },
];

const NEWS_FEEDS = [
  { id: 'people-politics', label: '时政', url: 'http://www.people.com.cn/rss/politics.xml' },
  { id: 'people-world', label: '国际', url: 'http://www.people.com.cn/rss/world.xml' },
  { id: 'people-finance', label: '财经', url: 'http://www.people.com.cn/rss/finance.xml' },
  { id: 'ithome', label: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { id: 'sspai', label: '少数派', url: 'https://sspai.com/feed' },
];

const FEEDS = [...HOT_FEEDS, ...NEWS_FEEDS];
const HOT_IDS = new Set(HOT_FEEDS.map((f) => f.id));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10000;
const CACHE_MS = 5 * 60 * 1000;
const ERROR_CACHE_MS = 60 * 1000;
const SHOW = 15;
const WIDGET_ITEMS = 8;

async function getRaw(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, headers) {
  return (await getRaw(url, headers)).json();
}

function hotText(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 1e8) return `${(num / 1e8).toFixed(1)}亿`;
  if (num >= 1e4) return `${(num / 1e4).toFixed(1)}万`;
  return String(num);
}

async function fetchBaidu() {
  const data = await getJson('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
    Referer: 'https://top.baidu.com/',
  });
  // 这个接口会按请求头返回不同结构：有的是 { data: { cards } }，有的是 { cards }
  const list = data?.data?.cards?.[0]?.content?.[0]?.content || data?.cards?.[0]?.content?.[0]?.content || [];
  return list
    .map((item) => ({
      title: String(item?.word || '').trim(),
      hint: String(item?.labelTagName || '').trim(),
      url:
        typeof item?.url === 'string' && item.url
          ? item.url
          : `https://www.baidu.com/s?wd=${encodeURIComponent(item?.word || '')}`,
    }))
    .filter((item) => item.title);
}

async function fetchWeibo() {
  const data = await getJson('https://weibo.com/ajax/side/hotSearch', {
    Referer: 'https://weibo.com/',
  });
  const list = data?.data?.realtime || [];
  return list
    .map((item) => {
      const word = String(item?.word || item?.note || '').trim();
      return {
        title: word,
        hint: hotText(item?.num),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(word)}`,
      };
    })
    .filter((item) => item.title);
}

async function fetchZhihu() {
  const data = await getJson('https://api.zhihu.com/topstory/hot-lists/total?limit=30', {
    Referer: 'https://www.zhihu.com/',
  });
  const list = data?.data || [];
  return list
    .map((item) => {
      const target = item?.target || {};
      const title = String(target.title || '').trim();
      const qid = String(item?.card_id || '').replace(/^Q_/, '');
      const url = /^\d+$/.test(qid)
        ? `https://www.zhihu.com/question/${qid}`
        : `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(title)}`;
      return { title, hint: String(item?.detail_text || '').trim(), url };
    })
    .filter((item) => item.title);
}

async function fetchDouyin() {
  const data = await getJson(
    'https://www.douyin.com/aweme/v1/web/hot/search/list/?detail_list=1&device_platform=webapp&aid=6383&channel=channel_pc_web',
    { Referer: 'https://www.douyin.com/' },
  );
  const list = data?.data?.word_list || [];
  return list
    .map((item) => {
      const word = String(item?.word || '').trim();
      return {
        title: word,
        hint: hotText(item?.hot_value),
        url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
      };
    })
    .filter((item) => item.title);
}

const HOT_FETCHERS = { baidu: fetchBaidu, weibo: fetchWeibo, zhihu: fetchZhihu, douyin: fetchDouyin };

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, '&');
}

function tagText(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!match) return '';
  let s = match[1].trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) s = cdata[1];
  return decodeEntities(s).replace(/<[^>]+>/g, '').trim();
}

function parseRss(xml) {
  const items = [];
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    const title = tagText(block, 'title');
    const link = tagText(block, 'link');
    const date = tagText(block, 'pubDate');
    if (title && link) items.push({ title, hint: date, url: link });
  }
  return items;
}

async function fetchNews(feed) {
  const xml = await (await getRaw(feed.url)).text();
  const items = parseRss(xml);
  if (!items.length) throw new Error('没解析出文章');
  return items;
}

async function fetchFeed(id) {
  if (HOT_IDS.has(id)) return HOT_FETCHERS[id]();
  const feed = NEWS_FEEDS.find((f) => f.id === id);
  if (!feed) throw new Error('未知的榜');
  return fetchNews(feed);
}

function feedLabel(id) {
  return FEEDS.find((f) => f.id === id)?.label || '资讯';
}

function fmtDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text; // 人民网只有日期
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openExternal(url) {
  try {
    const mod = await import('electron');
    const shell = mod?.shell || mod?.default?.shell;
    if (shell?.openExternal) {
      await shell.openExternal(url);
      return true;
    }
  } catch {
    // 面板外（单测）没有 Electron，打不开就算了
  }
  return false;
}

export default function createZixunPlugin() {
  let selected = 'baidu';
  /** @type {Map<string, { items: Array<{title: string, hint: string, url: string}>, at: number, error: string }>} */
  const caches = new Map();

  async function ensure(feed) {
    const hit = caches.get(feed);
    const ttl = hit?.error ? ERROR_CACHE_MS : CACHE_MS;
    if (hit && Date.now() - hit.at < ttl) return hit;
    try {
      const items = await fetchFeed(feed);
      const entry = { items, at: Date.now(), error: '' };
      caches.set(feed, entry);
      return entry;
    } catch (err) {
      const entry = {
        items: hit?.items || [],
        at: Date.now(),
        error: err?.message || String(err),
      };
      caches.set(feed, entry);
      return entry;
    }
  }

  const itemHint = (feed, item) => (HOT_IDS.has(feed) ? item.hint : fmtDate(item.hint));

  const snapshot = (limit = WIDGET_ITEMS) => {
    const entry = caches.get(selected);
    const items = (entry?.items || []).slice(0, limit).map((item) => ({
      title: item.title,
      hint: itemHint(selected, item),
      url: item.url,
    }));
    return {
      feed: selected,
      feeds: FEEDS,
      items,
      at: entry?.at || 0,
      error: entry?.error || '',
    };
  };

  const page = async (ctx) => {
    await ensure(selected);
    const entry = caches.get(selected);
    const items = (entry?.items || []).slice(0, SHOW);
    const status = entry?.error
      ? `暂时拉不到（${entry.error}）`
      : entry?.at
        ? `更新于 ${fmtTime(new Date(entry.at))}`
        : '';
    return ctx.ui.makePage({
      pluginId: 'zixun',
      title: '资讯',
      subtitle: `${feedLabel(selected)} · 榜上 ${items.length} 条`,
      blocks: [
        ctx.ui.buttonsBlock(
          FEEDS.map((f) => ({ id: `switch:${f.id}`, label: f.label, primary: f.id === selected })),
        ),
        items.length
          ? ctx.ui.listBlock(
              items.map((item, i) => ({
                id: item.url,
                label: HOT_IDS.has(selected) ? `${i + 1}. ${item.title}` : item.title,
                hint: itemHint(selected, item),
                actionId: 'open',
              })),
            )
          : ctx.ui.emptyBlock(entry?.error ? `暂时拉不到（${entry.error}）` : '暂时没有内容，点「刷新」再试'),
        ctx.ui.buttonsBlock([{ id: 'refresh', label: '刷新' }]),
      ],
      status,
    });
  };

  return {
    page,

    // 小部件看的就是这一份数据（widget.html 每 refreshMs 收一次 tick，
    // 打开时先拿一份 data）。
    async data() {
      await ensure(selected);
      return snapshot();
    },
    async tick() {
      await ensure(selected);
      return snapshot();
    },
    async act(ctx, actionId, payload) {
      if (actionId === 'feed') {
        const next = String(payload?.feed || '');
        if (FEEDS.some((f) => f.id === next)) selected = next;
        await ensure(selected);
        return snapshot();
      }
      if (actionId === 'refresh') {
        caches.delete(selected);
        await ensure(selected);
        return snapshot();
      }
      if (actionId === 'open') {
        const url = String(payload?.url || '');
        if (/^https?:\/\//.test(url)) await openExternal(url);
        return snapshot();
      }
      return snapshot();
    },

    async action(ctx, actionId, value) {
      if (typeof actionId === 'string' && actionId.startsWith('switch:')) {
        const next = actionId.slice('switch:'.length);
        if (FEEDS.some((f) => f.id === next)) selected = next;
        return page(ctx);
      }
      if (actionId === 'refresh') {
        caches.delete(selected);
        return page(ctx);
      }
      if (actionId === 'open') {
        const url = String(value || '');
        const ok = /^https?:\/\//.test(url) ? await openExternal(url) : false;
        return { ...(await page(ctx)), status: ok ? '已在浏览器打开' : '这个链接打不开' };
      }
      return page(ctx);
    },

    tools() {
      return [
        {
          name: 'zixun.hotsearch',
          async run({ platform }) {
            const id = String(platform || '').trim();
            if (!HOT_IDS.has(id)) {
              throw new Error('platform 取 baidu / weibo / zhihu / douyin');
            }
            let items;
            try {
              items = await HOT_FETCHERS[id]();
            } catch (err) {
              throw new Error(`${feedLabel(id)}热搜暂时查不到：${err?.message || err}`);
            }
            const top = items.slice(0, 10);
            const lines = top.map((item, i) => `${i + 1}. ${item.title}${item.hint ? `（${item.hint}）` : ''}`);
            return {
              text: `${feedLabel(id)}热搜（实时）：\n${lines.join('\n')}`,
              data: { platform: id, items: top },
            };
          },
        },
        {
          name: 'zixun.news',
          async run({ source, limit } = {}) {
            const id = String(source || 'people-politics').trim();
            const feed = NEWS_FEEDS.find((f) => f.id === id);
            if (!feed) {
              throw new Error(`source 取 ${NEWS_FEEDS.map((f) => f.id).join(' / ')}`);
            }
            const n = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 20);
            let items;
            try {
              items = await fetchNews(feed);
            } catch (err) {
              throw new Error(`${feed.label}暂时拉不到：${err?.message || err}`);
            }
            const top = items.slice(0, n);
            const lines = top.map((item, i) => {
              const date = fmtDate(item.hint);
              return `${i + 1}. ${item.title}${date ? `（${date}）` : ''}`;
            });
            return {
              text: `${feed.label}最新：\n${lines.join('\n')}`,
              data: { source: id, items: top },
            };
          },
        },
      ];
    },
  };
}
