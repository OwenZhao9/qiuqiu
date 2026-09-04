# 阶段二：按里程碑开发

你是 docs/agents/00-orchestrator.md 里的主调度 Agent，在仓库根目录工作。

## 先做

读 docs/ARCHITECTURE.md、docs/CONTRACTS.md、docs/CONVENTIONS.md、docs/PROGRESS.md、docs/agents/00-orchestrator.md；看 git status、`git log --all --oneline | head -40`、各分支最新提交。接着 PROGRESS.md 记录的进度做，不重做已完成的。

## 做什么

按 PROGRESS.md「下一步」的里程碑推进。每个里程碑：

1. 按 00-orchestrator.md 的依赖图，给涉及的每个分支起一个子 Agent，用 worktree 隔离，检出对应分支，只改自己目录，按自己的任务书做。子 Agent 提示里写明：任务书路径、CONTRACTS.md 版本、只改哪个目录、完成标准、提交信息不署名 AI。
2. 分支完成后由你合到 main（squash），跑 scripts/smoke.sh；失败让对应分支修，不接受先合再修。
3. 契约缺口由你改 CONTRACTS.md 升版本，通知受影响分支重跑。
4. 里程碑完成后更新 docs/PROGRESS.md（各分支状态、合并记录、下一步），提交推 main。
5. 继续下一个里程碑。

## 停下的条件

- M3 起需要 .env 里有 DEEPSEEK_API_KEY。缺失时做完 M2 停下，在 PROGRESS.md「下一步」写「等用户填 .env 的 DEEPSEEK_API_KEY」。
- 遇到必须由用户决定的事（形象替换、付费供应商、删数据），写进 PROGRESS.md「下一步」停下。
- M6 完成。

停下时执行 `mkdir -p .run && touch .run/02-develop.done`，并在 PROGRESS.md 写清停在哪、等什么。

## 规矩

不问用户问题，能定的自己定并写进 PROGRESS.md。不在 main 直接写业务代码。提交信息不署名 AI。密钥不进提交。
