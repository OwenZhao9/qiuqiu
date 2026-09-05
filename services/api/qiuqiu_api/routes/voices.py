"""音色：列出可选项、读写当前选择。契约 v0.1.10 § 1。

只列女声（丘丘的设定）。前端拿到的是**稳定短名**（`vivi`、`xiaohe`），不是供应商
音色 ID——同一个音色在级联与端到端两条链路上 ID 不一样，映射收在
`qiuqiu_models.voices` 里，路由与前端都不碰供应商 ID。

选中值落 SQLite `settings` 的 `voice` 键，归后端写（§ 7 数据归属表）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..deps import StateDep
from ..errors import ApiError

router = APIRouter(tags=["voices"])

#: `settings` 表里的键名。
SETTING_KEY = "voice"


class VoiceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    voice: str = Field(min_length=1, max_length=64)


@router.get("/voices")
async def list_voices() -> list[dict[str, Any]]:
    from qiuqiu_models import voices

    return voices.list_voices()


@router.get("/config/voice")
async def get_voice(state: StateDep) -> dict[str, str]:
    from qiuqiu_models import voices

    stored = await state.off_loop(state.sqlite.get_setting, SETTING_KEY)
    # 走一遍 get()：存过的音色可能已被下架，这时回退默认而不是原样回传一个用不了的值
    return {"voice": voices.get(stored).id}


@router.put("/config/voice")
async def set_voice(body: VoiceIn, state: StateDep) -> dict[str, str]:
    from qiuqiu_models import voices

    chosen = voices.get(body.voice)
    if chosen.id != body.voice:
        raise ApiError(
            f"没有这个音色：{body.voice!r}。",
            hint="先 GET /voices 看可选项，用返回的 id。",
            code="voice.unknown",
            status=400,
        )
    await state.off_loop(state.sqlite.set_setting, SETTING_KEY, chosen.id)
    return {"voice": chosen.id}


async def current_voice(state: Any) -> str:
    """当前音色的短名。编排与语音路由都从这里取，别各读各的 `settings`。"""
    from qiuqiu_models import voices

    stored = await state.off_loop(state.sqlite.get_setting, SETTING_KEY)
    return voices.get(stored).id
