"""`MemoryFacade`：五个方法，签名按 CONTRACTS § 3，分流按 AD-3。"""

from __future__ import annotations

import asyncio
import datetime as dt
import json

import pytest
from memory_helpers import BASE_TIME, FakeChat, absorb_all, make_runtime
from qiuqiu_memory.errors import ContractError, UnknownVisibleMemoryError
from qiuqiu_memory.facade import LAYERS, MemoryFacade, layer_of, new_trace_id
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import Budget, Source

SENTENCE = "我叫赵宁，我喜欢喝美式咖啡。用一句话介绍你自己。"


class TestIngestRouting:
    def test_dialogue_skips_the_filter(self, facade: MemoryFacade) -> None:
        """主动输入不进筛选（AD-3）：一条 `filter` 事件都不该有。"""
        result = facade.ingest("嗯", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        assert result.decision == "accept"
        assert [e for e in facade.runtime.bus.history if e.type == "filter"] == []

    def test_journal_skips_the_filter_and_gets_a_summary(self, facade: MemoryFacade) -> None:
        result = facade.ingest(
            "今天写了很久代码", source=Source.JOURNAL, speaker="user", ts=BASE_TIME
        )
        assert result.summary
        assert [e for e in facade.runtime.bus.history if e.type == "filter"] == []

    def test_ambient_goes_through_the_filter(self, facade: MemoryFacade) -> None:
        facade.ingest("", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        events = [e for e in facade.runtime.bus.history if e.type == "filter"]
        assert len(events) == 1

    def test_rejected_ambient_writes_nothing(self, facade: MemoryFacade) -> None:
        result = facade.ingest("", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        assert result.decision == "reject"
        assert result.accepted == []
        assert len(result.rejected) == 1
        assert result.rejected[0].reason == "Silence detected"
        assert facade.runtime.lance.count("hot") == 0

    def test_accepted_ambient_is_compressed(self, facade: MemoryFacade) -> None:
        result = facade.ingest(
            "今天下午三点要去医院复查牙齿",
            source=Source.AMBIENT_AUDIO,
            speaker="user",
            ts=BASE_TIME,
        )
        assert result.decision == "accept" and result.accepted

    def test_repeat_ambient_deduped_after_acceptance(self, facade: MemoryFacade) -> None:
        text = "今天下午三点要去医院复查牙齿"
        facade.ingest(text, source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        again = facade.ingest(text, source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        assert again.decision == "reject"
        assert "Duplicate" in again.rejected[0].reason

    def test_uncertain_ambient_is_not_written(self, facade: MemoryFacade) -> None:
        """拿不准的只发事件、不落库。

        契约 v0.1.7 § 3 收编了这条：「`uncertain` 只发事件，不落库。」`filter.uncertain`
        事件照发，侧栏与丘丘的 `11` 疑惑表情都不受影响。逐字断言在
        `test_memory_contracts.py::TestUncertainNeverPersists`。
        """
        facade.runtime.sqlite.set_setting(
            "thresholds", json.dumps({"accept": 0.99, "uncertain": 0.01})
        )
        result = facade.ingest("买牛奶", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        assert result.decision == "uncertain"
        assert result.accepted == [] and facade.runtime.lance.count("hot") == 0
        assert [e for e in facade.runtime.bus.history if e.type == "write"] == []
        event = next(e for e in facade.runtime.bus.history if e.type == "filter")
        assert event.payload["decision"] == "uncertain"

    def test_ambient_blob_pointer_reaches_the_fact_row(self, facade: MemoryFacade) -> None:
        """被动采集的原件处理完就删，事实这边只留 `blob_id` 指针（CONTRACTS § 5）。"""
        result = facade.ingest(
            "今天下午三点要去医院复查牙齿",
            source=Source.AMBIENT_AUDIO,
            speaker="user",
            ts=BASE_TIME,
            blob_id="audio/f00d",
        )
        rows = facade.runtime.lance.get_many(result.accepted, "hot")
        assert rows and all(r["blob_id"] == "audio/f00d" for r in rows)


class TestIngestContract:
    def test_two_facts_from_the_acceptance_sentence(self, facade: MemoryFacade) -> None:
        """任务书验收条一。"""
        result = facade.ingest(SENTENCE, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        assert len(result.accepted) == 2
        event = next(e for e in facade.runtime.bus.history if e.type == "write")
        assert event.payload["dropped_spans"] == ["用一句话介绍你自己"]

    def test_source_must_be_the_enum(self, facade: MemoryFacade) -> None:
        with pytest.raises(ContractError) as caught:
            facade.ingest("x", source="dialogue", speaker="user", ts=BASE_TIME)  # type: ignore[arg-type]
        assert caught.value.to_dict()["code"] == "contract_violation"

    def test_speaker_restricted_to_two_values(self, facade: MemoryFacade) -> None:
        with pytest.raises(ContractError) as caught:
            facade.ingest("x", source=Source.DIALOGUE, speaker="系统", ts=BASE_TIME)
        assert "assistant" in caught.value.to_dict()["hint"]

    def test_assistant_replies_are_remembered_too(self, facade: MemoryFacade) -> None:
        """AD-6：AI 自己说的也写进记忆。"""
        result = facade.ingest(
            "丘丘住在这台电脑里", source=Source.DIALOGUE, speaker="assistant", ts=BASE_TIME
        )
        rows = facade.runtime.lance.get_many(result.accepted, "hot")
        assert rows[0]["speaker"] == "assistant"

    def test_trace_id_is_fresh_per_call(self, facade: MemoryFacade) -> None:
        a = facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        b = facade.ingest("我住深圳", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        assert a.trace_id != b.trace_id
        assert a.trace_id.startswith("trc_")

    def test_caller_trace_id_is_used_verbatim(self, facade: MemoryFacade) -> None:
        """契约 v0.1.7：`/chat` 生成的那条 trace 一路贯到底，中间件不另起一条。"""
        result = facade.ingest(
            SENTENCE,
            source=Source.DIALOGUE,
            speaker="user",
            ts=BASE_TIME,
            trace_id="trc_from_chat",
        )
        assert result.trace_id == "trc_from_chat"
        assert facade.runtime.bus.history, "这一轮至少发了一条事件"
        assert {e.trace_id for e in facade.runtime.bus.history} == {"trc_from_chat"}

    def test_caller_trace_id_covers_the_filter_event_too(self, facade: MemoryFacade) -> None:
        """被动采集这一路上 `filter` 事件也挂在调用方那条 trace 上。"""
        facade.ingest(
            "",
            source=Source.AMBIENT_AUDIO,
            speaker="user",
            ts=BASE_TIME,
            trace_id="trc_from_ingest",
        )
        event = next(e for e in facade.runtime.bus.history if e.type == "filter")
        assert event.trace_id == "trc_from_ingest"

    def test_persona_source_is_not_an_ingest_entry(self, facade: MemoryFacade) -> None:
        """`Source.PERSONA` 中间件内部用，调用方不传（契约 v0.1.7 § 3）。"""
        with pytest.raises(ContractError) as caught:
            facade.ingest("性格档案：…", source=Source.PERSONA, speaker="assistant", ts=BASE_TIME)
        assert caught.value.to_dict()["code"] == "contract_violation"
        assert "PERSONA" in str(caught.value)
        assert facade.runtime.lance.count("hot") == 0

    def test_naive_ts_is_read_as_utc(self, facade: MemoryFacade) -> None:
        naive = dt.datetime(2026, 9, 5, 10, 0)
        result = facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=naive)
        row = facade.runtime.lance.get_many(result.accepted, "hot")[0]
        assert row["valid_from"].replace(tzinfo=dt.UTC) == BASE_TIME

    def test_chat_failure_returns_empty_accepted_without_retry(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        """ARCHITECTURE § 3：不重试，原话由后端留在 messages 表。"""
        calls: list[int] = []

        class Broken:
            provider = "broken"

            async def complete(self, messages: list[object]) -> str:
                calls.append(1)
                raise RuntimeError("断网")

        rt = make_runtime(clock, Broken())
        facade = MemoryFacade(rt)
        try:
            result = facade.ingest(SENTENCE, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            assert result.accepted == []
            assert result.decision == "accept"
            assert len(calls) == 1, "只试一次"
        finally:
            facade.close()


class TestRecall:
    def test_now_defaults_to_runtime_clock(self, facade: MemoryFacade, clock) -> None:
        clock["now"] = dt.datetime(2030, 5, 6, tzinfo=dt.UTC)
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        facade.recall("昨天聊了什么", budget=Budget())
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        assert "2030-05-05" in event.payload["plan"]["rewritten"]

    def test_explicit_now_wins(self, facade: MemoryFacade) -> None:
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        facade.recall("昨天聊了什么", budget=Budget(), now=dt.datetime(2031, 7, 8, tzinfo=dt.UTC))
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        assert "2031-07-07" in event.payload["plan"]["rewritten"]

    def test_empty_store_returns_empty_result_not_error(self, facade: MemoryFacade) -> None:
        result = facade.recall("他喜欢喝什么", budget=Budget())
        assert result.items == []
        assert result.plan is not None

    def test_caller_trace_id_reaches_the_recall_event(self, facade: MemoryFacade) -> None:
        """契约 v0.1.7：`recall` 事件挂调用方那条 trace，侧栏才串得起这一轮。"""
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        facade.recall("他叫什么", budget=Budget(), trace_id="trc_same_turn")
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        assert event.trace_id == "trc_same_turn"

    def test_recall_without_trace_id_still_makes_one(self, facade: MemoryFacade) -> None:
        facade.recall("他叫什么", budget=Budget())
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        assert event.trace_id.startswith("trc_")


class TestVisibleMemory:
    def seed(self, facade: MemoryFacade) -> None:
        facade.ingest(
            "我叫赵宁，我喜欢喝美式咖啡", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
        )

    def test_facts_land_in_the_visible_library(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        items = facade.list_visible()
        assert {i.content for i in items} == {"用户叫赵宁", "用户喜欢喝美式咖啡"}
        assert all(i.source == "auto" and i.enabled for i in items)

    def test_layers_assigned(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        assert {i.layer for i in facade.list_visible()} == {"L0", "L1"}

    def test_layer_filter(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        assert [i.content for i in facade.list_visible("L0")] == ["用户叫赵宁"]

    def test_bad_layer_rejected(self, facade: MemoryFacade) -> None:
        with pytest.raises(ContractError):
            facade.list_visible("L9")

    def test_edit_content_and_enabled(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        target = facade.list_visible("L0")[0]
        updated = facade.edit_visible(target.id, content="用户的名字是赵宁", enabled=False)
        assert updated.content == "用户的名字是赵宁"
        assert updated.enabled is False

    def test_edit_unknown_id(self, facade: MemoryFacade) -> None:
        with pytest.raises(UnknownVisibleMemoryError) as caught:
            facade.edit_visible("vm_nope", content="x")
        assert caught.value.to_dict()["code"] == "visible_memory_not_found"

    def test_edit_unknown_field_rejected(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        target = facade.list_visible()[0]
        with pytest.raises(ContractError) as caught:
            facade.edit_visible(target.id, colour="红")
        assert "colour" in str(caught.value)

    def test_edit_bad_layer_rejected(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        target = facade.list_visible()[0]
        with pytest.raises(ContractError):
            facade.edit_visible(target.id, layer="L7")

    def test_delete_disables_row_and_supersedes_facts(self, facade: MemoryFacade) -> None:
        """契约 v0.1.7：`enabled` 置否 + `fact_ids` 逐条 `mark_superseded`，两边都不删行。"""
        self.seed(facade)
        target = facade.list_visible("L0")[0]
        fact_id = target.fact_ids[0]

        returned = facade.edit_visible(target.id, deleted=True)

        assert returned.enabled is False
        still_there = facade.runtime.sqlite.get_visible_memory(target.id)
        assert still_there is not None, "visible_memory 那一行不删（AD-9）"
        assert bool(still_there["enabled"]) is False
        row = facade.runtime.lance.get_many([fact_id], "hot")[0]
        assert row["valid_to"] is not None
        assert facade.runtime.lance.count("hot") == 2, "一行都没删"

    def test_deleted_fact_no_longer_recalled(self, facade: MemoryFacade) -> None:
        self.seed(facade)
        target = facade.list_visible("L1")[0]
        facade.edit_visible(target.id, deleted=True)
        texts = [h.text for h in facade.recall("他喜欢喝什么", budget=Budget()).items]
        assert "用户喜欢喝美式咖啡" not in texts

    def test_merge_chain_keeps_every_fact_id(self, clock: dict[str, dt.datetime]) -> None:
        """合并链一长也不能把最早那几条事实弄丢，否则级联作废跟着漏。"""
        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            ids = []
            for text in ("想喝咖啡", "喜欢燕麦奶", "喜欢热的"):
                ids.extend(
                    facade.ingest(
                        text, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
                    ).accepted
                )
            items = facade.list_visible()
            assert len(items) == 1
            assert set(items[0].fact_ids) == set(ids)
        finally:
            facade.close()


class TestSubscribe:
    async def test_async_iteration_yields_events(self, facade: MemoryFacade) -> None:
        stream = facade.subscribe()
        task = asyncio.create_task(anext(stream))  # type: ignore[arg-type]
        await asyncio.sleep(0)
        await asyncio.to_thread(
            facade.ingest, "我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
        )
        event = await asyncio.wait_for(task, timeout=5)
        assert event.type in {"filter", "write", "merge", "recall"}
        assert event.id.startswith("evt_")
        await stream.aclose()


class TestLayerRules:
    @pytest.mark.parametrize(
        ("text", "layer"),
        [
            ("用户叫赵宁", "L0"),
            ("用户住在深圳", "L0"),
            ("用户喜欢喝美式咖啡", "L1"),
            ("用户讨厌香菜", "L1"),
            ("用户下午三点要去医院", "L2"),
        ],
    )
    def test_layer_of(self, text: str, layer: str) -> None:
        assert layer_of(text) == layer

    def test_layers_constant_matches_contract(self) -> None:
        assert LAYERS == ("L0", "L1", "L2")


class TestPlumbing:
    def test_trace_ids_are_unique(self) -> None:
        assert len({new_trace_id() for _ in range(200)}) == 200

    def test_facade_builds_its_own_runtime_when_none_given(self) -> None:
        facade = MemoryFacade()
        try:
            assert isinstance(facade.runtime, MemoryRuntime)
        finally:
            facade.close()

    def test_close_is_idempotent(self, runtime: MemoryRuntime) -> None:
        facade = MemoryFacade(runtime)
        facade.close()
        facade.close()
