"""`GET /providers` 与 `POST /current-model`。

`GET /providers` 直接透传 `qiuqiu_models.registry.list_providers()`（CONTRACTS § 1）。
**密钥不回传前端**：那份结构里只有 `has_key: bool`，本模块一个字段都不加也不改。

`POST /current-model` 契约只给了路由名，没给 body 与响应体。本轮按「换同一供应商下的
模型名」实现：落 SQLite `settings`，同时改进程环境变量再 `registry.reset()`，
下一次 `registry.get()` 就用新模型。换**供应商**要改 `.env` 重启，registry 的选路
本来就只看环境变量（AD-8），后端不该在运行期绕过它。
"""

from __future__ import annotations

import os
from typing import Any, Literal

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import StateDep
from ..errors import BadRequest

router = APIRouter(tags=["providers"])
log = structlog.get_logger("qiuqiu_api.providers")

#: 能在运行期换模型名的能力 → 对应的环境变量。别的能力这一轮没有可换的东西
MODEL_ENV: dict[str, str] = {
    "chat": "DEEPSEEK_CHAT_MODEL",
    "vision": "DEEPSEEK_VISION_MODEL",
}

SETTING_PREFIX = "model."
"""落库的键：`model.chat` / `model.vision`。`settings` 是后端归属表（AD-7）。"""


class CurrentModelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability: Literal["chat", "vision"] = "chat"
    model: str = Field(min_length=1)


@router.get("/providers")
async def list_providers() -> list[dict[str, Any]]:
    from qiuqiu_models import registry

    return registry.list_providers()


@router.post("/current-model")
async def set_current_model(body: CurrentModelIn, state: StateDep) -> dict[str, Any]:
    from qiuqiu_models import registry

    env = MODEL_ENV.get(body.capability)
    if env is None:  # pragma: no cover - Literal 已经把取值挡在外面了
        raise BadRequest(
            f"{body.capability} 这一项不能在运行期换模型。",
            hint="能换的是：" + "、".join(MODEL_ENV) + "。",
            code="model.not_switchable",
        )
    os.environ[env] = body.model
    state.sqlite.set_setting(f"{SETTING_PREFIX}{body.capability}", body.model)
    registry.reset()
    log.info("model.switched", capability=body.capability, model=body.model)

    current = next(
        (p for p in registry.list_providers() if p["capability"] == body.capability), None
    )
    return {"capability": body.capability, "model": body.model, "provider": current}
