# 进度看板

主调度 Agent 维护。每个分支一行，每次合并后更新。

| 分支 | 当前里程碑 | 状态 | 阻塞项 | 需要谁配合 |
|---|---|---|---|---|
| design | M2 骨架可跑 | 未开始 | — | — |
| models | M2 骨架可跑 | 未开始 | — | — |
| data | M2 骨架可跑 | 未开始 | — | — |
| memory | M2 骨架可跑 | 未开始 | — | 等 models、data |
| backend | M2 骨架可跑 | 未开始 | — | 等 memory、models |
| character | M2 骨架可跑 | 未开始 | — | 等 design |
| frontend | M2 骨架可跑 | 未开始 | — | 等 backend、character |

## 契约版本

当前 `CONTRACTS.md` v0.1.2。各分支在 PR 描述里声明依赖版本。

## 下一步

M2 骨架可跑：后端起得来、前端起得来、丘丘在页面上会眨眼、mock 模型能对话。合并顺序按 ARCHITECTURE.md 第 5 节依赖图：design、models、data 先，再 memory 与 character，再 backend，最后 frontend。

## 合并记录

（空）
