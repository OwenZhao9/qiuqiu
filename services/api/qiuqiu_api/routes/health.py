"""`GET /health`：起没起来、哪几项能力缺着。

ARCHITECTURE § 3 要求权重缺失时「语音输入不可用，其余照常，`/health` 报告缺失项」，
所以这里把 `registry.list_providers()` 整个带出去，外加一份缺失清单，前端不用自己筛。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import __version__
from ..config import voice_mode
from ..deps import StateDep

router = APIRouter(tags=["health"])

CONTRACT_VERSION = "v0.1.7"
"""本服务实现的契约版本。改契约先改 `docs/CONTRACTS.md`，再改这里。"""


@router.get("/health")
async def health(state: StateDep) -> dict[str, Any]:
    from qiuqiu_models import registry

    providers = registry.list_providers()
    missing = [p["capability"] for p in providers if not p.get("available")]
    chat_ok = any(p["capability"] == "chat" and p.get("available") for p in providers)
    return {
        "status": "ok" if chat_ok else "degraded",
        "version": __version__,
        "contract": CONTRACT_VERSION,
        "uptime_s": round(state.uptime_s, 3),
        "voice_mode": voice_mode(),
        "data_dir": str(state.stores.paths.root),
        "models": providers,
        "missing": missing,
    }
