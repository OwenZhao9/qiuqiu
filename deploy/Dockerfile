# 托管版镜像：前端静态产物 + 后端 API 一个进程端出去。
#
# 分两段构建：Node 段只负责 `vite build`，产物拷进 Python 段，
# 最终镜像里不留 node_modules（那是几百 MB）。

# ---------- 前端 ----------
FROM node:20-slim AS web
WORKDIR /src
RUN corepack enable
# 先拷清单再装依赖：改代码不改依赖时这一层能命中缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY packages/character/package.json packages/character/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @qiuqiu/character build && pnpm --filter @qiuqiu/web build

# ---------- 后端 ----------
FROM python:3.12-slim
# uv 装依赖比 pip 快一大截，而且直接认这个仓库的 uv.lock
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH=/app/.venv/bin:$PATH \
    QIUQIU_WEB_DIR=/app/web

# 先只拷依赖清单，锁文件不变时这一层命中缓存
COPY pyproject.toml uv.lock ./
COPY packages/data/pyproject.toml packages/data/
COPY packages/memory/pyproject.toml packages/memory/
COPY packages/models/pyproject.toml packages/models/
COPY services/api/pyproject.toml services/api/
RUN uv sync --frozen --no-install-workspace

COPY packages/ packages/
COPY services/ services/
COPY deploy/ deploy/
RUN uv sync --frozen

COPY --from=web /src/apps/web/dist /app/web

# 数据落这儿。平台给不给持久卷都能跑——给了就留着，没给就每次重启从空库开始，
# 对演示来说反而干净
ENV DATA_DIR=/data
RUN mkdir -p /data && chmod 777 /data

# Hugging Face Spaces 默认探 7860；别的平台用 $PORT
ENV PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "uvicorn deploy.server:app --host 0.0.0.0 --port ${PORT:-7860}"]
