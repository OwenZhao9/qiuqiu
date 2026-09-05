"""合成。同义合并、矛盾更新、不物理删除（AD-9）、`merge` 事件（契约 v0.1.5 带 text）。"""

from __future__ import annotations

import datetime as dt
import json

from memory_helpers import BASE_TIME, FakeChat, absorb_all, make_runtime
from qiuqiu_memory.facade import MemoryFacade
from qiuqiu_memory.pipeline.compress import compress
from qiuqiu_memory.pipeline.synthesize import synthesize
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import Source


def ingest_raw(runtime: MemoryRuntime, text: str, *, ts: dt.datetime = BASE_TIME):
    """只压缩、不合成——合成那步用例自己调，好断言中间状态。"""
    return runtime.run(
        compress(
            runtime,
            text,
            source=Source.DIALOGUE,
            speaker="user",
            ts=ts,
            trace_id="trc_test",
        )
    )


def rows_by_id(runtime: MemoryRuntime) -> dict[str, dict]:
    return {r["id"]: r for r in runtime.lance.query_scalar("hot", limit=100)}


class TestDeterministicGate:
    """Chat 不可用 / 不成形状时的兜底：严，宁可漏合并。"""

    def test_unrelated_facts_not_merged(self, runtime: MemoryRuntime) -> None:
        ingest_raw(runtime, "我叫赵宁")
        fresh = ingest_raw(runtime, "我喜欢喝美式咖啡")
        merged = runtime.run(synthesize(runtime, fresh.facts, trace_id="trc_test", now=BASE_TIME))
        assert merged == []

    def test_verbatim_repeat_merged_by_token_overlap(self, runtime: MemoryRuntime) -> None:
        first = ingest_raw(runtime, "我喜欢喝美式咖啡")
        second = ingest_raw(runtime, "我喜欢喝美式咖啡")
        merged = runtime.run(synthesize(runtime, second.facts, trace_id="trc_test", now=BASE_TIME))
        assert len(merged) == 1
        assert merged[0].absorbed[0]["id"] == first.facts[0].id

    def test_thresholds_are_configurable(self, runtime: MemoryRuntime) -> None:
        runtime.sqlite.set_setting("thresholds", json.dumps({"merge_jaccard": 0.01}))
        ingest_raw(runtime, "我叫赵宁")
        fresh = ingest_raw(runtime, "我喜欢喝美式咖啡")
        merged = runtime.run(synthesize(runtime, fresh.facts, trace_id="trc_test", now=BASE_TIME))
        assert merged, "把 Jaccard 门槛调到 0.01 之后就该合了"

    def test_empty_input_is_a_no_op(self, runtime: MemoryRuntime) -> None:
        assert runtime.run(synthesize(runtime, [], trace_id="trc_test", now=BASE_TIME)) == []


class TestModelDrivenMerge:
    def test_three_fragments_become_one(self, clock: dict[str, dt.datetime]) -> None:
        """任务书验收条二：三条碎片合成一条，旧三条 `valid_to` 非空。"""
        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            for text in ("想喝咖啡", "喜欢燕麦奶", "喜欢热的"):
                facade.ingest(text, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            rows = rows_by_id(rt)
            alive = [r for r in rows.values() if r["valid_to"] is None]
            assert len(rows) == 3, "三条都还在，一行都没删（AD-9）"
            assert len(alive) == 1, "只剩一条有效"
            invalidated = [r for r in rows.values() if r["valid_to"] is not None]
            assert all(r["superseded_by"] for r in invalidated)
        finally:
            facade.close()

    def test_contradiction_supersedes_old_fact(self, clock: dict[str, dt.datetime]) -> None:
        """任务书验收条三：搬家之后旧的「住北京」被 `superseded_by`。"""
        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            old = facade.ingest("我住在北京", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            new = facade.ingest(
                "我搬到深圳了", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
            )
            rows = rows_by_id(rt)
            old_row = rows[old.accepted[0]]
            assert old_row["valid_to"] is not None
            assert old_row["superseded_by"] == new.accepted[0]
            assert rows[new.accepted[0]]["valid_to"] is None
        finally:
            facade.close()

    def test_result_text_rewrites_the_new_fact(self, clock: dict[str, dt.datetime]) -> None:
        def rewrite(prompt: str) -> str:
            body = json.loads(absorb_all(prompt))
            body["result_text"] = "用户喜欢喝加燕麦奶的热美式"
            return json.dumps(body, ensure_ascii=False)

        rt = make_runtime(clock, FakeChat([("记忆合成器", rewrite)]))
        facade = MemoryFacade(rt)
        try:
            facade.ingest("我喜欢咖啡", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            result = facade.ingest(
                "我喜欢咖啡加燕麦奶", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
            )
            row = rows_by_id(rt)[result.accepted[0]]
            assert row["text"] == "用户喜欢喝加燕麦奶的热美式"
            assert row["tokens"], "改写之后 token 要跟着重算，否则字面路搜不到"
        finally:
            facade.close()

    def test_unknown_ids_from_model_ignored(self, clock: dict[str, dt.datetime]) -> None:
        """模型胡编一个 id 不能把别的事实误伤。"""
        reply = json.dumps({"absorbed": ["fact_deadbeef"], "result_text": ""})
        rt = make_runtime(clock, FakeChat([("记忆合成器", reply)]))
        try:
            ingest_raw(rt, "我喜欢喝美式咖啡")
            fresh = ingest_raw(rt, "我叫赵宁")
            assert rt.run(synthesize(rt, fresh.facts, trace_id="trc_test", now=BASE_TIME)) == []
        finally:
            rt.close()

    def test_chat_failure_falls_back_to_deterministic(self, clock: dict[str, dt.datetime]) -> None:
        """合成这一步的 Chat 炸了不该让整条 ingest 失败，退回确定性判据继续走。"""

        class BrokenOnSynthesize:
            provider = "half-broken"

            async def complete(self, messages: list[object]) -> str:
                prompt = "\n".join(m.content for m in messages)  # type: ignore[attr-defined]
                if "记忆合成器" in prompt:
                    raise RuntimeError("断网了")
                return "这不是 JSON。"

        rt = make_runtime(clock, BrokenOnSynthesize())
        try:
            ingest_raw(rt, "我喜欢喝美式咖啡")
            second = ingest_raw(rt, "我喜欢喝美式咖啡")
            merged = rt.run(synthesize(rt, second.facts, trace_id="trc_test", now=BASE_TIME))
            assert len(merged) == 1, "退回 token Jaccard 判据，逐字重复照样合"
        finally:
            rt.close()


class TestMergeEvent:
    def test_payload_matches_contract_v015(self, clock: dict[str, dt.datetime]) -> None:
        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            facade.ingest("我住在北京", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            facade.ingest("我搬到深圳了", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            event = next(e for e in reversed(rt.bus.history) if e.type == "merge")
            assert set(event.payload) == {
                "result_id",
                "result_text",
                "absorbed",
                "invalidated",
            }
            assert event.payload["result_text"], "v0.1.5 起要带 text，不然侧栏只有 id"
            for item in event.payload["absorbed"]:
                assert set(item) == {"id", "text"} and item["text"]
            for item in event.payload["invalidated"]:
                assert set(item) == {"id", "text", "valid_to"}
                assert item["valid_to"].endswith("Z")
        finally:
            facade.close()

    def test_no_event_when_nothing_merged(self, runtime: MemoryRuntime) -> None:
        ingest_raw(runtime, "我叫赵宁")
        fresh = ingest_raw(runtime, "我喜欢喝美式咖啡")
        runtime.run(synthesize(runtime, fresh.facts, trace_id="trc_test", now=BASE_TIME))
        assert [e for e in runtime.bus.history if e.type == "merge"] == []
