# 进度看板

主调度 Agent 维护。每个分支一行，每次合并后更新。

| 分支 | 当前里程碑 | 状态 | 阻塞项 | 需要谁配合 |
|---|---|---|---|---|
| design | **M2 完成** | 已合并 | — | — |
| models | **M2 完成** | 已合并 | — | — |
| data | **M2 完成** | 已合并 | — | — |
| memory | **M2 完成** | 已合并 | — | — |
| character | **M2 完成** | 已合并 | — | — |
| backend | **M2 完成** | 已合并 | — | — |
| frontend | **M2 完成** | 已合并 | — | — |

## 契约版本

当前 `CONTRACTS.md` **v0.1.8**。各分支在 PR 描述里声明依赖版本。

六轮升版都来自分支报上来的契约缺口，由主调度裁决。每轮的逐条内容在 `docs/CONTRACTS.md` § 8 的版本历史里，这里只记来源与影响面：

**v0.1.3**（`models` 报的）

1. `run_metrics` 增 `provider` 列（任务书要求 mock 也记且 `provider=mock`，§ 5 原表少这列）
2. 补 `GET /providers` 的响应体形状 `ProviderInfo`，直接透传 `registry.list_providers()`
3. § 4 定死 `stream()` / `synthesize()` 的异步形状：**async 函数返回异步迭代器**，调用方写 `async for x in await chat.stream(msgs)`。`events()` 是普通 `def`，不 await
4. § 4 补齐 `Message` `Transcript` `PartialTranscript` `VadResult` `AudioChunk` `RealtimeEvent` 的字段，以及模型层错误带 `hint` 且 key 已脱敏的约定

**v0.1.4**（`data` 报的）

1. `facts.speaker` 取值域定为 `user` \| `assistant`；`facts.source` 定为 § 3 `Source` 枚举的 value；`visible_memory.layer` 定为 `L0` \| `L1` \| `L2`
2. 点明 `vector` 的 1024 维是破坏性契约，改维度要重建表并升主版本
3. 新增「数据层接口」小节，把 `touch` `delete_rows` `get_many` 等 memory 必需但契约漏写的方法收进来

**v0.1.5**（`design` 报的）

1. `recall.hits[]` 每项增 `text`；`merge.absorbed[]` 从 `string[]` 变 `[{id, text}]`，`invalidated[]` 增 `text`。**理由**：侧栏只拿到 id 就显示不出「想起了什么 / 哪条被划掉」，而「记忆过程看得见」是 ARCHITECTURE 第 1 节排序第一的质量属性，缺文本等于这条落空
2. 补 `/config/thresholds` 的 body：`{ accept: number, uncertain: number }`，默认 `0.72` / `0.45`
3. § 6 写明 `feedEnvelope` 驱动的是**容器级发声脉动，不是嘴巴张合**——Emotion Ball 的形象没有嘴，引擎也不暴露逐帧姿态写入口
4. § 6 写明主题色**不能走 `opts.color`**，引擎每帧覆写体色会废掉 `21` 变红、`14` 变粉、`34` 红白闪；改用 `EmotionBall.config.register()` 打纯数据补丁

## 下一步

**M2 骨架可跑：完成。** 七个分支全部合入 main，冒烟通过。实际启动验证过的链路：

- 后端起得来，21 条路由都在，自检报 `ok`
- 发一句话 → SSE 的 `meta` / `delta` / `done` 按序到达 → 用户与 AI 两句都写进记忆
- 「我叫赵宁，我喜欢喝美式咖啡」压成两条自包含事实，代词已解析
- 第二轮「我喜欢喝什么」召回命中两条，`memory_used=true`
- 会话历史读得回来，两个角色都在
- 静音片段被 VAD 拦下，侧栏留下 `filter.reject` 事件
- 环境音记在 `ambient` 名下，不是 `user`

**M3 记忆闭环**要 `.env` 里有 `DEEPSEEK_API_KEY`——压缩、合成、检索规划、性格归纳都要调
Chat，mock 出的是固定文本，测不出真实效果。**卡在这里，等用户填 key。**

M3 开工时先做这几件（v0.1.8 推迟下来的）：

- 「拿不准」的原文停在哪里等用户决定。定了才谈得上 `uncertain` 卡的「留下 / 丢掉」——
  现在事件里只剩 80 字截断的 preview，照它留下会把用户的话记歪
- `scenarios/` 下四个场景的 JSON。`design` 的任务书说场景内容由它定，本轮没交，
  所以 `GET /scenarios` 现在返回空列表，前端退回四个兜底名

## 合并记录

| 时间 | 分支 | 提交 | 契约版本 | 冒烟 |
|---|---|---|---|---|
| 2026-09-05 | （主调度）工作区骨架 | `394ed07` | v0.1.2 | 通过 |
| 2026-09-05 | （主调度）契约 v0.1.3 | `60c645c` | v0.1.3 | — |
| 2026-09-05 | models | squash 4 个提交 | v0.1.3 | 通过（91 用例） |
| 2026-09-05 | data | squash 6 个提交 | v0.1.3 | 通过（158 用例） |
| 2026-09-05 | （主调度）契约 v0.1.4 | `9022d1c` | v0.1.4 | — |
| 2026-09-05 | （主调度）契约 v0.1.5 | `0f54e6f` | v0.1.5 | — |
| 2026-09-05 | design | squash 7 个提交 | v0.1.5 | 通过（仅文档） |
| 2026-09-05 | （主调度）契约 v0.1.6 | `352937d` | v0.1.6 | — |
| 2026-09-05 | character | `48106fa` + `3121c40` | v0.1.6 | 通过（190 用例） |
| 2026-09-05 | （主调度）契约 v0.1.7 | `e00b924` | v0.1.7 | — |
| 2026-09-05 | memory | `4509890` + `5b50bff` | v0.1.7 | 通过 |
| 2026-09-05 | data 补丁 | `a087642` | v0.1.7 | 通过 |
| 2026-09-05 | character 契约钉子 | `86a9819` | v0.1.7 | 通过（190 用例） |
| 2026-09-05 | backend | squash 4 个提交 | v0.1.7 | 通过（85 用例） |
| 2026-09-05 | （主调度）契约 v0.1.8 | `15ba08f` | v0.1.8 | — |
| 2026-09-05 | frontend | squash 5 个提交 | v0.1.7 | 通过（155 用例） |
| 2026-09-05 | （主调度）三个分支对齐 v0.1.8 | `7b02512` `7af15c2` `6878f0b` | v0.1.8 | 通过（Python 599 + 前端 348） |

## 主调度自己做的决定

- **根工作区由主调度建**：`pyproject.toml`（uv 工作区，四个 Python 成员）、`pnpm-workspace.yaml`、`package.json`、`tsconfig.base.json`、`.python-version`。理由：七个分支同时改根配置必冲突，且这是集成基础设施不是业务代码。分支只改自己 `pyproject.toml` / `package.json` 里的依赖
- **后端包名定为 `qiuqiu_api`**，目录仍是 `services/api/`（架构文档只定目录没定包名），与 `qiuqiu_data` / `qiuqiu_memory` / `qiuqiu_models` 一致，各自是独立 workspace 成员，各管各的依赖。`scripts/smoke.sh` 第 3 步相应改为 `python -m qiuqiu_api.main --check`
- **`scripts/smoke.sh` 扩成五步**：lint + format 检查、pytest、后端自检、pnpm 安装、前端构建。骨架阶段 pytest 无用例（退出码 5）判为通过
- **M2 范围裁剪**：`models` 本轮只做 base / registry / metrics / mock / DeepSeek Chat 与 Vision；ASR、VAD、TTS、Seedream、RealtimeVoice 六个真实供应商推迟到 M5，registry 已留分支且缺失时抛带 `hint` 的错误（按 AD-16，不静默换 mock）
- **无人值守跑法留在仓库里**：`scripts/run.sh` 按顺序跑 `scripts/prompts/` 下的阶段，额度用完时 `claude -p` 报错退出，等 30 分钟重试。`.claude/settings.json` 把 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 设为 `0`——不设的话 `-p` 模式下主调度收工后子 Agent 最多再跑 600 秒就被掐掉，实测掐掉过两次
- **v0.1.8 否掉了两个分支的权宜做法**，理由都不是风格问题，是会让演示失效：
  后端把环境音一律记成 `user`，可 `multi-person` 演示里客厅有三个人；后端让 VAD
  拦下的片段不发事件，可 `ambient-noise` 演示要看的正是这些拒绝，侧栏会是空的
- **主调度自己查出一条分支没报的缺口**：`/events` 靠 `await asyncio.sleep(0)` 让两次
  去等订阅注册完成。实测一次就够、两次是余量，但这把后端的正确性绑在中间件的内部
  实现上——注册与补发之间有窗口就会静默丢事件。改成 `subscribe()` 同步注册，
  并加了一条测试钉住「返回时订阅必须已经在册」
- **`uncertain` 的「留下 / 丢掉」推迟到 M3**，是我自己的裁决收回：v0.1.8 一度收编了
  `POST /events/{id}/resolve`，写实现时才发现 v0.1.7 定的「`uncertain` 不落库」意味着
  只剩 80 字截断的 preview，照它「留下」会把用户的话记歪。半working 的路由比没有更糟
- **第三波并行的代价兑现了**：前端按 v0.1.7 写完，v0.1.8 动了 § 1 与 § 2，回头改了
  `api.ts`、`mock-server.ts`、`SettingsPage.tsx` 三处。因为 HTTP 收发全关在 `api.ts` 里，
  组件基本没动。这个对冲有效
