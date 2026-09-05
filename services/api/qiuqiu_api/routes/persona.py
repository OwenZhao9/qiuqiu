"""`/persona` 四条。读写全经 `PersonaService`（AD-7），后端不碰人格快照那三个键。

`preset: null` 是**真空**不是中等值（AD-11），所以 `PUT /persona/preset` 的 body 里
`preset` 显式收 `None`，别把它当「没传」。

三个写接口都把改完的整份人格返回——契约只写了路由没写响应体，返回整份省前端一次 GET。
"""

from __future__ import annotations

from typing import Any, Literal

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import StateDep

router = APIRouter(prefix="/persona", tags=["persona"])
log = structlog.get_logger("qiuqiu_api.persona")

PresetId = Literal["warm", "quiet", "cute", "sassy"]


class PresetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preset: PresetId | None = None


class SlidersIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    initiative: int = Field(default=50, ge=0, le=100)
    verbosity: int = Field(default=50, ge=0, le=100)
    emotion: int = Field(default=50, ge=0, le=100)
    humor: int = Field(default=50, ge=0, le=100)


def _snapshot(state: Any) -> dict[str, Any]:
    persona = state.persona
    return {
        "preset": persona.preset,
        "sliders": persona.sliders.to_dict(),
        "learned": persona.learned.to_dict(),
        "current": persona.current(),
    }


@router.get("")
async def get_persona(state: StateDep) -> dict[str, Any]:
    return await state.off_loop(_snapshot, state)


@router.put("/preset")
async def put_preset(body: PresetIn, state: StateDep) -> dict[str, Any]:
    await state.off_loop(state.persona.set_preset, body.preset)
    log.info("persona.preset", preset=body.preset)
    return await state.off_loop(_snapshot, state)


@router.put("/sliders")
async def put_sliders(body: SlidersIn, state: StateDep) -> dict[str, Any]:
    from qiuqiu_memory import Sliders

    await state.off_loop(state.persona.set_sliders, Sliders(**body.model_dump()))
    log.info("persona.sliders", **body.model_dump())
    return await state.off_loop(_snapshot, state)


@router.post("/reset-learned")
async def reset_learned(state: StateDep) -> dict[str, Any]:
    await state.off_loop(state.persona.reset_learned)
    log.info("persona.reset_learned")
    return await state.off_loop(_snapshot, state)
