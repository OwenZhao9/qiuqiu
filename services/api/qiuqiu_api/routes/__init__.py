"""HTTP 与 WebSocket 路由。一条路由一个模块，事件名与字段严格按 CONTRACTS § 1。"""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    blobs,
    chat,
    compare,
    events,
    health,
    ingest,
    memories,
    persona,
    providers,
    scenario,
    thresholds,
    voice,
)

__all__ = ["API_PATHS", "MODULES", "api_router"]

MODULES = (
    health,
    chat,
    events,
    ingest,
    memories,
    persona,
    thresholds,
    providers,
    blobs,
    scenario,
    compare,
    voice,
)

api_router = APIRouter()
for _module in MODULES:
    api_router.include_router(_module.router)

API_PATHS: tuple[str, ...] = tuple(
    sorted({r.path for m in MODULES for r in m.router.routes if hasattr(r, "path")})
)
"""全部路径。Starlette 挂载之后会把 router 收成一个整体，从这里数才数得到。"""
