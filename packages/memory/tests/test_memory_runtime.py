"""运行时与 Chat 入口。同步门面怎么调异步模型、模型只从 registry 拿（AD-8）。"""

from __future__ import annotations

import asyncio
import datetime as dt

import pytest
from memory_helpers import BASE_TIME, FakeChat, make_runtime
from qiuqiu_memory.errors import ContractError, MemoryError_
from qiuqiu_memory.llm import ChatUnavailable, complete_json, extract_json
from qiuqiu_memory.runtime import MemoryRuntime


class TestChatSource:
    def test_chat_comes_from_the_registry(self, runtime: MemoryRuntime) -> None:
        """`MODELS_MOCK=1` 下拿到的该是 mock，而且是注册表给的，不是本层 import 的。"""
        assert runtime.chat_provider == "mock"
        from qiuqiu_models import registry

        assert runtime.chat is registry.get("chat")

    def test_injected_chat_wins(self, clock: dict[str, dt.datetime]) -> None:
        chat = FakeChat()
        rt = make_runtime(clock, chat)
        try:
            assert rt.chat is chat
            assert rt.chat_provider == "fake"
        finally:
            rt.close()

    def test_provider_unknown_when_object_has_no_attribute(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        rt = make_runtime(clock, object())
        try:
            assert rt.chat_provider == "unknown"
        finally:
            rt.close()


class TestClock:
    def test_now_uses_injected_clock(self, runtime: MemoryRuntime, clock) -> None:
        clock["now"] = dt.datetime(2033, 3, 3, tzinfo=dt.UTC)
        assert runtime.now() == clock["now"]

    def test_default_clock_is_utc_aware(self) -> None:
        rt = MemoryRuntime()
        try:
            assert rt.now().tzinfo is not None
        finally:
            rt.close()


class TestLoopBridge:
    def test_run_returns_the_coroutine_result(self, runtime: MemoryRuntime) -> None:
        async def answer() -> int:
            await asyncio.sleep(0)
            return 42

        assert runtime.run(answer()) == 42

    def test_run_propagates_exceptions(self, runtime: MemoryRuntime) -> None:
        async def boom() -> None:
            raise ValueError("炸了")

        with pytest.raises(ValueError, match="炸了"):
            runtime.run(boom())

    async def test_run_works_from_inside_another_loop(self, runtime: MemoryRuntime) -> None:
        """后端在 FastAPI 里应当 `to_thread`，但真直接调也不该死锁。"""

        async def answer() -> str:
            return "好"

        assert await asyncio.to_thread(runtime.run, answer()) == "好"

    def test_close_then_run_starts_a_fresh_loop(self, runtime: MemoryRuntime) -> None:
        async def answer() -> int:
            return 1

        runtime.close()
        assert runtime.run(answer()) == 1


class TestSettings:
    def test_setting_int_reads_sqlite(self, runtime: MemoryRuntime) -> None:
        runtime.sqlite.set_setting("consolidate_rounds", "7")
        assert runtime.setting_int("consolidate_rounds") == 7

    def test_setting_int_default(self, runtime: MemoryRuntime) -> None:
        assert runtime.setting_int("consolidate_rounds") == 50


class TestExtractJson:
    def test_bare_object(self) -> None:
        assert extract_json('{"a": 1}') == {"a": 1}

    def test_bare_array(self) -> None:
        assert extract_json('["a"]') == ["a"]

    def test_fenced(self) -> None:
        assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}

    def test_fenced_without_language(self) -> None:
        assert extract_json('```\n{"a": 1}\n```') == {"a": 1}

    def test_surrounded_by_chatter(self) -> None:
        assert extract_json('好的，结果是 {"a": 1}，请查收。') == {"a": 1}

    def test_plain_prose_returns_none(self) -> None:
        assert extract_json("我是丘丘的 mock 回复。") is None

    def test_empty_returns_none(self) -> None:
        assert extract_json("") is None

    def test_broken_json_returns_none(self) -> None:
        assert extract_json('{"a": ') is None


class TestCompleteJson:
    async def test_non_json_reply_is_a_downgrade_not_an_error(self, runtime: MemoryRuntime) -> None:
        parsed = await complete_json(runtime, system="s", user="u", stage="test")
        assert parsed is None

    async def test_failure_becomes_chat_unavailable_with_hint(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        class Broken:
            provider = "broken"

            async def complete(self, messages: list[object]) -> str:
                raise RuntimeError("鉴权失败")

        rt = make_runtime(clock, Broken())
        try:
            with pytest.raises(ChatUnavailable) as caught:
                await complete_json(rt, system="s", user="u", stage="test")
        finally:
            rt.close()
        body = caught.value.to_dict()
        assert body["code"] == "chat_unavailable"
        assert body["hint"] and body["stage"] == "test"

    async def test_failure_still_records_a_metric(self, clock: dict[str, dt.datetime]) -> None:
        """AD-16：失败也记 `run_metrics`。"""
        from qiuqiu_models import metrics

        sink = metrics.InMemoryMetricsSink()
        previous = metrics.get_sink()
        metrics.set_sink(sink)

        class Broken:
            provider = "broken"

            async def complete(self, messages: list[object]) -> str:
                raise RuntimeError("超时")

        rt = make_runtime(clock, Broken())
        try:
            with pytest.raises(ChatUnavailable):
                await complete_json(rt, system="s", user="u", stage="compress")
        finally:
            rt.close()
            metrics.set_sink(previous)
        assert [m.stage for m in sink.records] == ["memory.compress"]


class TestErrors:
    def test_base_error_body_is_the_contract_shape(self) -> None:
        body = MemoryError_("坏了", hint="试试这个").to_dict()
        assert set(body) == {"code", "message", "hint"}
        assert body["code"] == "memory_error"

    def test_extra_fields_merged(self) -> None:
        body = ContractError("坏了", hint="改一下", field="layer").to_dict()
        assert body["field"] == "layer"

    def test_every_error_carries_a_hint(self) -> None:
        with pytest.raises(TypeError):
            MemoryError_("没给 hint")  # type: ignore[call-arg]


def test_runtime_accepts_prebuilt_stores() -> None:
    """backend 的初始化顺序：先 `qiuqiu_data.init()`，再把 stores 传进来。"""
    import qiuqiu_data

    stores = qiuqiu_data.init()
    rt = MemoryRuntime(stores=stores, clock=lambda: BASE_TIME)
    try:
        assert rt.lance is stores.lance
        assert rt.sqlite is stores.sqlite
        assert rt.blobs is stores.blobs
    finally:
        rt.close()
