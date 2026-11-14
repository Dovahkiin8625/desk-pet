# 前沿

## 什么时候用

用户问 GitHub 上最近有什么热门项目、Hacker News 在热议什么、AI 领域最近有什么新进展（新模型、新论文、新产品）时用它。

## 工具

- `frontier.github(since?)` — 查 GitHub Trending 热门仓库（前 15 个，含语言、星数、新增星数与简介）。since 取 `daily`（今日，默认）/ `weekly`（本周）。
- `frontier.news(source?, limit?)` — 查某个 AI 资讯源最新的文章标题。source 取 `qbitai`（量子位，中文，默认）/ `openai`（OpenAI News）/ `deepmind`（Google DeepMind）/ `google-ai`（Google AI 博客）/ `decoder`（THE DECODER）/ `simonw`（Simon Willison）；limit 默认 10，最大 20。
- `frontier.hn(limit?)` — 查 Hacker News 上最近 7 天 AI 相关、按热度排序的讨论（默认 10 条）。

## 用法

- 用户说「GitHub 最近有什么火的」→ `frontier.github`，想看趋势用 `weekly`。
- 用户说「AI 最近有什么大新闻」→ 中文速览查 `qbitai`，英文一手源查 `openai` 或 `deepmind`；想要比较全面的时候连查两个，挑重要的说。
- 用户说「HN 上大家在讨论什么」→ `frontier.hn`。
- 找工程实践/博客向的内容 → `simonw`（Simon Willison）；找媒体报道 → `decoder`、`google-ai`。

## 注意

- **都要联网**，可能失败。工具报错时说一声「暂时查不到 / 拉不到」，不要凭印象编榜单或编新闻。
- GitHub Trending 是实时榜，前后两次查的结果可能不一样。
- 这些源只给标题、日期和链接，**正文要自己点开看**；不要假装读过全文。
- Hacker News 的条目带分数和评论数，分数高的通常代表关注度更高，可以优先讲。
