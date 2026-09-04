#!/usr/bin/env bash
# 全链路冒烟：主调度每次合并后跑。M2 之前只检查能起来，M3 起加记忆闭环断言。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/5] Python 依赖与 lint"
uv sync --quiet
uv run ruff check packages services
uv run ruff format --check packages services

echo "[2/5] 单元测试"
# 退出码 5 = 还没有测试用例，骨架阶段允许
uv run pytest -q packages services || [ $? -eq 5 ]

echo "[3/5] 后端可起（mock 模型）"
MODELS_MOCK=1 uv run python -m qiuqiu_api.main --check

echo "[4/5] 前端依赖"
pnpm install --silent --frozen-lockfile=false

echo "[5/5] 前端可构建"
pnpm --filter @qiuqiu/character build
pnpm --filter @qiuqiu/web build

echo "smoke ok"
