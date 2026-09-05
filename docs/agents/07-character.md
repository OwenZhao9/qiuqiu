# 角色 Agent · `character`

丘丘的表情引擎封装、状态机、事件到表情的映射、情绪推断。引擎引用 [Emotion Ball](https://github.com/sam70361/aora-bot)，你不改它的源码，只封装。

## 目录

`packages/character/`，TypeScript，导出给 `apps/web` 用。

## 先读

- `docs/CONTRACTS.md` § 6 表情映射
- `design/character.md` `design/state-machine.md` `design/emotion-rules.md`
- Emotion Ball 的集成指南：四个 JS 文件、`EmotionBall.create()`、`handleAIMessage()`

## 功能清单

### 引擎封装（`src/engine.ts`）

- [ ] 把 `rings.js` `emotions.js` `ball.js` `engine.js` 四个文件原样放 `vendor/emotion-ball/`，附原仓库 LICENSE 与 NOTICE
- [ ] `createQiuqiu(container, opts)`：调 `EmotionBall.create`，形态 `blob`，主题色与眼色从 `design/character.md` 读
- [ ] `setEmotion(id)`：调 `handleAIMessage({ emotionId })`，未知 ID 回退 `02`
- [ ] `destroy()`

### 状态机（`src/state-machine.ts`）

- [ ] 四态 `idle / listening / thinking / speaking`，转换规则按 `design/state-machine.md`
- [ ] `setState(s)`：切状态并调 `setEmotion` 到对应 ID
- [ ] 最短停留时间，避免抖动
- [ ] `speaking` 下 `feedEnvelope(rms)`：把音量包络映射到嘴巴参数，曲线按设计文档

### 事件映射（`src/event-map.ts`）

- [ ] `applyEvent(event: MemoryEvent)`：按 CONTRACTS § 6 表切表情
- [ ] `filter.reject` 不切换
- [ ] `recall` 有 `cold_promoted` 时用 `40`，否则 `37`
- [ ] 事件表情持续 1600ms 后回当前状态的表情（CONTRACTS § 6）

### 情绪推断（`src/emotion.ts`）

- [ ] `inferEmotion(replyText, userText?) -> EmotionId`，规则从 `design/emotion-rules.md` 翻译，无命中回退 `02`
- [ ] 回复结束时调用，结果经 `setEmotion` 应用，持续 1600ms 后回当前状态的表情；拒绝式命中时跳过情绪推断

### 导出（`src/index.ts`）

```ts
export { createQiuqiu, setEmotion, setState, feedEnvelope, applyEvent, inferEmotion };
export type { QiuqiuInstance, CharacterState, EmotionId };
```

## 约束

- 不修改 `vendor/emotion-ball/` 里任何文件
- 只用 Emotion Ball 已有的 32 个 ID
- 不依赖 React，纯 TS，`apps/web` 用 hook 包一层
- `vendor/` 附带的 LICENSE 与 NOTICE 必须保留

「不修改 vendor 文件」不等于「不能改丘丘的样子」。改样子的两条合法路子，都不碰 vendor 的源码：

1. **配色**走公开 API `EmotionBall.config.register()` 打纯数据补丁（`src/theme.ts`）
2. **装扮**（呆毛、蝴蝶结、腮红、眼高光、闪光）往引擎**运行时画出来的 SVG** 里插自己的节点，插完能原样摘干净（`src/costume.ts`）

第 2 条依赖 vendor 画出的 DOM 结构（`bodyG` 是唯一没有 `pointer-events="none"` 的直接子 `<g>`，里面三个 `<path>` 依次是身体、左眼、右眼）。vendor 是随仓库冻结的，不跟上游升级，所以这个依赖是稳的；`test/look.test.ts` 照这个结构搭了替身，结构一变测试就红。

Emotion Ball 的**视觉部分永久不可商用**，加装扮不改变这一条。

## 验收

- 在空白页面 `createQiuqiu()` 后丘丘出现、会眨眼、鼠标注视跟随
- `setState("thinking")` 切 `30`，`setState("speaking")` 切 `39`
- 喂一段 `write` 事件切 `10`，1600ms 后回当前状态的表情
- `feedEnvelope` 喂正弦波，嘴巴张合可见
- `inferEmotion("太好了！")` 返回 `10`，`inferEmotion("抱歉我做不到")` 返回 `12` 或 `18`（按设计文档）
- `vitest` 通过，含 CONTRACTS § 6 契约测试

## 受哪些 AD 约束

AD-1、AD-14

## 未解决的问题

**开工前必须定**：
- 事件表情与状态表情冲突时谁优先。已定：事件表情优先，持续时间到后回当前状态的表情；`speaking` 期间的口型不受事件表情影响

**边做边定，定完回报**：
- `feedEnvelope` 的包络平滑窗口
- 未知 emotionId 回退 `02` 时是否记 warn

## 与其他分支

- 依赖 `design` 的三份文档
- `frontend` 依赖你的导出
