# 系统状态

这个插件读本机的运行状况：CPU、内存、GPU、温度、电源。

## 工具

- `system.status()` — 看当前状况（含 GPU 的占用与显存）。
- `system.hotalert.set(enabled)` — 开或关「过热时提醒我」。`enabled` 是 `true` 或 `false`。

## 用法

- 用户问「电脑现在热不热」「内存用了多少」「显卡占用多少」→ `system.status`。
- 用户说「太热了别再提醒我」→ `system.hotalert.set` 传 `false`。
- 用户说「温度高了提醒我一下」→ `system.hotalert.set` 传 `true`。

## 注意

- 状态是**此刻**的读数，工具返回什么就说什么，不要自己猜。
- 这台机器上没有可读的 GPU 时，返回里的 `gpu` 是 `null`——别自己补一个 0%。
- 这个插件只读本机状况，不改任何系统设置。
