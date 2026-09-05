"""`GET /events`：多客户端广播与 `since` 断线续传。

任务书的验收项：两个客户端同时连，事件不重不漏；一个断线重连后 `since` 补发无遗漏。
读流用 `SSEProbe`（见 conftest 里为什么不能用 TestClient）。
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any

from api_helpers import SSEProbe
from qiuqiu_api.events import envelope_from_row, parse_cursor
from qiuqiu_api.state import AppState


async def ingest(state: AppState, text: str, speaker: str = "user") -> Any:
    from qiuqiu_memory import Source

    return await asyncio.to_thread(
        state.facade.ingest,
        text,
        source=Source.DIALOGUE,
        speaker=speaker,
        ts=dt.datetime.now(dt.UTC),
        trace_id="trc_events_test",
    )


async def test_envelope_matches_contract(app: Any, state: AppState) -> None:
    await ingest(state, "我叫赵宁")
    total = state.sqlite.latest_event_id()
    async with SSEProbe(app, "/events") as probe:
        assert probe.status == 200
        assert probe.headers["content-type"].startswith("text/event-stream")
        events = await probe.read(total)
    first = events[0]
    assert list(first) == ["id", "ts", "trace_id", "type", "payload"]
    assert first["id"].startswith("evt_")
    assert first["ts"].endswith("Z")
    assert first["trace_id"] == "trc_events_test"
    assert first["type"] in {"filter", "write", "merge", "recall"}


async def test_two_clients_get_the_same_events(app: Any, state: AppState) -> None:
    """不重不漏：两条连接读到的 id 序列完全一致，且等于 event_log 的全部。"""
    await ingest(state, "我住在深圳")
    await ingest(state, "我爱吃辣", speaker="assistant")
    total = state.sqlite.latest_event_id()
    assert total >= 2

    async with SSEProbe(app, "/events") as first, SSEProbe(app, "/events") as second:
        got_first = await first.read(total)
        got_second = await second.read(total)

    ids = [event["id"] for event in got_first]
    assert ids == [event["id"] for event in got_second]
    assert ids == [f"evt_{n}" for n in range(1, total + 1)]
    assert len(ids) == len(set(ids))


async def test_live_events_reach_both_open_streams(app: Any, state: AppState) -> None:
    """两个客户端同时开着，新事件两边都收到，都不重复。"""
    await ingest(state, "第一句")
    backlog = state.sqlite.latest_event_id()

    async with SSEProbe(app, "/events") as first, SSEProbe(app, "/events") as second:
        await first.read(backlog)
        await second.read(backlog)

        await ingest(state, "第二句")
        fresh = state.sqlite.latest_event_id() - backlog
        assert fresh >= 1

        live_first = await first.read(fresh)
        live_second = await second.read(fresh)

    expected = [f"evt_{n}" for n in range(backlog + 1, backlog + 1 + fresh)]
    assert [e["id"] for e in live_first] == expected
    assert [e["id"] for e in live_second] == expected


async def test_since_resume_loses_nothing(app: Any, state: AppState) -> None:
    """断线的那个客户端拿着 `since` 回来，补发的部分与在线那条一模一样。"""
    await ingest(state, "断线前这句")
    cursor = state.sqlite.latest_event_id()

    dropped = await SSEProbe(app, "/events").__aenter__()
    await dropped.read(cursor)
    await dropped.close()  # 客户端断线

    async with SSEProbe(app, "/events") as stayed:
        await stayed.read(cursor)
        await ingest(state, "断线期间这句")
        fresh = state.sqlite.latest_event_id() - cursor
        live = await stayed.read(fresh)

        async with SSEProbe(app, f"/events?since={cursor}") as reconnected:
            resumed = await reconnected.read(fresh)

    assert [e["id"] for e in live] == [e["id"] for e in resumed]
    assert [e["payload"] for e in live] == [e["payload"] for e in resumed]


async def test_since_accepts_evt_prefix_and_last_event_id(app: Any, state: AppState) -> None:
    await ingest(state, "一句话")
    cursor = state.sqlite.latest_event_id()
    await ingest(state, "第二句话")
    fresh = state.sqlite.latest_event_id() - cursor

    async with SSEProbe(app, f"/events?since=evt_{cursor}") as probe:
        by_query = await probe.read(fresh)
    async with SSEProbe(app, "/events", {"last-event-id": str(cursor)}) as probe:
        by_header = await probe.read(fresh)

    assert [e["id"] for e in by_query] == [e["id"] for e in by_header]


async def test_sse_carries_numeric_id_line(app: Any, state: AppState) -> None:
    """`id:` 行写的是自增 id，正好等于下次该传的 `since`。"""
    await ingest(state, "带 id 行")
    total = state.sqlite.latest_event_id()
    async with SSEProbe(app, "/events") as probe:
        lines = await probe.read_lines("id: ", total)
    assert lines == [str(n) for n in range(1, total + 1)]


async def test_heartbeat_keeps_idle_stream_open(app: Any, state: AppState) -> None:
    """空闲时发注释帧保活，配置里心跳 200ms，这里等一条就够。"""
    async with SSEProbe(app, "/events") as probe:
        await probe.read_lines(": ", 1, timeout=3.0)


def test_parse_cursor_forms() -> None:
    assert parse_cursor(None) == 0
    assert parse_cursor("") == 0
    assert parse_cursor("7") == 7
    assert parse_cursor("evt_7") == 7
    assert parse_cursor("不是数字") == 0
    assert parse_cursor(-3) == 0


def test_envelope_from_row_normalises_timestamp() -> None:
    envelope = envelope_from_row(
        {
            "id": 3,
            "ts": "2026-09-04T22:31:00+00:00",
            "trace_id": "trc_x",
            "type": "write",
            "payload_json": {"raw": "x"},
        }
    )
    assert envelope["id"] == "evt_3"
    assert envelope["ts"] == "2026-09-04T22:31:00.000Z"
    assert envelope["payload"] == {"raw": "x"}
