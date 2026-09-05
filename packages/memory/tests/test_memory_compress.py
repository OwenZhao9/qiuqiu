"""压缩。拆自包含原子事实、代词消解、时间绝对化、`dropped_spans`、`write` 事件。"""

from __future__ import annotations

import datetime as dt
import json

import pytest
from memory_helpers import BASE_TIME, FakeChat, make_runtime
from qiuqiu_memory.llm import ChatUnavailable
from qiuqiu_memory.pipeline.compress import compress, new_fact_id
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import Source

SENTENCE = "我叫赵宁，我喜欢喝美式咖啡。用一句话介绍你自己。"


def run_compress(runtime: MemoryRuntime, text: str, **kwargs: object):
    params: dict = {
        "source": Source.DIALOGUE,
        "speaker": "user",
        "ts": BASE_TIME,
        "trace_id": "trc_test",
    }
    params.update(kwargs)
    return runtime.run(compress(runtime, text, **params))


class TestFallbackPath:
    """Chat 答的不是 JSON（`MODELS_MOCK=1` 就是这种）时的确定性兜底。"""

    def test_two_facts_and_instruction_dropped(self, runtime: MemoryRuntime) -> None:
        """任务书验收条一：两条事实（名字、偏好），`dropped_spans` 含指令部分。"""
        result = run_compress(runtime, SENTENCE)
        assert result.used_llm is False
        assert [f.text for f in result.facts] == ["用户叫赵宁", "用户喜欢喝美式咖啡"]
        assert result.dropped_spans == ["用一句话介绍你自己"]

    def test_pronouns_resolved_in_stored_text(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, "我明天要去看牙医")
        assert all("我" not in f.text for f in result.facts)

    def test_relative_time_absolutized_against_ingest_ts(self, runtime: MemoryRuntime) -> None:
        """场景回放靠的就是这个 `ts`，不是系统时钟。"""
        result = run_compress(
            runtime, "我明天要去看牙医", ts=dt.datetime(2030, 1, 1, tzinfo=dt.UTC)
        )
        assert "2030-01-02" in result.facts[0].text

    def test_smalltalk_dropped(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, "你好。谢谢")
        assert result.facts == []
        assert set(result.dropped_spans) == {"你好", "谢谢"}

    def test_assistant_speaker_recorded(self, runtime: MemoryRuntime) -> None:
        """AI 自己的回复也进记忆（AD-6）。"""
        result = run_compress(runtime, "我记住了赵宁喜欢美式咖啡", speaker="assistant")
        assert result.facts[0].speaker == "assistant"
        assert result.facts[0].text.startswith("丘丘")


class TestJournal:
    def test_summary_generated(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, "今天写了很久的代码，晚上去跑步", source=Source.JOURNAL)
        assert result.summary
        assert result.facts[0].source == "journal"

    def test_summary_capped(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, "一" * 300, source=Source.JOURNAL)
        assert result.summary is not None and len(result.summary) <= 80

    def test_dialogue_has_no_summary(self, runtime: MemoryRuntime) -> None:
        assert run_compress(runtime, "我叫赵宁").summary is None


class TestStorage:
    def test_facts_written_to_hot_table_with_contract_columns(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, SENTENCE)
        rows = runtime.lance.get_many([f.id for f in result.facts], "hot")
        assert len(rows) == 2
        row = rows[0]
        assert len(row["vector"]) == 1024
        assert row["speaker"] == "user"
        assert row["source"] == "dialogue"
        assert row["valid_to"] is None and row["superseded_by"] is None
        assert row["tokens"] and row["entities"]

    def test_empty_result_touches_neither_embedder_nor_table(
        self, runtime: MemoryRuntime, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """一条事实都没有时不去碰嵌入器——否则 qwen3 那条路会被白白唤醒。"""

        def explode(*_a: object, **_k: object) -> None:
            raise AssertionError("不该调嵌入器")

        monkeypatch.setattr(runtime.embedder, "embed", explode)
        result = run_compress(runtime, "你好")
        assert result.facts == []
        assert runtime.lance.count("hot") == 0

    def test_blob_id_passed_through_on_llm_path(self, clock: dict[str, dt.datetime]) -> None:
        chat = FakeChat(
            [
                (
                    "记忆压缩器",
                    json.dumps({"facts": [{"text": "画面里有一杯咖啡", "entities": ["咖啡"]}]}),
                )
            ]
        )
        rt = make_runtime(clock, chat)
        try:
            result = run_compress(rt, "一张图", source=Source.AMBIENT_IMAGE, blob_id="image/abc")
            assert result.facts[0].source == "ambient_image"
        finally:
            rt.close()


class TestLlmPath:
    def test_model_json_used_verbatim(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps(
            {
                "facts": [
                    {"text": "用户叫赵宁", "entities": ["赵宁"]},
                    {"text": "用户喜欢喝美式咖啡", "entities": ["美式咖啡"]},
                ],
                "dropped_spans": ["用一句话介绍你自己"],
                "summary": None,
            },
            ensure_ascii=False,
        )
        rt = make_runtime(clock, FakeChat([("记忆压缩器", reply)]))
        try:
            result = run_compress(rt, SENTENCE)
            assert result.used_llm is True
            assert [f.text for f in result.facts] == ["用户叫赵宁", "用户喜欢喝美式咖啡"]
            assert "赵宁" in result.facts[0].entities
        finally:
            rt.close()

    def test_fenced_json_parsed(self, clock: dict[str, dt.datetime]) -> None:
        reply = '好的：\n```json\n{"facts": [{"text": "用户叫赵宁"}]}\n```\n'
        rt = make_runtime(clock, FakeChat([("记忆压缩器", reply)]))
        try:
            assert run_compress(rt, SENTENCE).used_llm is True
        finally:
            rt.close()

    def test_malformed_items_skipped_not_fatal(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps({"facts": [{"text": ""}, "字符串", {"text": "用户叫赵宁"}]})
        rt = make_runtime(clock, FakeChat([("记忆压缩器", reply)]))
        try:
            result = run_compress(rt, SENTENCE)
            assert [f.text for f in result.facts] == ["用户叫赵宁"]
        finally:
            rt.close()

    def test_wrong_shape_falls_back(self, clock: dict[str, dt.datetime]) -> None:
        rt = make_runtime(clock, FakeChat([("记忆压缩器", '{"nothing": 1}')]))
        try:
            assert run_compress(rt, SENTENCE).used_llm is False
        finally:
            rt.close()

    def test_chat_failure_raises_chat_unavailable_with_hint(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        """调用炸了是错误、不是降级——抛出去让门面按 ARCHITECTURE § 3 处理。"""

        class Broken:
            provider = "broken"

            async def complete(self, messages: list[object]) -> str:
                raise RuntimeError("连接超时")

        rt = make_runtime(clock, Broken())
        try:
            with pytest.raises(ChatUnavailable) as caught:
                run_compress(rt, SENTENCE)
            body = caught.value.to_dict()
            assert body["code"] == "chat_unavailable"
            assert body["hint"]
        finally:
            rt.close()


class TestWriteEvent:
    def test_payload_matches_contract(self, runtime: MemoryRuntime) -> None:
        run_compress(runtime, SENTENCE)
        event = runtime.bus.history[-1]
        assert event.type == "write"
        assert set(event.payload) == {"raw", "speaker", "facts", "dropped_spans"}
        assert event.payload["raw"] == SENTENCE
        assert event.payload["speaker"] == "user"
        assert event.payload["dropped_spans"] == ["用一句话介绍你自己"]
        for fact in event.payload["facts"]:
            assert set(fact) == {"id", "text", "entities", "valid_from"}
            assert fact["valid_from"].endswith("Z")

    def test_event_emitted_even_with_zero_facts(self, runtime: MemoryRuntime) -> None:
        """侧栏要能显示「这句什么都没记」，所以空产出也发事件。"""
        run_compress(runtime, "你好")
        event = runtime.bus.history[-1]
        assert event.type == "write" and event.payload["facts"] == []


def test_fact_ids_are_unique_and_prefixed() -> None:
    ids = {new_fact_id() for _ in range(200)}
    assert len(ids) == 200
    assert all(i.startswith("fact_") for i in ids)


class TestBlobPointer:
    """CONTRACTS § 5 的 `blob_id` 列：事实要留住指向原图 / 原文 / 音频的指针。

    被动采集的原始音频「处理完即可删除」（ARCHITECTURE § 2），冷存储里只存指针——
    指针在压缩这一步挂上去，挂丢了就再也回溯不到原件。
    """

    def test_blob_id_reaches_every_fact_on_the_fallback_path(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, SENTENCE, blob_id="audio/abc123")
        assert result.facts
        assert {f.blob_id for f in result.facts} == {"audio/abc123"}
        for fact in result.facts:
            assert runtime.lance.get(fact.id, "hot")["blob_id"] == "audio/abc123"

    def test_blob_id_reaches_every_fact_on_the_model_path(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        reply = json.dumps(
            {"facts": [{"text": "用户叫赵宁", "entities": ["赵宁"]}], "dropped_spans": []},
            ensure_ascii=False,
        )
        runtime = make_runtime(clock, FakeChat([("记忆压缩器", reply)]))
        try:
            result = run_compress(runtime, "我叫赵宁", blob_id="image/deadbeef")
            assert result.used_llm is True
            assert [f.blob_id for f in result.facts] == ["image/deadbeef"]
        finally:
            runtime.close()

    def test_no_blob_id_stays_none(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, "我叫赵宁")
        assert all(f.blob_id is None for f in result.facts)
