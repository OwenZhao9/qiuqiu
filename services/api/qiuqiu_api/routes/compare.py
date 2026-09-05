"""`POST /compare`：同一 query 跑两条配置，回 token 与延迟对照。

契约只写了路由名（「边做边定，定完回报」），本轮把参数定成这样：

    { "query": "...", "session_id": null,
      "configs": [ {"name": "有记忆", "memory": true}, {"name": "无记忆", "memory": false} ] }

一条配置就是「这一轮要不要带记忆与人格」——`cost-compare` 演示场景要对照的正是
「记忆省不省 token」，所以旋钮先只留这一个，加旋钮不破坏已有字段。

**对照不写记忆**：同一句跑两遍，两遍都 `ingest` 等于把它记两次；`/compare` 因此
不落 `messages`、不调 `ingest()`，只留 `run_metrics`。
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import StateDep
from ..orchestrator import run_once
from ..state import new_trace_id

router = APIRouter(tags=["compare"])
log = structlog.get_logger("qiuqiu_api.compare")


class CompareConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    memory: bool = True


DEFAULT_CONFIGS = [
    CompareConfig(name="with-memory", memory=True),
    CompareConfig(name="no-memory", memory=False),
]


class CompareIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1)
    session_id: str | None = None
    configs: list[CompareConfig] = Field(default_factory=lambda: list(DEFAULT_CONFIGS))


@router.post("/compare")
async def compare(body: CompareIn, state: StateDep) -> dict[str, Any]:
    results = []
    for config in body.configs:
        result = await run_once(
            state,
            name=config.name,
            query=body.query,
            session_id=body.session_id,
            use_memory=config.memory,
            trace_id=new_trace_id(),
        )
        results.append(result.to_dict())
    log.info("compare.done", query=body.query, configs=[c.name for c in body.configs])
    return {
        "query": body.query,
        "results": results,
        "delta": _delta(results),
    }


def _delta(results: list[dict[str, Any]]) -> dict[str, Any] | None:
    """前两条的差值，省得前端自己减。不足两条就没有对照。"""
    if len(results) < 2:
        return None
    first, second = results[0], results[1]
    return {
        "tokens_in": first["tokens_in"] - second["tokens_in"],
        "tokens_out": first["tokens_out"] - second["tokens_out"],
        "latency_ms": first["latency_ms"] - second["latency_ms"],
        "against": [first["name"], second["name"]],
    }
