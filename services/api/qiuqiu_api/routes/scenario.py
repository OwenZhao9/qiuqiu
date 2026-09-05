"""`POST /scenario/{name}/play`：按脚本时间轴回放一个演示场景。

时间偏移不改系统时钟：`clock_offset_days` 算进每一步的时刻，`ingest()` 的 `ts` 与
`recall()` 的 `now` 收的都是偏移后的那个值（见 `scenarios.py`）。

`speed` 是本轮加的旋钮，契约里没有：`1.0` 按脚本原速（前端能在 `/events` 上看到事件
一条条冒出来），`0` 不等待，一口气跑完——测试与「我只想看结果」用。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import StateDep
from ..scenarios import load_scenario, play
from ..state import new_trace_id

router = APIRouter(tags=["scenario"])


class PlayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float = Field(default=1.0, ge=0.0, le=1000.0)


@router.post("/scenario/{name}/play")
async def play_scenario(name: str, state: StateDep, body: PlayIn | None = None) -> dict[str, Any]:
    scenario = load_scenario(state.config.scenarios_dir, name)
    speed = (body or PlayIn()).speed
    return await play(state, scenario, speed=speed, trace_id=new_trace_id())
