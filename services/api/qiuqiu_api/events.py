"""事件总线出口：把中间件发的记忆事件广播到所有 `/events` 连接。

**后端只读不写**（AD-14 与 CONTRACTS § 1）：`event_log` 由中间件的事件总线写，写完拿
自增 id 回填信封再广播。后端做两件事——按 `since` 游标从 `event_log` 补发历史，以及
订阅 `MemoryFacade.subscribe()` 转发新事件。

不重不漏靠这个顺序，顺序错了就会漏：

1. **先订阅**：`subscribe()` 的注册发生在第一次 `__anext__`，所以先把泵任务跑起来，
   让它卡在等队列上，此刻起新事件都进队列
2. **再补发**：注册完成之后才查 `events_since(since)`。这时候查到的一定是「订阅前
   就已经落库的」，订阅之后落库的那些即使这次也查到了，也只是重复
3. **去重**：补发时记下最大 id，实时那一路把 id 不大于它的丢掉

反过来「先查库再订阅」的话，两步之间落库的事件谁也不管，就漏了。

一个连接一个订阅，互不影响；总线的队列满了丢最旧的，绝不反压记忆管线。
"""

from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import structlog

from .state import AppState

__all__ = ["envelope_from_row", "parse_cursor", "stream_memory_events"]

log = structlog.get_logger("qiuqiu_api.events")

_QUEUE_SIZE = 512


def parse_cursor(raw: str | int | None) -> int:
    """`?since=` 的取值。认三种写法：`12`、`evt_12`、空。都不认就当 0（从头补）。"""
    if raw is None:
        return 0
    text = str(raw).strip()
    if not text:
        return 0
    text = text.removeprefix("evt_")
    try:
        return max(0, int(text))
    except ValueError:
        return 0


def _iso_z(value: Any) -> str:
    """`event_log.ts` 是 `+00:00` 写法，契约 § 1 的信封样例是 `Z` 加毫秒。统一成后者。"""
    text = str(value or "")
    if not text:
        return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        moment = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.UTC)
    return moment.astimezone(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def envelope_from_row(row: dict[str, Any]) -> dict[str, Any]:
    """`event_log` 的一行 → CONTRACTS § 1 的统一信封。键序照契约写。"""
    return {
        "id": f"evt_{row['id']}",
        "ts": _iso_z(row.get("ts")),
        "trace_id": row.get("trace_id"),
        "type": row.get("type"),
        "payload": row.get("payload_json") or {},
    }


def _event_id(event: Any) -> int:
    return parse_cursor(getattr(event, "id", "") or "")


async def stream_memory_events(
    state: AppState, since: int = 0
) -> AsyncIterator[tuple[int | None, dict[str, Any] | None]]:
    """产出 `(游标, 信封)`；心跳时产出 `(None, None)`。

    调用方（`routes/events.py`）负责编成 SSE 帧。游标是 `event_log` 的自增 id，
    也就是 `?since=` 下一次该传的值。
    """
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_QUEUE_SIZE)

    async def pump() -> None:
        try:
            async for event in state.facade.subscribe():
                if queue.full():  # 丢最旧的，别让 SSE 慢读者拖住记忆管线
                    queue.get_nowait()
                queue.put_nowait(event)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 泵任务是后台任务，炸了只记日志
            log.warning("events.pump_failed", exc_info=True)

    task = asyncio.create_task(pump())
    try:
        # 让泵任务跑到「已注册、正在等队列」为止。两次让步足够穿过 subscribe() 里
        # 那层异步生成器的启动开销，之后落库的事件都进得了队列。
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        cursor = since
        page = state.config.events_page
        while True:
            rows = await state.off_loop(state.sqlite.events_since, cursor, limit=page)
            if not rows:
                break
            for row in rows:
                cursor = int(row["id"])
                yield cursor, envelope_from_row(row)
            if len(rows) < page:
                break

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=state.config.events_heartbeat_s)
            except TimeoutError:
                yield None, None
                continue
            event_id = _event_id(event)
            if event_id and event_id <= cursor:
                continue  # 补发已经带过了
            cursor = event_id or cursor
            yield cursor, event.to_dict()
    finally:
        # 取消泵任务，`bus.stream()` 的 finally 会把订阅从总线上摘掉。
        # 这里不 await：外层可能正被 GeneratorExit 关闭，那种时候没法再等协程。
        task.cancel()
