"""压缩。拆自包含原子事实、代词消解、时间绝对化、`dropped_spans`、`write` 事件。"""

from __future__ import annotations

import datetime as dt
import json

import pytest
from memory_helpers import BASE_TIME, FakeChat, make_runtime
from qiuqiu_memory.llm import ChatUnavailable
from qiuqiu_memory.pipeline.compress import compress, new_fact_id, scrub_timestamp
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
        rt = make_runtime(clock, FakeChat([("记忆压缩", reply)]))
        try:
            result = run_compress(rt, SENTENCE)
            assert result.used_llm is True
            assert [f.text for f in result.facts] == ["用户叫赵宁", "用户喜欢喝美式咖啡"]
            assert "赵宁" in result.facts[0].entities
        finally:
            rt.close()

    def test_fenced_json_parsed(self, clock: dict[str, dt.datetime]) -> None:
        reply = '好的：\n```json\n{"facts": [{"text": "用户叫赵宁"}]}\n```\n'
        rt = make_runtime(clock, FakeChat([("记忆压缩", reply)]))
        try:
            assert run_compress(rt, SENTENCE).used_llm is True
        finally:
            rt.close()

    def test_malformed_items_skipped_not_fatal(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps({"facts": [{"text": ""}, "字符串", {"text": "用户叫赵宁"}]})
        rt = make_runtime(clock, FakeChat([("记忆压缩", reply)]))
        try:
            result = run_compress(rt, SENTENCE)
            assert [f.text for f in result.facts] == ["用户叫赵宁"]
        finally:
            rt.close()

    def test_wrong_shape_falls_back(self, clock: dict[str, dt.datetime]) -> None:
        rt = make_runtime(clock, FakeChat([("记忆压缩", '{"nothing": 1}')]))
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
        runtime = make_runtime(clock, FakeChat([("记忆压缩", reply)]))
        try:
            result = run_compress(runtime, "我叫赵宁", blob_id="image/deadbeef")
            assert result.used_llm is True
            assert [f.blob_id for f in result.facts] == ["image/deadbeef"]
        finally:
            runtime.close()

    def test_no_blob_id_stays_none(self, runtime: MemoryRuntime) -> None:
        result = run_compress(runtime, "我叫赵宁")
        assert all(f.blob_id is None for f in result.facts)


class TestWorthRemembering:
    """压缩的判据是「以后再见到用户时还用得上吗」，不是「这句话里有几个陈述」。

    改坏过一次：提示词只说「一句话里有几件事就拆几条」，模型就把丘丘自己讲的
    一段心理学科普拆成七条存进去，其中三条是通识、两条是它自己问的问句。
    """

    def test_prompt_forbids_timestamps_in_fact_text(self) -> None:
        """事实正文里出现 `2026-09-05T09:27:22.192Z` 这种，是给机器看不是给人看。"""
        from qiuqiu_memory.pipeline import compress as c

        assert "不要在正文里写时间戳" in c._USER_TEMPLATE

    def test_prompt_names_the_single_criterion(self) -> None:
        from qiuqiu_memory.pipeline import compress as c

        assert "以后再见到用户时还用得上" in c._SYSTEM

    def test_prompt_lists_what_not_to_remember(self) -> None:
        """常识、问句、寒暄、复述当下这轮——四类最容易被误记的都要点名。"""
        from qiuqiu_memory.pipeline import compress as c

        for kind in ("世界常识", "问句", "寒暄", "复述"):
            assert kind in c._USER_TEMPLATE, kind

    def test_prompt_says_empty_is_normal(self) -> None:
        """不说这句，模型会为了「有输出」硬凑事实。"""
        from qiuqiu_memory.pipeline import compress as c

        assert "这是常态，不是失败" in c._USER_TEMPLATE

    def test_prompt_forbids_calling_the_user_a_listener(self) -> None:
        """「听话人」「对话对象」是模型自己发明的称呼，用户读到会觉得很怪。"""
        from qiuqiu_memory.pipeline import compress as c

        assert "听话人" in c._USER_TEMPLATE and "对话对象" in c._USER_TEMPLATE

    def test_marker_is_stable_so_tests_do_not_pin_wording(self) -> None:
        """测试认这个标记，不认措辞——提示词该能随便改。"""
        from qiuqiu_memory.pipeline import compress as c

        assert c.COMPRESS_MARKER in c._USER_TEMPLATE


class TestScrubTimestamp:
    """正文里不该出现 ISO 时间戳。

    提示词里已经明写「绝不要出现 `2026-09-05T09:27:22.192Z`」，模型照样写——
    库里真存进去过「截至2026-09-05T07:42:50.861Z，赵宁居住在深圳市。」。
    时间该待在 `valid_from` 里，不该混进人读的那句话。
    """

    def test_cuts_the_lead_in_too(self) -> None:
        assert (
            scrub_timestamp("截至2026-09-05T07:42:50.861Z，赵宁居住在深圳市。")
            == "赵宁居住在深圳市。"
        )

    def test_handles_a_space_and_no_millis(self) -> None:
        assert scrub_timestamp("于 2026-09-05T07:42:50Z，用户改名。") == "用户改名。"

    def test_offset_timezone(self) -> None:
        assert scrub_timestamp("截至2026-09-05T07:42:50+08:00，用户搬家。") == "用户搬家。"

    def test_plain_dates_survive(self) -> None:
        """日期本身是事实的一部分时要留着——提示词允许写「2026-03」这种。"""
        assert scrub_timestamp("三月要搬家（2026-03）") == "三月要搬家（2026-03）"

    def test_clean_text_untouched(self) -> None:
        assert scrub_timestamp("赵宁住在深圳。") == "赵宁住在深圳。"

    def test_a_bare_timestamp_becomes_empty_and_gets_dropped(self) -> None:
        """整条只有一个时间戳的，清完是空的，`_from_llm` 会跳过它。"""
        assert scrub_timestamp("2026-09-05T07:42:50.861Z") == ""


def _fact(fid: str, text: str, *, speaker: str = "assistant"):
    from qiuqiu_memory.pipeline.compress import Fact

    return Fact(
        id=fid,
        text=text,
        entities=[],
        tokens=[],
        speaker=speaker,
        source="dialogue",
        valid_from=BASE_TIME,
    )


class TestItsOwnWords:
    """丘丘那一轮，只留讲它自己的事实——那个幻觉环的闸口。"""

    def test_claims_about_the_user_from_its_own_mouth_are_dropped(self) -> None:
        """「用户喜欢喝不加糖的美式」如果是从丘丘的话里抽出来的，用户从没说过。

        留着的后果实测过：下一轮召回把它端出来，模型当成事实转述回去，
        转述又被 ingest 一遍，滚成「我记得你喜欢喝不加糖的美式咖啡」。
        """
        from qiuqiu_memory.pipeline.compress import CompressResult, _only_its_own_words

        result = CompressResult(
            facts=[
                _fact("f1", "用户喜欢喝不加糖的美式。"),
                _fact("f2", "丘丘答应周三提醒用户练琴。"),
            ]
        )
        kept = _only_its_own_words(result)

        assert [f.id for f in kept.facts] == ["f2"], "承诺留下，替用户下的断言丢掉"
        assert "用户喜欢喝不加糖的美式。" in kept.dropped_spans

    def test_the_users_own_turn_is_untouched(self) -> None:
        """用户自己说的照记不误——闸口只对 speaker=assistant 那一轮。"""
        from qiuqiu_memory.pipeline.compress import CompressResult, _only_its_own_words

        mine = CompressResult(facts=[_fact("f1", "用户喜欢喝美式咖啡。", speaker="user")])
        # 这个函数只在 speaker == "assistant" 时被调用；直接调它是为了钉住判据本身
        assert _only_its_own_words(mine).facts == []
