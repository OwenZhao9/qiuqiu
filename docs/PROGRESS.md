# 进度看板

主调度 Agent 维护。每个分支一行，每次合并后更新。

| 分支 | 当前里程碑 | 状态 | 阻塞项 | 需要谁配合 |
|---|---|---|---|---|
| design | M2 骨架可跑 | 进行中 | — | — |
| models | M2 骨架可跑 | 已合并 | — | — |
| data | M2 骨架可跑 | 进行中 | — | — |
| memory | M2 骨架可跑 | 未开始 | 等 models、data 合并 | 等 models、data |
| backend | M2 骨架可跑 | 未开始 | 等 memory、models 合并 | 等 memory、models |
| character | M2 骨架可跑 | 未开始 | 等 design 合并 | 等 design |
| frontend | M2 骨架可跑 | 未开始 | 等 backend、character 合并 | 等 backend、character |

## 契约版本

当前 `CONTRACTS.md` **v0.1.3**。各分支在 PR 描述里声明依赖版本。

v0.1.3 的四条改动来自 `models` 分支报的契约缺口，由主调度裁决：

1. `run_metrics` 增 `provider` 列（任务书要求 mock 也记且 `provider=mock`，§ 5 原表少这列）
2. 补 `GET /providers` 的响应体形状 `ProviderInfo`，直接透传 `registry.list_providers()`
3. § 4 定死 `stream()` / `synthesize()` 的异步形状：**async 函数返回异步迭代器**，调用方写 `async for x in await chat.stream(msgs)`。`events()` 是普通 `def`，不 await
4. § 4 补齐 `Message` `Transcript` `PartialTranscript` `VadResult` `AudioChunk` `RealtimeEvent` 的字段，以及模型层错误带 `hint` 且 key 已脱敏的约定

## 下一步

M2 骨架可跑：后端起得来、前端起得来、丘丘在页面上会眨眼、mock 模型能对话。

合并顺序按 ARCHITECTURE.md 第 5 节依赖图分四波：

1. `design` `models` `data`（无相互依赖，并行）—— models 已合并
2. `memory` `character`
3. `backend`
4. `frontend`

## 合并记录

| 时间 | 分支 | 提交 | 契约版本 | 冒烟 |
|---|---|---|---|---|
| 2026-09-05 | （主调度）工作区骨架 | `394ed07` | v0.1.2 | 通过 |
| 2026-09-05 | （主调度）契约 v0.1.3 | `60c645c` | v0.1.3 | — |
| 2026-09-05 | models | squash 4 个提交 | v0.1.3 | 通过（91 用例） |

## 主调度自己做的决定

- **根工作区由主调度建**：`pyproject.toml`（uv 工作区，四个 Python 成员）、`pnpm-workspace.yaml`、`package.json`、`tsconfig.base.json`、`.python-version`。理由：七个分支同时改根配置必冲突，且这是集成基础设施不是业务代码。分支只改自己 `pyproject.toml` / `package.json` 里的依赖
- **后端包名定为 `qiuqiu_api`**，目录仍是 `services/api/`（架构文档只定目录没定包名），与 `qiuqiu_data` / `qiuqiu_memory` / `qiuqiu_models` 一致，各自是独立 workspace 成员，各管各的依赖。`scripts/smoke.sh` 第 3 步相应改为 `python -m qiuqiu_api.main --check`
- **`scripts/smoke.sh` 扩成五步**：lint + format 检查、pytest、后端自检、pnpm 安装、前端构建。骨架阶段 pytest 无用例（退出码 5）判为通过
- **M2 范围裁剪**：`models` 本轮只做 base / registry / metrics / mock / DeepSeek Chat 与 Vision；ASR、VAD、TTS、Seedream、RealtimeVoice 六个真实供应商推迟到 M5，registry 已留分支且缺失时抛带 `hint` 的错误（按 AD-16，不静默换 mock）
