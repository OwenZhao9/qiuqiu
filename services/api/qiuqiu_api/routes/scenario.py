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
from ..scenarios import list_scenarios, load_scenario, play
from ..state import new_trace_id

router = APIRouter(tags=["scenario"])


class PlayIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float = Field(default=1.0, ge=0.0, le=1000.0)


@router.get("/scenarios")
async def list_all(state: StateDep) -> list[dict[str, str]]:
    """列出可回放的场景。契约 v0.1.8 § 1 收编——原先只在 `scenarios/README.md` 里，
    前端只能把四个场景名写死在代码里。`title` 读脚本自己的，读不出就退回名字。"""
    out: list[dict[str, str]] = []
    for name in list_scenarios(state.config.scenarios_dir):
        try:
            scenario = load_scenario(state.config.scenarios_dir, name)
            title = scenario.title or name
        except Exception:  # noqa: BLE001 - 单个脚本坏了不该让整张列表挂掉
            title = name
        out.append({"name": name, "title": title})
    return out


@router.post("/scenario/{name}/play")
async def play_scenario(name: str, state: StateDep, body: PlayIn | None = None) -> dict[str, Any]:
    scenario = load_scenario(state.config.scenarios_dir, name)
    speed = (body or PlayIn()).speed
    return await play(state, scenario, speed=speed, trace_id=new_trace_id())
