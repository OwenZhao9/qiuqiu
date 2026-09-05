"""`/config/thresholds` 读写。热生效，落 SQLite `settings`。

`settings` 是后端归属表（ARCHITECTURE § 7），但**取值的解释权在记忆层**：写进去的键
就是 `qiuqiu_memory.runtime.Thresholds` 读的那个键，它每次判定都回 SQLite 拿，所以
`PUT` 完下一条被动采集立刻按新阈值筛，不用重启也不用通知谁。

判定规则（CONTRACTS § 1）：`score >= accept` 留，`score >= uncertain` 拿不准，否则丢。
所以 `accept < uncertain` 会让「拿不准」这一档永远取不到，这里当参数错挡掉。
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import StateDep
from ..errors import BadRequest

router = APIRouter(prefix="/config", tags=["config"])
log = structlog.get_logger("qiuqiu_api.config")

SETTINGS_KEY = "thresholds"
"""与 `qiuqiu_memory.runtime.Thresholds` 读的键同名，改名要两边一起改。"""


class ThresholdsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accept: float = Field(ge=0.0, le=1.0)
    uncertain: float = Field(ge=0.0, le=1.0)


def _current(state: Any) -> dict[str, float]:
    thresholds = state.runtime.thresholds
    return {"accept": thresholds.accept, "uncertain": thresholds.uncertain}


@router.get("/thresholds")
async def get_thresholds(state: StateDep) -> dict[str, float]:
    return await state.off_loop(_current, state)


@router.put("/thresholds")
async def put_thresholds(body: ThresholdsIn, state: StateDep) -> dict[str, float]:
    if body.accept < body.uncertain:
        raise BadRequest(
            f"accept（{body.accept}）不能小于 uncertain（{body.uncertain}）。",
            hint="判定是 score >= accept 留、>= uncertain 拿不准，"
            "accept 更小的话「拿不准」永远取不到。把 accept 调到 uncertain 之上。",
            code="thresholds.inverted",
        )
    payload = {"accept": body.accept, "uncertain": body.uncertain}
    state.sqlite.set_setting(SETTINGS_KEY, json.dumps(payload, ensure_ascii=False))
    log.info("thresholds.updated", **payload)
    return await state.off_loop(_current, state)
