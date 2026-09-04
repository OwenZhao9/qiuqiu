# 进度看板

主调度 Agent 维护。每个分支一行，每次合并后更新。

| 分支 | 当前里程碑 | 状态 | 阻塞项 | 需要谁配合 |
|---|---|---|---|---|
| design | M1 契约冻结 | 未开始 | — | — |
| models | M1 契约冻结 | 未开始 | — | — |
| data | M1 契约冻结 | 未开始 | — | — |
| memory | M1 契约冻结 | 未开始 | — | 等 models、data |
| backend | M1 契约冻结 | 未开始 | — | 等 memory、models |
| character | M1 契约冻结 | 未开始 | — | 等 design |
| frontend | M1 契约冻结 | 未开始 | — | 等 backend、character |

## 契约版本

当前 `CONTRACTS.md` v0.1.0。各分支在 PR 描述里声明依赖版本。

## 合并记录

（空）
