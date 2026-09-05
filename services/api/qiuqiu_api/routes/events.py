"""`GET /events`：记忆事件流。`since` 游标续传，多客户端各订各的。

后端**只读不写** `event_log`（AD-14）：中间件写，这里补发加广播。
游标是 `event_log` 的自增 id，SSE 的 `id:` 行写的就是它，所以浏览器 `EventSource`
断线重连自带的 `Last-Event-ID` 头可以直接当 `since` 用（没带 `?since=` 时就读这个头）。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..deps import StateDep
from ..events import parse_cursor, stream_memory_events
from ..sse import SSE_HEADERS, comment, frame

router = APIRouter(tags=["events"])


@router.get("/events")
async def events(request: Request, state: StateDep, since: str | None = None) -> StreamingResponse:
    cursor = parse_cursor(since if since is not None else request.headers.get("last-event-id"))

    async def sse():
        async for event_id, envelope in stream_memory_events(state, cursor):
            if envelope is None:
                yield comment()
                continue
            yield frame(envelope, id=event_id)

    return StreamingResponse(sse(), media_type="text/event-stream", headers=SSE_HEADERS)
