# 记忆事件侧栏

`frontend` 分支的输入。数据源是 `GET /events?since=<cursor>`，信封与 payload 见 `docs/CONTRACTS.md` § 1。契约版本 **v0.1.2**。

受 **AD-14** 约束：侧栏只消费事件，不读记忆库、不解析回复内容。侧栏里出现的每一个字都必须能追到某条事件的某个字段。

## 1 · 位置与骨架

主窗口三栏的右栏，宽 `--qq-sidebar-right`（340 px）。自上而下三段：

| 段 | 高度 | 内容 |
|---|---|---|
| 标题栏 | `--qq-header-h`（48 px） | 「记忆过程」+ 连接状态点 + 筛选下拉 |
| 阈值区 | 折叠 0 / 展开 128 px | 两个滑块，见 § 5 |
| 事件流 | 剩余空间，`overflow-y: auto` | 事件卡，见 § 3 |

- 标题栏的连接状态点：`--qq-color-write` 已连接 / `--qq-color-uncertain` 重连中 / `--qq-color-danger` 断开。断开时点右侧追加「重试」文字按钮。
- 筛选下拉：全部 / 只看写入 / 只看筛选 / 只看召回 / 只看合并。纯前端过滤，不改 `since` 游标。
- 事件流为空时显示空态：`--qq-text-md` 的「还没有记忆事件」+ `--qq-text-sm` `--qq-color-text-muted` 的「说点什么，或者打开被动采集」。

## 2 · 四类事件的视觉

每张卡共用同一套结构：左侧 4 px 竖条（类型色）+ 卡体。卡体 `background: var(--qq-color-surface)`，圆角 `--qq-radius-md`，内边距 `--qq-space-5`，卡间距 `--qq-space-3`，最小高度 `--qq-event-card-min-h`（56 px）。

| 事件 | 竖条与徽章色 | 卡体背景 | 附加处理 |
|---|---|---|---|
| `filter` · `reject` | `--qq-color-reject` | `--qq-color-reject-bg` | **整卡打灰**：卡内所有文字降到 `--qq-color-reject`，`opacity: 0.72`。默认折叠且不参与自动滚（见 § 4） |
| `filter` · `uncertain` | `--qq-color-uncertain` | `--qq-color-uncertain-bg` | 徽章文字「拿不准」，右上角一个「留下 / 丢掉」二选一按钮组 |
| `filter` · `accept` | `--qq-color-write` | `--qq-color-surface` | 只显示一行摘要，`accept` 后面必定跟一条 `write`，不重复展开 |
| `write` | `--qq-color-write` | `--qq-color-write-bg` | **高亮**：卡进场时播 600 ms 的背景闪，从 `--qq-color-write-border` 淡到 `--qq-color-write-bg`，缓动 `--qq-ease-out` |
| `merge` | `--qq-color-merge` | `--qq-color-merge-bg` | **旧条划线**：`absorbed` 与 `invalidated` 里的每条旧事实单起一行，`text-decoration: line-through`，颜色 `--qq-color-text-muted`；新结果行在最上，正常颜色加 `--qq-weight-medium` |
| `recall` | `--qq-color-recall` | `--qq-color-recall-bg` | **标路径**：`plan.paths` 每条渲染成一个胶囊徽章；命中的路径实心，`skipped_paths` 里的路径描边加删除线 |

### 路径徽章

`recall` 的 `plan.paths` 与 `hits[].path` 取值是 `semantic` / `lexical` / `symbolic`，界面用中文：

| 值 | 中文 | 徽章底色 |
|---|---|---|
| `semantic` | 按意思 | `--qq-color-recall-bg` + `--qq-color-recall` 描边 |
| `lexical` | 按字面 | 同上 |
| `symbolic` | 按标签 | 同上 |

胶囊：`--qq-text-2xs`、`padding: 2px 6px`、`--qq-radius-full`。命中的填 `--qq-color-recall` 底 + `--qq-color-on-brand` 字；`skipped_paths` 的保持描边样式并加 `text-decoration: line-through`。

`cold_promoted` 非空时，卡的右上角追加一枚 `--qq-color-brand` 的「回热 N 条」徽章——这是「三个月后问旧事」演示场景的视觉落点（`docs/ARCHITECTURE.md` § 6）。

## 3 · 每条事件显示哪些字段

字段名全部取自 `docs/CONTRACTS.md` § 1 的 payload，不新增、不改名。

### 卡头（四类共用）

| 位置 | 字段 | 格式 |
|---|---|---|
| 左 | 类型徽章 | `type` + `payload.decision`（只有 `filter` 有），`--qq-text-2xs` `--qq-weight-semibold` |
| 中 | 一行摘要 | 见下表，单行 `text-overflow: ellipsis` |
| 右 | 时间 | `ts` 格式化为 `HH:mm:ss`，`--qq-text-2xs` `--qq-color-text-muted`，`title` 属性给完整 ISO 串 |

`trace_id` 不上卡面。鼠标悬停卡头时在 `title` 里带上 `trace_id`，方便对着后端日志排查；`id` 同理。

### 折叠态的一行摘要

| type | 摘要取值 |
|---|---|
| `filter` | `payload.input_preview` |
| `write` | `payload.facts[0].text`；`facts.length > 1` 时后缀「等 N 条」 |
| `merge` | `payload.result_text` |
| `recall` | `payload.query` |

### 展开态

点卡体任意处切换展开。展开状态**按事件 `id` 记忆**，切换筛选或重连后保持。

**`filter`**

| 字段 | 呈现 |
|---|---|
| `decision` | 卡头徽章，「保留 / 丢掉 / 拿不准」 |
| `score` | 徽章右侧，保留两位小数，等宽字体 `--qq-font-mono` |
| `reason` | 正文一段，`--qq-text-sm` |
| `source` | 底部小字，`ambient_audio` → 「环境音」，`ambient_image` → 「摄像头」 |
| `input_preview` | 折叠态摘要，展开后完整显示，最多 4 行后截断 |

**`write`**

| 字段 | 呈现 |
|---|---|
| `speaker` | 卡头徽章右侧，「你」/「丘丘」 |
| `facts[]` | 每条一行：`text` 为主，行尾跟 `entities` 的标签胶囊（最多 3 个，超出显示 `+N`）；`valid_from` 格式化为 `YYYY-MM-DD`，`--qq-color-text-muted` |
| `dropped_spans[]` | 折叠在「丢掉了 N 段」下，展开后每段一行、`line-through`、`--qq-color-text-muted` |
| `raw` | 底部「看原话」折叠块，默认收起 |
| `facts[].id` | 不显示，放进行的 `data-fact-id`，供「跳到记忆库」用 |

**`merge`**

| 字段 | 呈现 |
|---|---|
| `result_text` | 第一行，`--qq-weight-medium` |
| `absorbed[]` | 「合并了 N 条」下逐行 `line-through`。只有 id 没有文本时显示 id 前 8 位 + 省略号 |
| `invalidated[]` | 「作废 N 条」下逐行 `line-through`，行尾跟 `valid_to` 的 `YYYY-MM-DD` |
| `result_id` | 不显示，放进 `data-memory-id` |

**`recall`**

| 字段 | 呈现 |
|---|---|
| `query` | 第一行 |
| `plan.rewritten` | `query` 下方，前缀「改写为」；与 `query` 相同则整行不渲染 |
| `plan.paths` + `skipped_paths` | 路径胶囊行，见 § 2 |
| `plan.depth` | 路径胶囊行末尾，「深度 N」 |
| `hits[]` | 每条一行：`path` 胶囊 + `score` 两位小数 + `id` 前 8 位。**没有文本字段**，所以只能显示 id；点击按 `id` 跳记忆库 |
| `tokens_injected` | 底部小字「注入 N tokens」 |
| `cold_promoted[]` | 右上角徽章 + 展开后的「回热 N 条」列表 |

`hits[]` 里没有可读文本是契约本身的形状，不是遗漏——`recall` 的可读性靠 `query` 与路径徽章承担。见 § 6。

### 空数组的处理

`facts` / `absorbed` / `invalidated` / `hits` / `dropped_spans` / `skipped_paths` / `cold_promoted` 为空数组时，对应的小节**整段不渲染**，不显示「0 条」。空态标题比空数据更吵。

## 4 · 滚动行为

事件流是纵向列表，**新事件追加在底部**，时间从上到下递增。

### 贴底判定

```
atBottom = (scrollHeight - scrollTop - clientHeight) <= 24
```

阈值 **24 px**，够容忍触控板惯性的一两像素抖动，又不至于把「用户刻意往上翻了一点」误判成贴底。

### 自动滚

| 情况 | 行为 |
|---|---|
| `atBottom === true` 时来了新事件 | 追加后 `scrollTop = scrollHeight`，无动画（`behavior: 'auto'`）。事件密集时平滑滚动会排队，越滚越慢 |
| `atBottom === false` 时来了新事件 | **不滚**。累计未读计数 +1 |
| 用户往上滚，离底超过 24 px | 自动滚暂停。底部浮出「N 条新事件 ↓」胶囊按钮 |
| 用户滚回底部 24 px 内 | 自动滚恢复，未读清零，胶囊按 `--qq-duration-fast` 淡出 |
| 点「N 条新事件 ↓」 | `scrollTo({ top: scrollHeight, behavior: 'smooth' })`，落底后恢复自动滚 |

胶囊按钮：`position: sticky; bottom: var(--qq-space-5)`，居中，`--qq-color-brand` 底、`--qq-color-on-brand` 字、`--qq-radius-full`、`--qq-shadow-3`、`z-index: var(--qq-z-sticky)`。

判定用的滚动事件加 `passive: true`，并用 rAF 节流，一帧最多算一次。

### 三条例外

1. **`filter.reject` 不打断阅读也不触发自动滚。** 被动采集每 3 秒一片，绝大多数是 reject（`docs/ARCHITECTURE.md` § 6）。它照常追加进列表、照常计入未读，但 `atBottom` 为真时**也不**执行滚动——否则用户永远读不完一张卡。下一条非 reject 事件到来时一次性滚到底。
2. **展开中的卡被钉住。** 用户展开了某张卡且它在视口内时，即使 `atBottom` 为真也暂停自动滚，直到卡被折叠或滚出视口。
3. **窗口尺寸变化不触发自动滚。** `resize` 只在 `atBottom` 为真时重新贴底一次。

### 列表上限

DOM 里最多保留 **500** 张卡。超出时从头部丢弃，并在列表顶部显示一条 `--qq-text-xs` `--qq-color-text-muted` 的「更早的事件已折叠」分隔行。丢弃只发生在 `atBottom === true` 时——用户正在往上翻的时候把他脚下的内容删掉是最糟糕的体验。

断线重连按 `docs/CONTRACTS.md` § 1 用 `since=<最后一条事件的自增 id>` 续传，补齐的事件按 `id` 升序追加，不去重（`id` 唯一，重复到达时按 `id` 丢弃后到的那条）。

## 5 · 阈值滑块

对应 `GET /config/thresholds` 与 `PUT /config/thresholds`。

### 位置

阈值区在标题栏正下方、事件流上方，默认**折叠**，标题栏右侧一个齿轮图标切换。展开高度 128 px，展开与折叠走 `--qq-duration-base` + `--qq-ease-standard` 的高度过渡。

折叠时，标题栏齿轮右侧显示当前两个值的紧凑形式，例如 `0.72 / 0.45`，`--qq-text-2xs` `--qq-font-mono`。

### 两个滑块

被动采集的筛选按 `payload.score` 分三档，两个阈值切三段：

| 滑块 | 键 | 范围 | 步长 | 默认 | 含义 |
|---|---|---|---|---|---|
| 保留线 | `accept` | 0.00 – 1.00 | 0.01 | **0.72** | `score >= accept` → `accept` |
| 丢弃线 | `uncertain` | 0.00 – 1.00 | 0.01 | **0.45** | `uncertain <= score < accept` → `uncertain`；`score < uncertain` → `reject` |

约束：`uncertain` 不得大于 `accept - 0.05`。拖动任一个越界时把另一个顶着走，不弹错误。

轨道用三段渐变直观表达三个区间，颜色从左到右 `--qq-color-reject` → `--qq-color-uncertain` → `--qq-color-write`，两个滑块手柄骑在分界上。手柄 16 px 圆、`--qq-shadow-2`、`--qq-color-surface` 底、`--qq-border-thick` 的 `--qq-color-border-strong` 描边。

键盘：聚焦后 `←/→` 步进 0.01，`PageUp/PageDown` 步进 0.10，`Home/End` 到端点。焦点环用 `.qq-focusable`。

### 实时反馈

拖动过程中**不发请求**，只做本地预演：

1. **重新着色。** 对列表里已有的每条 `filter` 事件，用新阈值和它自己的 `payload.score` 重算档位，卡的竖条与背景立刻按 § 2 改色。这是纯展示层重算，不改数据、不改 `payload.decision` 的原值。
2. **数一下差异。** 滑块下方一行 `--qq-text-xs`：「按这个阈值，最近 50 条里 12 条会从丢掉变成拿不准」。数字随拖动实时更新；没有差异时这行文案换成「与当前一致」。
3. **色带同步。** 轨道的三段渐变分界跟着手柄走。

松手（`pointerup` / 键盘操作结束）后 **debounce 300 ms** 发 `PUT /config/thresholds`：

- 成功：卡片颜色保持预演结果，`--qq-text-xs` 提示「已生效，只影响之后的采集」，3 s 后淡出
- 失败：滑块回弹到请求前的值，卡片颜色一并还原，按 `docs/CONVENTIONS.md` 的要求显示带 `hint` 的错误行

**已经落库的事件不会被重判。** 阈值只作用于之后到达的采集，界面必须把这点说出来——否则用户会以为拖动滑块能把昨天丢掉的话捡回来。

## 6 · 契约缺口

三处，都不在本文自行修改 `docs/CONTRACTS.md`，交主调度决定。

1. **`/config/thresholds` 的 body 形状没定义。** § 1 只给了路由名，没给 schema。本文按侧栏需要假定为 `{ "accept": number, "uncertain": number }`，两个值都是 `0–1` 的浮点，语义与 `filter` payload 的 `score` 同一把尺子。`backend` 若采用别的形状，本文 § 5 的滑块要跟着改。
2. **`recall` 的 `hits[]` 没有文本字段。** 结构是 `{ id, path, score }`，侧栏只能显示 id 前 8 位，「想起了什么」这件事在界面上是看不见的——而这恰好是排序第一的质量属性要展示的东西。建议给 `hits[]` 增补一个 `text` 或 `preview` 字段。在契约改动之前，§ 3 按现状实现。
3. **`merge` 的 `absorbed[]` 只有 id。** 「旧条划线」这个视觉要求（任务书原文）需要旧事实的文本才能划得出来。`invalidated[]` 同理，只有 `{ id, valid_to }`。当前退化为划掉 id 前 8 位。建议与第 2 条一起处理。
