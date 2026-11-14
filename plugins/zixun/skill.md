# 资讯

## 什么时候用

用户问今天有什么热点、最近大家在聊什么、某个平台热搜是什么，或者想看某方面（时政 / 国际 / 财经 / 科技 / 数码）的最新资讯时用它。

## 工具

- `zixun.hotsearch(platform)` — 查某个平台当前的热搜榜（前 10 条）。platform 取 `baidu` / `weibo` / `zhihu` / `douyin`。
- `zixun.news(source?, limit?)` — 查某个来源最新的文章标题。source 取 `people-politics`（人民网·时政，默认）/ `people-world`（人民网·国际）/ `people-finance`（人民网·财经）/ `ithome`（IT之家）/ `sspai`（少数派）；limit 默认 10，最大 20。

## 用法

- 用户说「微博热搜有啥」→ `zixun.hotsearch` 传 `platform: "weibo"`。
- 用户说「今天有什么新闻热点」→ 可以连着查四个平台的热搜，挑重复出现的几条说。
- 用户说「国际上有什么大事」→ `zixun.news` 传 `source: "people-world"`。
- 用户说「最近科技圈发生了啥」→ `zixun.news` 传 `source: "ithome"`。

## 注意

- **查热搜、拉新闻都要联网**，可能失败。工具报错时说一声「暂时查不到 / 拉不到」，不要凭印象编一个榜或编新闻。
- 热搜榜是实时的，前后两次查的结果可能不一样，这是正常的。
- 新闻只有标题、日期和链接，正文要用户自己点开看；不要假装读过全文。
