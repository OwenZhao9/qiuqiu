"""`POST /chat`：SSE 对话。事件 `meta / delta / audio / done / error` 按 CONTRACTS § 1。

路由只做三件事：收参数、生成 `trace_id`、把编排产出的二元组编成 SSE 帧。
拼 prompt、调模型、写记忆全在 `orchestrator.py`——编排是唯一调 `ChatModel.stream()`
的地方，路由里不许出现模型细节。
"""

from __future__ import annotations

from typing import Literal

import structlog
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..deps import StateDep
from ..orchestrator import Attachment, ChatRequest, stream_chat
from ..sse import SSE_HEADERS, frame
from ..state import new_trace_id

router = APIRouter(tags=["chat"])
log = structlog.get_logger("qiuqiu_api.chat")


class AttachmentIn(BaseModel):
    type: Literal["image", "audio"]
    blob_id: str


class ChatIn(BaseModel):
    session_id: str = Field(min_length=1)
    content: str = ""
    attachments: list[AttachmentIn] = Field(default_factory=list)


@router.post("/chat")
async def chat(body: ChatIn, state: StateDep) -> StreamingResponse:
    trace_id = new_trace_id()
    request = ChatRequest(
        session_id=body.session_id,
        content=body.content,
        attachments=[Attachment(type=a.type, blob_id=a.blob_id) for a in body.attachments],
    )
    log.info(
        "chat.start",
        trace_id=trace_id,
        session_id=body.session_id,
        attachments=len(request.attachments),
    )

    async def sse():
        async for name, data in stream_chat(state, request, trace_id=trace_id):
            yield frame(data, event=name)

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={**SSE_HEADERS, "X-Trace-Id": trace_id},
    )
