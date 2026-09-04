#!/usr/bin/env bash
# 全链路冒烟：主调度每次合并后跑。M2 之前只检查能起来，M3 起加记忆闭环断言。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] Python 依赖与 lint"
uv sync --quiet
uv run ruff check packages services

echo "[2/4] 单元测试"
uv run pytest -q packages services

echo "[3/4] 后端可起（mock 模型）"
MODELS_MOCK=1 uv run python -m services.api.main --check

echo "[4/4] 前端可构建"
pnpm --filter ./apps/web build --silent

echo "smoke ok"
