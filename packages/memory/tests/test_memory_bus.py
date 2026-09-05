"""事件总线。信封与顺序按 CONTRACTS § 1：先落 `event_log` 拿自增 id，再广播。"""

from __future__ import annotations

import asyncio

import pytest
from qiuqiu_memory.bus import EVENT_TYPES, EventBus
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import MemoryEvent


class TestEnvelope:
    def test_id_is_evt_plus_event_log_rowid(self, runtime: MemoryRuntime) -> None:
        first = runtime.bus.emit("write", {"raw": "一"}, trace_id="trc_a")
        second = runtime.bus.emit("write", {"raw": "二"}, trace_id="trc_b")
        assert first.id == "evt_1"
        assert second.id == "evt_2"

    def test_persisted_before_broadcast(self, runtime: MemoryRuntime) -> None:
        """落库必须早于广播，否则 `/events?since=` 会漏事件。"""
        event = runtime.bus.emit("filter", {"decision": "reject"}, trace_id="trc_a")
        cursor = int(event.id.removeprefix("evt_"))
        rows = runtime.sqlite.events_since(cursor - 1)
        assert [r["id"] for r in rows] == [cursor]
        assert rows[0]["payload_json"] == {"decision": "reject"}

    def test_to_dict_key_order_matches_contract(self, runtime: MemoryRuntime) -> None:
        body = runtime.bus.emit("merge", {"result_id": "fact_1"}, trace_id="trc_a").to_dict()
        assert list(body) == ["id", "ts", "trace_id", "type", "payload"]

    def test_ts_is_iso_utc_with_z(self, runtime: MemoryRuntime) -> None:
        body = runtime.bus.emit("recall", {"query": "x"}, trace_id="trc_a").to_dict()
        assert body["ts"].endswith("Z")
        assert body["ts"][10] == "T"

    def test_only_four_types_allowed(self, runtime: MemoryRuntime) -> None:
        assert EVENT_TYPES == ("filter", "write", "merge", "recall")
        with pytest.raises(ValueError, match="事件类型"):
            runtime.bus.emit("explode", {}, trace_id="trc_a")

    def test_since_cursor_replays_in_order(self, runtime: MemoryRuntime) -> None:
        for i in range(5):
            runtime.bus.emit("write", {"raw": str(i)}, trace_id="trc_a")
        rows = runtime.sqlite.events_since(2)
        assert [r["payload_json"]["raw"] for r in rows] == ["2", "3", "4"]


class TestSubscription:
    async def test_stream_delivers_to_subscriber(self, runtime: MemoryRuntime) -> None:
        stream = runtime.bus.stream()
        task = asyncio.create_task(anext(stream))  # type: ignore[arg-type]
        await asyncio.sleep(0)  # 让订阅先注册上
        runtime.bus.emit("write", {"raw": "你好"}, trace_id="trc_a")
        event = await asyncio.wait_for(task, timeout=2)
        assert event.type == "write" and event.payload["raw"] == "你好"
        await stream.aclose()

    async def test_events_before_subscribe_are_not_replayed(self, runtime: MemoryRuntime) -> None:
        """总线只管在线广播，补历史是 `/events?since=` 的活。"""
        runtime.bus.emit("write", {"raw": "旧的"}, trace_id="trc_a")
        stream = runtime.bus.stream()
        task = asyncio.create_task(anext(stream))  # type: ignore[arg-type]
        await asyncio.sleep(0)
        runtime.bus.emit("write", {"raw": "新的"}, trace_id="trc_b")
        event = await asyncio.wait_for(task, timeout=2)
        assert event.payload["raw"] == "新的"
        await stream.aclose()

    async def test_close_unregisters(self, runtime: MemoryRuntime) -> None:
        sub = runtime.bus.open()
        assert runtime.bus.subscriber_count == 1
        runtime.bus.close(sub)
        assert runtime.bus.subscriber_count == 0

    async def test_full_queue_drops_oldest_instead_of_blocking(
        self, runtime: MemoryRuntime
    ) -> None:
        """侧栏少一条事件是小事，写记忆卡住是大事。"""
        bus = EventBus(runtime.sqlite, queue_size=2)
        sub = bus.open()
        for i in range(5):
            bus.emit("write", {"raw": str(i)}, trace_id="trc_a")
        assert sub.dropped == 3
        drained = [(await sub.get()).payload["raw"] for _ in range(2)]
        assert drained == ["3", "4"]
        bus.close(sub)

    async def test_publish_from_another_loop_reaches_subscriber(
        self, runtime: MemoryRuntime
    ) -> None:
        """管线跑在 `runtime` 的后台循环里，订阅者在别的循环里，跨循环也要送到。"""
        stream = runtime.bus.stream()
        task = asyncio.create_task(anext(stream))  # type: ignore[arg-type]
        await asyncio.sleep(0)

        async def publish_over_there() -> None:
            runtime.bus.emit("recall", {"query": "跨循环"}, trace_id="trc_a")

        runtime.run(publish_over_there())
        event = await asyncio.wait_for(task, timeout=2)
        assert event.payload["query"] == "跨循环"
        await stream.aclose()


class TestHistory:
    def test_history_is_bounded(self, runtime: MemoryRuntime) -> None:
        bus = EventBus(runtime.sqlite, history=3)
        for i in range(6):
            bus.emit("write", {"raw": str(i)}, trace_id="trc_a")
        assert [e.payload["raw"] for e in bus.history] == ["3", "4", "5"]

    def test_publish_returns_the_same_object_with_id_filled(self, runtime: MemoryRuntime) -> None:
        event = MemoryEvent(type="write", payload={}, trace_id="trc_a")
        returned = runtime.bus.publish(event)
        assert returned is event and event.id.startswith("evt_")
