#!/usr/bin/env bash
# 无人值守：按顺序跑 scripts/prompts/ 下的阶段。额度用完时 claude 报错退出，等 30 分钟重试。
# 每个阶段由 Agent 自己在完成时创建 .run/<阶段>.done，脚本据此进入下一阶段。
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run
for phase in 01-restructure 02-develop; do
  marker=".run/${phase}.done"
  while [ ! -f "$marker" ]; do
    echo "[$(date '+%F %T')] 开始阶段 $phase"
    if claude -p "$(cat "scripts/prompts/${phase}.md")" --dangerously-skip-permissions 2>&1 | tee -a ".run/${phase}.log"; then
      [ -f "$marker" ] || { echo "[$(date '+%F %T')] 阶段 $phase 退出但未标记完成，60 秒后重跑"; sleep 60; }
    else
      echo "[$(date '+%F %T')] claude 非正常退出，多半是额度用完，30 分钟后重试"; sleep 1800
    fi
  done
  echo "[$(date '+%F %T')] 阶段 $phase 完成"
done
