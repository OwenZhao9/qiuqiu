# 丘丘 · 角色状态机

`character` 分支的输入。对应 `docs/CONTRACTS.md` § 2（`setPetState`）与 § 6（表情映射）。契约版本 **v0.1.2**。

受 **AD-1** 约束：四态由前端按本地事件切换，后端不发状态事件。桌面端经 IPC `setPetState`，网页端经前端内存事件总线，两端跑同一份状态机代码。

## 1 · 四个状态

状态 ID 与 `docs/CONTRACTS.md` § 2 的 `setPetState(state)` 逐字一致，emotionId 与 § 6 表格逐字一致。

| 状态 | emotionId | Emotion Ball 名 | 切入过渡 |
|---|---|---|---|
| `idle` | `02` | 待机放空 | 700 ms |
| `listening` | `35` | 等待输入 | 480 ms |
| `thinking` | `30` | 思考中 | 480 ms |
| `speaking` | `39` | 输出回复 | 360 ms |

`idle` 是初始状态。四态之外没有第五态：错误、拒绝、记忆事件都只改表情，不改状态。

## 2 · 迁移表

`E` 是触发事件，全部来自前端本地，来源写在括号里。

| # | 从 | 到 | 触发事件 | 来源 |
|---|---|---|---|---|
| T1 | `idle` | `thinking` | 用户提交文本（回车、点发送、桌宠 `submitFromPet`） | 前端本地 |
| T2 | `idle` | `listening` | 语音按钮按下（`pointerdown`） | 前端本地 |
| T3 | `listening` | `thinking` | 收到 `final(role=user)` 且文本非空，前端随即 `POST /chat` | `WS /voice/stream` |
| T4 | `listening` | `idle` | 语音按钮松开且本轮无 `final`，或收到空 `final`，或 `error` 帧 | 前端本地 / WS |
| T5 | `thinking` | `speaking` | 本轮**首个** `delta` 事件（`data.text` 长度 > 0） | `SSE /chat` |
| T6 | `thinking` | `idle` | `error` 事件；或 `done` 先于任何 `delta` 到达；或用户点「停止」 | SSE / 前端本地 |
| T7 | `speaking` | `idle` | `done` 事件；或 `error` 事件；或用户点「停止」 | SSE / 前端本地 |
| T8 | `speaking` | `thinking` | 同一 `session_id` 下开启新一轮（用户在回复途中再次提交，前端先中止当前流） | 前端本地 |
| T9 | 任意 | `listening` | 语音按钮按下；若当前是 `speaking` 先中止 SSE 与音频播放（打断） | 前端本地 |
| T10 | 任意 | `idle` | 连接断开且 8 s 内未重连成功 | 前端本地 |

未在表里出现的组合一律忽略，不报错、不切表情。

### 每个状态的进入与退出

**`idle`**
- 进入条件：应用启动；T4、T6、T7、T10 中任一发生
- 进入动作：`setEmotion('02')`；清空口型脉动（见 § 4）；`ball.resetIdle()` 复位闲置计时
- 退出条件：T1、T2、T9
- 说明：只有 `idle` 期间闲置计时才会推进到 `04` 发呆与 `00` 睡眠（见 `design/character.md` § 4）。其余三态每次切换都复位计时

**`listening`**
- 进入条件：T2、T9
- 进入动作：`setEmotion('35')`
- 退出条件：T3（拿到最终转写）、T4（空转写或出错）
- 说明：`WS /voice/stream` 的 `partial` 帧只更新输入条文字，不影响状态与表情

**`thinking`**
- 进入条件：T1、T3、T8
- 进入动作：`setEmotion('30')`；开始计首字延迟
- 退出条件：T5（首个 `delta`）、T6
- 说明：`meta` 事件不改状态。`meta.memory_used === true` 时另走事件表情通道（§ 3），不改状态

**`speaking`**
- 进入条件：T5
- 进入动作：`setEmotion('39')`；打开口型脉动通道
- 退出条件：T7、T8、T9
- 说明：`39` 的 `blinkMs` 为 `null`，说话期间不眨眼，这是上游有意的设计，不要覆盖

## 3 · 最短停留时间与事件表情

### 状态最短停留时间：**500 ms**，四态统一

- 含义：状态 A 的表情切上去之后，**表情**至少保持 500 ms 才允许切到状态 B 的表情。
- 取值依据：四个状态表情里最长的切入过渡是 `30` 与 `35` 的 480 ms，500 ms 保证任何一次状态切换的交叉淡入都能走完，不会看到半成型的眼环。
- **只约束表情，不约束状态语义。** 状态变量本身立即翻转，气泡文字、口型脉动、音频播放、网络请求全部不等——首字延迟是排序第二的质量属性（`docs/ARCHITECTURE.md` § 1），不能为了表情好看牺牲它。
- 实现：状态机维护 `pendingStateEmotion`。切换时若距上次表情切换不足 500 ms，把目标 emotionId 存进 `pendingStateEmotion` 并设一个 `500 - elapsed` 毫秒的定时器；定时器到点时切到 `pendingStateEmotion` 的**最新值**（中途被覆盖过就切最后那个），只切一次。
- 例外：`T9`（打断）与 `T10`（断连）忽略最短停留，立即切表情。用户主动打断必须马上看到反馈。

### 事件表情持续时间：**1600 ms**

**与状态最短停留时间取不同的值，这是刻意的。** 两者解决的是两个问题：500 ms 是防抖下限，越小越好；1600 ms 是可读性下限，要让眼角余光也能注意到丘丘变了脸。取同一个值的话，要么事件表情一闪而过没人看见，要么状态切换被拖慢 1.6 s，把首字延迟毁掉。

- 取值依据：事件表情里最长的切入过渡是 `37` 复述回忆的 780 ms，1600 ms 保证成型后至少停留 820 ms；上限压在 2 s 以内，避免事件密集时表情一直落后于实际进度。
- 事件表情优先于状态表情（`docs/agents/07-character.md` 已定）。计时结束后回到**当前**状态的表情，不是进入事件时的那个状态。
- **不排队。** 事件表情期间又来一条事件：新的立即覆盖旧的，1600 ms 计时器重置。同一毫秒内到达多条，取 § 3 优先级表里最高的一条；优先级相同取后到的。
- `speaking` 期间事件表情照切，但**口型脉动不受影响**——脉动施加在容器上，与表情是两条独立通道（见 § 4）。

### 事件 → 表情映射

与 `docs/CONTRACTS.md` § 6 逐字一致。`优先级` 数值大的胜出。

| 事件 | 判定 | emotionId | 优先级 |
|---|---|---|---|
| 请求出错 | SSE / WS `error` 事件 | `34` 出错 | 90 |
| 回复含拒绝 | `done` 之后对全文跑 `design/emotion-rules.md` § 4 的拒绝式 | `38` 拒绝/受限 | 80 |
| `recall`（下探冷存储） | `type === "recall"` 且 `payload.cold_promoted.length > 0` | `40` 检索资料 | 70 |
| `recall`（命中） | `type === "recall"` 且 `payload.hits.length > 0` 且 `cold_promoted` 为空 | `37` 复述回忆 | 60 |
| `merge` | `type === "merge"` | `19` 满意 | 50 |
| `write` | `type === "write"` 且 `payload.facts.length > 0` | `10` 开心 | 50 |
| `filter.uncertain` | `type === "filter"` 且 `payload.decision === "uncertain"` | `11` 疑惑 | 40 |
| `filter.reject` | `type === "filter"` 且 `payload.decision === "reject"` | **不切换** | — |
| 情绪推断 | `done` 之后对全文跑 `design/emotion-rules.md` | `10`–`21` 之一 | 30 |
| `filter.accept` | `type === "filter"` 且 `payload.decision === "accept"` | **不切换** | — |
| `recall`（空命中） | `hits` 与 `cold_promoted` 都为空 | **不切换** | — |

三条「不切换」的事件仍然照常进记忆侧栏（`design/memory-panel.md`），只是不动丘丘的脸。

## 4 · `speaking` 的口型：TTS 音量包络驱动

### 前提：Emotion Ball 的球没有嘴

已于 2026-09-05 核对上游 `ball.js`、`engine.js`、`emotions.js` 三个文件，全文没有 `mouth` / `jaw` / `lip` 任何一项。这个角色是**纯眼睛系统**：可驱动的姿态字段只有

- `body`：`x` `y` `scale` `rotate` `color` `breathe` `ribbons` `confetti` `sketch` `zzz` `orbit`
- 每只眼：`x` `y` `scaleX` `scaleY` `rotate` `open` `color` `lookX` `lookY`

而且引擎**没有公开的逐帧写姿态接口**——`applyPose` 是 `ball.js` 内部方法，`engine._compose` 每帧覆盖全部字段。宿主拿不到写入点。

所以丘丘的「口型」落地为 **发声脉动**：球体随音量整体起伏，施加在**包裹容器**上，用 CSS `transform`。这条通路完全绕开引擎，不改 vendor 文件，也不和 `39` 自带的 `breathe: 0.008` 呼吸打架（两者相乘叠加，读起来是「一边呼吸一边说话」）。

这是本轮发现的契约缺口，见 § 6。

### DOM 结构

```html
<div class="qq-stage" style="--qq-voice: 0">
  <div class="qq-ball"></div>   <!-- EmotionBall.create 挂这里 -->
</div>
```

```css
.qq-stage {
  transform: scale(calc(1 + 0.055 * var(--qq-voice)))
             translateY(calc(-3px * var(--qq-voice)));
  transform-origin: 50% 62%;   /* 略低于球心，起伏像点头不像放大 */
  will-change: transform;
}
```

`transform-origin` 的 `62%` 是相对容器高度，对应 blob 轮廓的重心偏下位置。

### 包络值 → 张合参数的映射曲线

输入 `rms` ∈ [0, 1]，来自三处，取值语义相同：SSE `audio` 事件的 `data.rms`、`WS /voice/stream` 的 `audio` 帧、`RealtimeEvent` 的 `audio.rms`（`docs/CONTRACTS.md` § 1、§ 4）。

**第一步 · 噪声门与压限**

```
u = clamp((rms - 0.02) / 0.33, 0, 1)
```

- 门限 `0.02`：静音段的底噪不触发脉动
- 天花板 `0.35`（= 0.02 + 0.33）：人声 rms 极少超过 0.35，再高一律压到满幅，避免爆音把球撑爆

**第二步 · 感知伽马**

```
level = u ** 0.6
```

指数 `0.6` < 1，把说话最常落的低区（rms 0.05–0.15）拉开。线性映射下这段只占 8%–40% 幅度，肉眼几乎看不出起伏。

**曲线取值表**（`character` 的单测直接照这张表断言，容差 ±0.005）：

| `rms` | `u` | `level` | 容器 `scale` | `translateY` |
|---|---|---|---|---|
| 0.00 | 0.0000 | 0.000 | 1.0000 | 0.00 px |
| 0.02 | 0.0000 | 0.000 | 1.0000 | 0.00 px |
| 0.03 | 0.0303 | 0.123 | 1.0067 | −0.37 px |
| 0.05 | 0.0909 | 0.237 | 1.0130 | −0.71 px |
| 0.08 | 0.1818 | 0.360 | 1.0198 | −1.08 px |
| 0.10 | 0.2424 | 0.427 | 1.0235 | −1.28 px |
| 0.15 | 0.3939 | 0.572 | 1.0314 | −1.72 px |
| 0.20 | 0.5455 | 0.695 | 1.0382 | −2.09 px |
| 0.25 | 0.6970 | 0.805 | 1.0443 | −2.42 px |
| 0.30 | 0.8485 | 0.906 | 1.0498 | −2.72 px |
| 0.35 | 1.0000 | 1.000 | 1.0550 | −3.00 px |
| ≥ 0.35 | 1.0000 | 1.000 | 1.0550 | −3.00 px |

**第三步 · 起落平滑**

`level` 是目标值，实际写进 CSS 变量的是平滑后的 `s`。每个 rAF 帧执行一次，`dt` 单位毫秒：

```
tau = (level > s) ? 45 : 130          // 起 45 ms，落 130 ms
k   = 1 - Math.exp(-dt / tau)
s  += (level - s) * k
```

起快落慢是所有口型驱动的通行做法：辅音的爆发要跟得上，元音的收尾要拖住，否则球会抽搐。60 fps（dt ≈ 16.7 ms）下 `k` 分别是 0.310 与 0.121；30 fps（dt ≈ 33.3 ms）下是 0.523 与 0.226——公式与帧率无关，掉帧不会改变收敛时长。

`dt` 钳在 `[1, 50]` 毫秒，防止标签页切回前台时一帧跳变。

**第四步 · 写入**

```
stage.style.setProperty('--qq-voice', s.toFixed(3))
```

`s < 0.001` 时写 `0` 并跳过本帧，避免持续触发合成层重绘。

### 生命周期

| 时机 | 动作 |
|---|---|
| 进入 `speaking` | 开启脉动 rAF 循环，`s = 0`，`level = 0` |
| 收到 `audio` 事件 | 按上面三步更新 `level`，重置「静音看门狗」 |
| 距上一个 `audio` 事件超过 **250 ms** | `level = 0`，靠 130 ms 释放时间常数自然落回 |
| 收到 `done` / `error` / 用户打断 | `level = 0`，继续跑 200 ms 让 `s` 落到 0，然后停 rAF 并移除 `--qq-voice` |
| 离开 `speaking` | 同上 |
| 整轮没有 `audio` 事件（无 TTS） | `s` 恒为 0，球不动，文字照常。`docs/ARCHITECTURE.md` § 3 的 edge-tts 失败降级就是这一条 |

### 与事件表情的关系

脉动写的是容器 `transform`，表情写的是 SVG 内部姿态，两条通路互不写同一个属性。所以 `speaking` 期间切事件表情（比如 `write` 的 `10` 开心），球一边继续随音量起伏一边换脸，行为符合 `docs/agents/07-character.md` 定的「`speaking` 期间口型不受事件表情影响」。

## 5 · 状态与表情的合成顺序

每一帧丘丘显示哪个表情，按下面顺序算，先命中先返回：

1. 唤醒过场未播完（当前 `emotionId === '01'`）→ 保持 `01`
2. 事件表情未过期（距触发 < 1600 ms）→ 事件 emotionId
3. 最短停留未满且有 `pendingStateEmotion` → 保持上一个表情
4. 当前状态的 emotionId
5. 上述都不成立且状态是 `idle` → 交给引擎的闲置策略（`02` → `04` → `00`）

口型脉动是**并行**的第六条，不参与这个优先级链。

## 6 · 契约缺口

`docs/CONTRACTS.md` § 6 与 `docs/ARCHITECTURE.md` § 5 的 character 块把 `feedEnvelope` 列为对外接口，`docs/agents/01-design.md` 的措辞是「包络值 → **嘴巴张合参数**的映射曲线」。实际上 Emotion Ball 的角色没有嘴，引擎也没有公开的逐帧姿态写入口。本文把 `feedEnvelope(rms: number)` 定义为**驱动容器级发声脉动**，而不是驱动一个嘴巴参数。

需要主调度确认是否把这一条写回契约。本文不改 `docs/CONTRACTS.md`。签名本身不用动：

```ts
feedEnvelope(rms: number): void   // rms ∈ [0,1]，语义见本文 § 4
```
