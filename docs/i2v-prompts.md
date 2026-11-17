# MiniMax H3 图生视频（I2V）变体提示词

用于给桌宠角色生成更多动作/状态变体。基于 MiniMax H3 官方提示词规范：

- 提示词用英文；无负向提示词（cfg=1，无 negative 分支），只能写「要什么」
- 结构：`integrated_multimodal_description`（镜头+画面+动作）/ `overall_soundscape`（环境音、音效、非人声）/ `non_diegetic_music`（配乐）
- 对白用 `<d>` 标签（桌宠用不着，全部 `No speech`）
- 帧数：24fps，`length` 对齐 **17k+5** 网格，**124 帧 ≈ 5.17 秒**，与现有素材一致
- 比例：**9:16**（现有素材 480×864 ≈ 9:16）。I2V 的 first_frame 会被直接拉伸到画布，喂图前先把首帧裁/垫到 9:16
- 分辨率：短边默认 768，正式出片可开 H3-Regenerate-2K
- 输出后照旧走绿幕抠像流程（chromakey + despill → WebM VP9 alpha）

## 关键技巧

1. **循环类变体用首尾帧模式（FL2VA）**：`first_frame` 和 `last_frame` 传同一张图，首尾自动闭合，生成无缝循环
2. **角色一致性**：公共前缀里的角色描述一字不改复用；跑偏时用同一首帧重试，或改用 **Ref2VA**（2 段现有视频作 reference，锁死角色身份）
3. **锁绿幕**：提示词必须显式声明「纯绿背景 #00FF00、静止机位、无剪辑无切镜无运镜」，否则模型会加运镜/换背景，抠像就废了
4. **桌宠建议静音播放**；`overall_soundscape` 不需要声音时写 `N/A`，要音效才写一句并加 `No speech`
5. 已有两条的状态（比心1/2、生气1/2、默认站立1/2），分别作首帧可生成差异更大的变体

---

## 公共前缀（每个变体都带上，只改 {MOTION} 和 {SOUND}）

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] A locked-off, static full-body shot of an adult anime-style woman. She has long wavy light-brown hair with pink-tinted lower locks, soft pink eyes, and a gentle curvy figure. She wears a white ruched camisole top, a fuzzy pink-and-white striped knitted cardigan with large round buttons, loose white shorts, and pink fluffy slippers. She stands perfectly centered against a flat, evenly lit, solid pure-green (#00FF00) studio backdrop. The backdrop stays completely static and uniform for the entire clip: no shadows, no lighting changes, no props, no floor line. The camera never moves, there are no cuts, no zoom, no pans. Her feet stay planted in the same spot. Only natural body motion is animated. {MOTION}
overall_soundscape: {SOUND}
non_diegetic_music: N/A
```

---

## 待机类（无缝循环，FL2VA 首尾帧传同一张图）

### 1. 呼吸起伏（idle 主循环）

```text
{MOTION}: Her chest and shoulders rise and fall in a slow, calm breathing rhythm. She blinks naturally every few seconds, her hair sways very slightly, and her expression stays a soft, relaxed closed-mouth smile. The motion is subtle, quiet, and loop-friendly, starting and ending in the exact pose of the first frame.
{SOUND}: N/A
```

### 2. 歪头杀（idle 变体）

```text
{MOTION}: From the neutral stance, she slowly tilts her head to her right, eyes curving into a gentle smile, holds the tilt for a moment, then eases back to the exact original pose. Subtle breathing throughout. Loop-friendly.
{SOUND}: N/A
```

### 3. 重心换脚（idle 变体）

```text
{MOTION}: She gently shifts her weight from one leg to the other, a tiny sway of her hips, then returns to the original stance. Breathing and occasional blinking continue underneath. Loop-friendly.
{SOUND}: A faint slipper shuffle. No speech.
```

### 4. 犯困打瞌睡（sleepy 状态）

```text
{MOTION}: Her eyelids grow heavy and droop, her head nods forward slowly as she dozes off standing, her body sways faintly, then she snaps awake with a quick blink and a small startled puff of air, and settles back into a sleepy half-smile.
{SOUND}: A soft sleepy sigh and a tiny gasp on waking. No speech.
```

### 5. 伸懒腰（morning/stretch 彩蛋）

```text
{MOTION}: She raises both arms above her head in a long, satisfied stretch, fingertips lacing together, back arching slightly, then lowers her arms back down to her sides and relaxes into a soft smile.
{SOUND}: A soft stretching groan, muffled. No speech.
```

### 6. 撩头发（idle 彩蛋）

```text
{MOTION}: She lifts one hand and tucks a lock of hair behind her ear, her fingers brushing through the pink-tinted tips, then lets her arm fall back to her side. Calm breathing, occasional blink.
{SOUND}: A soft fabric rustle. No speech.
```

### 7. 环顾四周（curious 状态）

```text
{MOTION}: Her gaze drifts to her left, then to her right, then back to the viewer with a small, curious smile. Only her eyes and head turn; her body stays still.
{SOUND}: N/A
```

## 开心/互动类（一次性动作，播完回 idle）

### 8. 开怀大笑（对应「大笑」）

```text
{MOTION}: Her face breaks into a big open-mouth laugh, eyes squeezing shut, shoulders bouncing with each giggle, one hand rising to cover her mouth briefly, then she settles into a beaming smile.
{SOUND}: A bright anime-style laugh, light giggling. No speech.
```

### 9. 挥手打招呼（greet 状态）

```text
{MOTION}: She raises her right hand to shoulder height and waves warmly at the viewer two or three times, a wide friendly smile, then lowers her arm back down.
{SOUND}: A soft friendly "hm!" hum. No speech.
```

### 10. 比心·双手（对应「比心」增强版）

```text
{MOTION}: She brings both hands up to her chest and forms a heart shape with her fingers, winking one eye and tilting her head, holding the pose for a beat, then lowers her hands back down with a sweet smile.
{SOUND}: A soft heartbeat "thump-thump". No speech.
```

### 11. 眨眼比心（对应「比心」单手版）

```text
{MOTION}: She raises one hand beside her face and makes a small finger-heart, gives a slow wink and a playful smile, bobs slightly on her heels, then lowers her hand.
{SOUND}: A soft pop sound. No speech.
```

### 12. 点头致谢（thank 状态）

```text
{MOTION}: She gives a deep, polite bow from the waist, then rises with a grateful closed-eye smile and a small nod.
{SOUND}: Soft clothing rustle. No speech.
```

### 13. 双手合十（please/beg 状态）

```text
{MOTION}: She presses her palms together in front of her chest, raises slightly onto her toes with an eager hopeful smile and shining eyes, swaying side to side once, then settles back down.
{SOUND}: N/A
```

## 生气类（对应「生气」，播完回 idle）

### 14. 鼓腮假气（pout 状态）

```text
{MOTION}: Her cheeks puff out and she huffs, arms crossing lightly in front of her, her cardigan sleeves flopping, one foot tapping once against the ground, then she holds a cute pouting stare at the viewer.
{SOUND}: A frustrated little "hmph!". No speech.
```

### 15. 双手叉腰（angry 状态）

```text
{MOTION}: She plants her feet apart, places both hands on her hips, and gives a small indignant huff, her hair bouncing once, her expression a comical angry glare with a flushed face.
{SOUND}: A short comedic huff. No speech.
```

### 16. 假生气变笑（tsun 状态）

```text
{MOTION}: She starts with a pout and a turned-away huff, then slowly the corner of her mouth twitches into a reluctant smile, and she glances at the viewer with a softened, shy expression.
{SOUND}: A tiny sigh. No speech.
```

## 放松/表演类（跳舞/特殊动作扩充）

### 17. 原地摇摆（dance 变体1）

```text
{MOTION}: She sways her hips gently side to side in a slow relaxed rhythm, loosely waving her hands near her waist in time, her hair swaying with the motion, her smile dreamy and content. She does not leave her spot.
{SOUND}: A soft, generic lounge groove underneath, quiet volume. No speech.
```

### 18. 拍手打节拍（dance 变体2）

```text
{MOTION}: She claps her hands lightly in a steady beat, bouncing on the balls of her feet, knees soft, cardigan bouncing, face alight with enjoyment.
{SOUND}: Clear rhythmic hand claps and a faint beat. No speech.
```

### 19. 哼歌摇头（sing 变体）

```text
{MOTION}: She hums a tune with her lips closed, swaying and nodding her head gently to the rhythm, one hand lightly conducting in the air, eyes closed in enjoyment.
{SOUND}: A cheerful hummed melody with no lyrics.
```

### 20. 揉眼睛（sleepy 变体）

```text
{MOTION}: She raises both hands to her eyes and rubs them tiredly, lets out a deep yawn, then lowers her hands and blinks slowly a few times, face soft and dazed.
{SOUND}: A long yawn, soft. No speech.
```
