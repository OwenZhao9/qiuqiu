# 开发规范

## 版本

- Python 3.12，包管理 `uv`，代码风格 `ruff`（format + lint），测试 `pytest`
- Node 20 LTS，包管理 `pnpm`，TypeScript 5，格式 `prettier`，测试 `vitest`
- Electron 33，React 18，Vite 5

## 目录归属

每个 Agent 只能改自己分支对应的目录，加上 `docs/` 里自己的任务书。改契约走 `docs/CONTRACTS.md`，需要主调度审。

| 分支 | 可改 | 不可改 |
|---|---|---|
| `design` | `design/` | 任何代码目录 |
| `frontend` | `apps/desktop` `apps/web` | `packages/*` `services/*` |
| `backend` | `services/api` | `packages/*` `apps/*` |
| `data` | `packages/data` | 其他 |
| `memory` | `packages/memory` | 其他 |
| `models` | `packages/models` | 其他 |
| `character` | `packages/character` | 其他 |

需要别的模块改接口，在自己 PR 描述里写清楚，主调度协调。

## 分支流程

1. 从 `main` 切自己的分支（已建好，直接用）
2. 小步提交，每个提交能独立描述
3. 完成一个功能点就发 PR 到 `main`，不攒大 PR
4. PR 必须过 CI（lint + 测试）
5. 主调度审后合并，合并用 squash

## 提交信息

Conventional Commits，中文或英文都行，但同一分支保持一致：

```
feat(memory): 事件总线支持断线续传
fix(frontend): 桌宠窗口在 Windows 上透明失效
docs(contracts): recall 事件增加 cold_promoted 字段
```

**不署名 AI。** 提交信息和 PR 描述里不出现 Co-Authored-By 或 Generated with 之类的行。

## 密钥

- 永远不提交 `.env`，只提交 `.env.example`
- 代码里不出现任何真实 key，包括测试
- 后端不把 key 回传前端，`/providers` 返回 `has_key: true/false`

## 测试要求

| 模块 | 最低要求 |
|---|---|
| `packages/memory` | 六个环节各有单测；`MemoryFacade` 五个方法有集成测试；事件格式与 CONTRACTS 一致的契约测试 |
| `packages/data` | schema 迁移可重复执行；冷热迁移有时间模拟测试 |
| `packages/models` | 每个适配器有 mock 供应商的单测；真实供应商测试标 `@pytest.mark.live`，CI 不跑 |
| `services/api` | 每条路由有冒烟测试；SSE 流有断线续传测试 |
| `apps/web` | 关键组件有渲染测试；SSE 解析有单测 |
| `packages/character` | 表情映射表与 CONTRACTS § 6 一致的契约测试 |

## 日志与错误

- Python 用 `structlog`，JSON 格式，每条带 `trace_id`
- 前端用 `console` 分级，生产构建去掉 debug
- 用户可见的错误必须带 `hint`（下一步能做什么），不只说「失败了」

## 文档同步

改了行为就改文档。`docs/ARCHITECTURE.md`、`docs/product-map.html`、`docs/architecture.html` 三者说同一件事，改一个同步另外两个。

- 架构决策编号 AD-n 永不重编；废弃的决策留空号，注明被哪条取代
- 快照性质的表格（技术栈、目录树、模型选型）上方必须有一行「快照：写于日期，代码存在后以代码为准」

## PR 检查清单

- [ ] 只改了自己目录
- [ ] 契约有变动的话 `CONTRACTS.md` 已同步，版本号已升
- [ ] 测试通过
- [ ] 没有真实 key
- [ ] 提交信息没有 AI 署名
- [ ] PR 描述写了：做了什么、依赖哪个契约版本、需要其他分支配合什么
