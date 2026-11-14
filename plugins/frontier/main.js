/**
 * 前沿：GitHub Trending、Hacker News 的 AI 热议，以及 AI 资讯（中英文）。
 *
 * GitHub 榜解析网页（官方无免密钥接口），HN 走 Algolia 搜索 API，
 * 资讯源是 RSS/Atom，只取标题/链接/日期。全部免密钥，都带 User-Agent。
 * 小部件（widget.html）看当前选中的榜；面板/独立窗口用积木界面，也看同一个。
 */

const FEEDS = [
  { id: 'gh-daily', label: 'GitHub 今日' },
  { id: 'gh-weekly', label: 'GitHub 本周' },
  { id: 'hn-ai', label: 'HN · AI' },
  { id: 'qbitai', label: '量子位' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepmind', label: 'DeepMind' },
  { id: 'google-ai', label: 'Google AI' },
  { id: 'decoder', label: 'THE DECODER' },
  { id: 'simonw', label: 'Simon Willison' },
];

const NEWS_FEEDS = [
  { id: 'qbitai', label: '量子位', url: 'https://www.qbitai.com/feed' },
  { id: 'openai', label: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { id: 'deepmind', label: 'DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
  { id: 'google-ai', label: 'Google AI', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/' },
  { id: 'decoder', label: 'THE DECODER', url: 'https://the-decoder.com/feed/' },
  { id: 'simonw', label: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/' },
];

const NUMBERED = new Set(['gh-daily', 'gh-weekly', 'hn-ai']);

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

function fmtNum(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

async function fetchGithub(since) {
  const html = await (await getRaw(`https://github.com/trending?since=${since}`)).text();
  const articles = html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) || [];
  const repos = [];
  for (const block of articles) {
    const link = block.match(/<h2 class="h3 lh-condensed">[\s\S]*?<a[^>]*href="\/([^"/]+\/[^"]+)"/);
    if (!link) continue;
    const path = link[1].trim();
    const descMatch = block.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/);
    const desc = descMatch
      ? decodeEntities(descMatch[1]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';
    const langMatch = block.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/);
    const totalMatch = block.match(/stargazers"[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)/);
    const perMatch = block.match(/([\d,]+)\s+stars?\s+(today|this week)/);
    const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : 0;
    const per = perMatch ? Number(perMatch[1].replace(/,/g, '')) : 0;
    const lang = langMatch ? decodeEntities(langMatch[1]).trim() : '';
    const perLabel = since === 'weekly' ? '本周' : '今日';
    repos.push({
      title: path,
      desc,
      hint: `${lang ? `${lang} · ` : ''}★ ${fmtNum(total)}（${perLabel} +${fmtNum(per)}）`,
      url: `https://github.com/${path}`,
    });
  }
  if (!repos.length) throw new Error('没解析出仓库');
  return repos;
}

async function fetchHnAi() {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const query = new URLSearchParams({
    query: '"AI"',
    tags: 'story',
    restrictSearchableAttributes: 'title',
    numericFilters: `created_at_i>${since}`,
    hitsPerPage: '30',
  });
  const data = await getJson(`https://hn.algolia.com/api/v1/search?${query}`);
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  hits.sort((a, b) => (Number(b?.points) || 0) - (Number(a?.points) || 0));
  const items = hits
    .map((h) => ({
      title: String(h?.title || '').trim(),
      hint: `${Number(h?.points) || 0} 分 · ${Number(h?.num_comments) || 0} 评`,
      url:
        typeof h?.url === 'string' && h.url
          ? h.url
          : `https://news.ycombinator.com/item?id=${h?.objectID}`,
    }))
    .filter((item) => item.title);
  if (!items.length) throw new Error('没解析出讨论');
  return items;
}

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

function parseAtom(xml) {
  const items = [];
  const re = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    const title = tagText(block, 'title');
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i);
    const date = tagText(block, 'published') || tagText(block, 'updated');
    if (title && linkMatch) items.push({ title, hint: date, url: decodeEntities(linkMatch[1]) });
  }
  return items;
}

function parseFeed(xml) {
  return /<entry[\s>]/i.test(xml) ? parseAtom(xml) : parseRss(xml);
}

async function fetchNews(feed) {
  const xml = await (await getRaw(feed.url)).text();
  const items = parseFeed(xml);
  if (!items.length) throw new Error('没解析出文章');
  return items;
}

async function fetchFeed(id) {
  if (id === 'gh-daily') return fetchGithub('daily');
  if (id === 'gh-weekly') return fetchGithub('weekly');
  if (id === 'hn-ai') return fetchHnAi();
  const feed = NEWS_FEEDS.find((f) => f.id === id);
  if (!feed) throw new Error('未知的榜');
  return fetchNews(feed);
}

function feedLabel(id) {
  return FEEDS.find((f) => f.id === id)?.label || '前沿';
}

function fmtDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
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

export default function createFrontierPlugin() {
  let selected = 'gh-daily';
  /** @type {Map<string, { items: Array<{title: string, hint: string, url: string, desc?: string}>, at: number, error: string }>} */
  const caches = new Map();
  /**
   * 正在路上的请求：同一个榜连点 / 切回来切回去，共用一个请求。
   * @type {Map<string, Promise<{ items: Array<{title: string, hint: string, url: string, desc?: string}>, at: number, error: string }>>}
   */
  const inflight = new Map();

  function cacheFresh(entry) {
    if (!entry) return false;
    const ttl = entry.error ? ERROR_CACHE_MS : CACHE_MS;
    return Date.now() - entry.at < ttl;
  }

  /** 拉一个榜：同一个榜同一时刻只发一个请求。失败也落到缓存里（带错误）。 */
  function fetchAndCache(feed) {
    const running = inflight.get(feed);
    if (running) return running;
    const p = (async () => {
      const hit = caches.get(feed);
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
      } finally {
        inflight.delete(feed);
      }
    })();
    inflight.set(feed, p);
    return p;
  }

  /**
   * 后台刷新一个榜，回来再推一份。动作全程不抛：
   * 界面挂着就收、面板积木就重画，没人接就算。
   *
   * @param {string} feed 榜的 id
   * @param {object} ctx 插件上下文（用来 push / update）
   * @param {{ notify?: boolean }} opts notify=false 只热缓存，不打扰界面
   */
  function kick(feed, ctx, { notify = true } = {}) {
    return fetchAndCache(feed).then(
      () => {
        if (!notify) return;
        // 自带页面（小部件、面板 iframe）：直接推一份快照。
        try {
          ctx?.push?.(snapshot());
        } catch {
          // 界面没挂着就算了
        }
        // 声明式界面（面板积木）：面板收到 update 会把当前页重画一次。
        if (ctx?.update) {
          Promise.resolve()
            .then(() => page(ctx))
            .then((p) => ctx.update(p))
            .catch(() => {});
        }
      },
      () => {},
    );
  }

  /** 不够新的话后台拉一把——立刻返回，界面拿到什么算什么。 */
  function ensureFresh(feed, ctx) {
    if (!cacheFresh(caches.get(feed))) void kick(feed, ctx);
  }

  /** 开场预热所有榜：第一次切换就地切，不用等网络。 */
  function prefetchAll(ctx) {
    for (const f of FEEDS) {
      if (cacheFresh(caches.get(f.id))) continue;
      void kick(f.id, ctx, { notify: f.id === selected });
    }
  }

  const itemHint = (feed, item) => (NUMBERED.has(feed) ? item.hint : fmtDate(item.hint));

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
      loading: inflight.has(selected),
    };
  };

  const page = async (ctx) => {
    // 不阻塞在网络上：先拿缓存画，不够新后台再拉，好了再 update。
    ensureFresh(selected, ctx);
    const entry = caches.get(selected);
    const loading = inflight.has(selected);
    const items = (entry?.items || []).slice(0, SHOW);
    const status = loading
      ? items.length
        ? '正在更新…'
        : '正在加载…'
      : entry?.error
        ? `暂时拉不到（${entry.error}）`
        : entry?.at
          ? `更新于 ${fmtTime(new Date(entry.at))}`
          : '';
    return ctx.ui.makePage({
      pluginId: 'frontier',
      title: '前沿',
      subtitle: loading && !items.length ? `${feedLabel(selected)} · 正在加载…` : `${feedLabel(selected)} · 共 ${items.length} 条`,
      blocks: [
        ctx.ui.buttonsBlock(
          FEEDS.map((f) => ({ id: `switch:${f.id}`, label: f.label, primary: f.id === selected })),
        ),
        items.length
          ? ctx.ui.listBlock(
              items.map((item, i) => ({
                id: item.url,
                label: NUMBERED.has(selected) ? `${i + 1}. ${item.title}` : item.title,
                hint: itemHint(selected, item),
                actionId: 'open',
              })),
            )
          : ctx.ui.emptyBlock(
              loading
                ? '正在加载…'
                : entry?.error
                  ? `暂时拉不到（${entry.error}）`
                  : '暂时没有内容，点「刷新」再试',
            ),
        ctx.ui.buttonsBlock([{ id: 'refresh', label: '刷新' }]),
      ],
      status,
    });
  };

  return {
    page,

    async data(ctx) {
      // 首开的时候顺便把其他榜也热上：切换就地切。
      prefetchAll(ctx);
      return snapshot();
    },
    async tick(ctx) {
      ensureFresh(selected, ctx);
      return snapshot();
    },
    async act(ctx, actionId, payload) {
      if (actionId === 'feed') {
        const next = String(payload?.feed || '');
        if (FEEDS.some((f) => f.id === next)) selected = next;
        ensureFresh(selected, ctx);
        return snapshot();
      }
      if (actionId === 'refresh') {
        caches.delete(selected);
        void kick(selected, ctx);
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
          name: 'frontier.github',
          async run({ since } = {}) {
            const s = String(since || 'daily').trim();
            if (s !== 'daily' && s !== 'weekly') throw new Error('since 取 daily / weekly');
            let items;
            try {
              items = await fetchGithub(s);
            } catch (err) {
              throw new Error(`GitHub 热门暂时查不到：${err?.message || err}`);
            }
            const top = items.slice(0, 15);
            const perLabel = s === 'weekly' ? '本周' : '今日';
            const lines = top.map(
              (item, i) =>
                `${i + 1}. ${item.title}（${item.hint}${item.desc ? `，${item.desc}` : ''}）`,
            );
            return {
              text: `GitHub ${perLabel}热门（实时）：\n${lines.join('\n')}`,
              data: { since: s, items: top },
            };
          },
        },
        {
          name: 'frontier.news',
          async run({ source, limit } = {}) {
            const id = String(source || 'qbitai').trim();
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
        {
          name: 'frontier.hn',
          async run({ limit } = {}) {
            const n = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 20);
            let items;
            try {
              items = await fetchHnAi();
            } catch (err) {
              throw new Error(`HN 暂时查不到：${err?.message || err}`);
            }
            const top = items.slice(0, n);
            const lines = top.map((item, i) => `${i + 1}. ${item.title}（${item.hint}）`);
            return {
              text: `HN · AI 热议（最近 7 天）：\n${lines.join('\n')}`,
              data: { items: top },
            };
          },
        },
      ];
    },
  };
}
