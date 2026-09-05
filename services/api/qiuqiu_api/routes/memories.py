"""`/memories` 三条：记忆库的用户可见层。

全部经 `MemoryFacade`（AD-7），路由里不碰事实表也不碰 `visible_memory` 表。
`DELETE` 落到 `edit_visible(mid, deleted=True)`（契约 v0.1.7 § 8 第 4 条定死的语义）：
该条 `enabled` 置否并对 `fact_ids` 逐条作废，**两边都不删行**（AD-9），所以这条
`DELETE` 会把改完的那条原样返回——前端拿它直接更新列表，不用再拉一次。
"""

from __future__ import annotations

from typing import Any, Literal

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from ..deps import StateDep
from ..errors import BadRequest

router = APIRouter(tags=["memories"])
log = structlog.get_logger("qiuqiu_api.memories")

#: `PATCH` 能改的字段。`id` 与 `updated_at` 由中间件维护，不接受外部改写。
EDITABLE = ("content", "layer", "enabled", "source", "fact_ids")


class MemoryPatch(BaseModel):
    """`Partial<VisibleMemory>`。没传的键不动。"""

    model_config = ConfigDict(extra="forbid")

    content: str | None = None
    layer: Literal["L0", "L1", "L2"] | None = None
    enabled: bool | None = None
    source: Literal["auto", "manual"] | None = None
    fact_ids: list[str] | None = None


@router.get("/memories")
async def list_memories(
    state: StateDep, layer: Literal["L0", "L1", "L2"] | None = None
) -> list[dict[str, Any]]:
    items = await state.off_loop(state.facade.list_visible, layer)
    return [item.to_dict() for item in items]


@router.patch("/memories/{memory_id}")
async def patch_memory(memory_id: str, body: MemoryPatch, state: StateDep) -> dict[str, Any]:
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise BadRequest(
            "PATCH 的 body 里一个可改字段都没有。",
            hint="能改的是：" + "、".join(EDITABLE) + "。",
            code="memory.empty_patch",
        )
    updated = await state.off_loop(state.facade.edit_visible, memory_id, **fields)
    log.info("memory.patched", id=memory_id, fields=sorted(fields))
    return updated.to_dict()


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str, state: StateDep) -> dict[str, Any]:
    updated = await state.off_loop(state.facade.edit_visible, memory_id, deleted=True)
    log.info("memory.deleted", id=memory_id, facts=len(updated.fact_ids))
    return updated.to_dict()
