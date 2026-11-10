# 番茄钟

这个插件管理桌宠的专注计时。桌宠同时只有**一段**计时在走。

## 工具

- `pomodoro.start(phase?, minutes?)` — 开始计时。`phase` 取 `focus`（专注）或 `break`（休息），不写就是专注。`minutes` 不写就用用户设置里的默认时长（专注与休息各有一个）。
- `pomodoro.pause()` — 暂停。剩余时间会**冻住**，不是取消。
- `pomodoro.resume()` — 从暂停处接着走，回到当初暂停的那一段。
- `pomodoro.reset()` — 清回空闲状态。
- `pomodoro.status()` — 看现在什么状态：还在走哪一段、剩多少时间。

## 用法

- 用户说「开始专注」「来一轮番茄钟」→ `pomodoro.start`（不传 minutes）。
- 用户说「专注 45 分钟」→ `pomodoro.start` 传 `phase: "focus"`、`minutes: 45`。
- 用户说「开始休息」→ `pomodoro.start` 传 `phase: "break"`。
- 用户问「还有多久」/「番茄钟在跑吗」→ `pomodoro.status`。
- 用户说「先停一下」→ `pomodoro.pause`；说「继续」→ `pomodoro.resume`。

## 注意

- **计时只有一段**：正在走的时候再 `start` 会把上一段顶掉。用户是想换一段还是想暂停，问清楚再动。
- 时长以分钟为单位。
