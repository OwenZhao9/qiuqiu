# 设计 Agent · `design`

产出规范，不产出代码。你的文件是 `character` 和 `frontend` 的输入。

## 目录

只改 `design/`。

## 先读

- `docs/ARCHITECTURE.md` 全文
- `docs/CONTRACTS.md` § 6 表情映射、§ 7 人格合成
- Emotion Ball 的 [README](https://github.com/sam70361/aora-bot)，重点是 32 个 emotionId 的分组与含义

## 交付物

### `design/character.md` · 丘丘

- 形象引用 Emotion Ball，形态用 `blob`，主题色定一个（给出 hex），眼色定一个
- 尺寸：桌宠窗口内 200×200，主窗口内 120×120，网页端 160×160
- 闲置策略：多久进待机、多久进睡眠，对应 emotionId
- 授权说明：形象非商业，写明来源与限制

### `design/state-machine.md` · 角色状态机

四态：`idle` / `listening` / `thinking` / `speaking`。给出：
- 每个状态的进入条件、退出条件
- 每个状态对应的 emotionId（与 CONTRACTS § 6 一致）
- 状态切换的最短停留时间（避免抖动）
- `speaking` 状态下口型如何由 TTS 音量包络驱动：包络值 → 嘴巴张合参数的映射曲线

### `design/emotion-rules.md` · 情绪推断规则

回复文本 → `10–21` 区间 emotionId 的规则表。每条规则：触发关键词或模式、对应 ID、优先级。要求：
- 至少覆盖：开心、疑惑、失落、惊讶、害羞、无奈、满意、困惑、生气
- 默认回退 `02` 待机
- 规则用正则表达，`character` 分支直接翻译成代码

### `design/memory-panel.md` · 记忆事件侧栏

- 四类事件的视觉：`filter.reject` 灰、`filter.uncertain` 黄、`write` 高亮、`merge` 旧条划线、`recall` 标路径
- 每条事件显示哪些字段（从 CONTRACTS § 1 payload 里选）
- 滚动行为：新事件追加在底部并自动滚到底；用户手动上滚时暂停自动滚
- 阈值滑块：位置、范围、实时反馈方式

### `design/interaction.md` · 交互规范

- 桌宠：单击展开输入条、按住拖动、右键菜单、Esc 收起
- 输入条：回车发送、Shift+回车换行、语音按钮按住说话、拖入图片
- 主窗口三栏布局与响应式断点
- 网页端与桌面端的差异清单

### `design/tokens.css` · 设计令牌

颜色、字号、间距、圆角、阴影的 CSS 变量，明暗两套。`frontend` 直接引。

## 约束

- 不改 Emotion Ball 的形象文件，只定参数
- 所有 emotionId 必须是 Emotion Ball 已有的 32 个之一，不发明新 ID
- 规范里的每个数值都要能直接写进代码，不写「适当」「合理」

## 验收

- `character` 分支能只看你的文档就实现状态机与情绪推断，不需要再问
- `frontend` 分支能只看 `tokens.css` 和 `interaction.md` 就实现界面，不需要再问
