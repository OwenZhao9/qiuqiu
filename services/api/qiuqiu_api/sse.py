"""SSE 编码。两条流用同一套：`/chat` 带 `event:` 名，`/events` 带 `id:` 游标。

为什么 `/events` 不带 `event:` 名：CONTRACTS § 1 只给了 `/chat` 五个事件名
（`meta` `delta` `done` `audio` `error`），记忆事件流那节给的是一个统一信封，类型在
`payload` 外层的 `type` 字段里。不写 `event:` 行的话浏览器 `EventSource.onmessage`
一把全收，前端按 `type` 分发；写了名字反而逼前端为四种类型各 `addEventListener` 一次。

`id:` 行写的是 `event_log` 的自增 id（纯数字，不是 `evt_` 前缀那个）——`EventSource`
断线重连会把它放进 `Last-Event-ID` 头，正好等于 `?since=` 的取值。
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["SSE_HEADERS", "comment", "frame"]

SSE_HEADERS: dict[str, str] = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # 挡住反代的缓冲，不然 delta 会攒成一坨再吐，首字延迟就废了
    "X-Accel-Buffering": "no",
}


def frame(data: Any, *, event: str | None = None, id: str | int | None = None) -> str:
    """拼一帧。`data` 是 dict 就序列化成 JSON（不转义中文）。"""
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    lines: list[str] = []
    if id is not None:
        lines.append(f"id: {id}")
    if event is not None:
        lines.append(f"event: {event}")
    # JSON 里不会出现裸换行，这一步是给将来直接发文本留的余地
    lines.extend(f"data: {chunk}" for chunk in text.split("\n"))
    return "\n".join(lines) + "\n\n"


def comment(text: str = "ping") -> str:
    """注释帧，客户端会忽略。用来保活空闲连接。"""
    return f": {text}\n\n"
