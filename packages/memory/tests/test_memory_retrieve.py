"""检索。规划 → 三路 → 并集去重 → `Budget` 截断 → `recall` 事件。"""

from __future__ import annotations

import datetime as dt
import json

from memory_helpers import BASE_TIME, FakeChat, make_runtime
from qiuqiu_memory.facade import MemoryFacade
from qiuqiu_memory.pipeline import retrieve as retrieve_module
from qiuqiu_memory.pipeline.retrieve import (
    MAX_DEPTH,
    PATH_QUOTA,
    plan_retrieval,
    retrieve,
)
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import PATHS, Budget, Source

CORPUS = (
    "我叫赵宁",
    "我喜欢喝美式咖啡",
    "我住在深圳南山",
    "我在一家做桌面软件的公司上班",
    "我周末喜欢去公园跑步",
)


def seed(facade: MemoryFacade) -> None:
    for text in CORPUS:
        facade.ingest(text, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)


class TestPlanner:
    async def test_deterministic_plan_when_model_gives_no_json(
        self, runtime: MemoryRuntime
    ) -> None:
        plan, cold = await plan_retrieval(runtime, "他喜欢喝什么", budget=Budget(), now=BASE_TIME)
        assert plan.paths[0] == "semantic"
        assert set(plan.paths) <= set(PATHS)
        assert 4 <= plan.depth <= 16
        assert plan.rewritten == "用户喜欢喝什么", "人称要归一"
        assert cold is False

    async def test_old_hint_words_trigger_cold_lookup(self, runtime: MemoryRuntime) -> None:
        _, cold = await plan_retrieval(
            runtime, "我以前住在哪里来着", budget=Budget(), now=BASE_TIME
        )
        assert cold is True

    async def test_relative_time_rewritten_with_recall_now(self, runtime: MemoryRuntime) -> None:
        plan, _ = await plan_retrieval(
            runtime,
            "昨天聊了什么",
            budget=Budget(),
            now=dt.datetime(2030, 3, 2, tzinfo=dt.UTC),
        )
        assert "2030-03-01" in plan.rewritten

    async def test_model_plan_honoured(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps(
            {"paths": ["lexical"], "depth": 3, "rewritten": "用户的名字", "cold": True},
            ensure_ascii=False,
        )
        rt = make_runtime(clock, FakeChat([("检索规划器", reply)]))
        try:
            plan, cold = await plan_retrieval(rt, "他叫啥", budget=Budget(), now=BASE_TIME)
            assert plan.paths == ["lexical"]
            assert plan.depth == 3
            assert plan.rewritten == "用户的名字"
            assert cold is True
        finally:
            rt.close()

    async def test_model_depth_clamped(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps({"paths": ["semantic"], "depth": 9999, "rewritten": "x"})
        rt = make_runtime(clock, FakeChat([("检索规划器", reply)]))
        try:
            plan, _ = await plan_retrieval(rt, "他叫啥", budget=Budget(), now=BASE_TIME)
            assert plan.depth == MAX_DEPTH
        finally:
            rt.close()

    async def test_bogus_paths_from_model_ignored(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps({"paths": ["telepathy"], "depth": 5, "rewritten": "x"})
        rt = make_runtime(clock, FakeChat([("检索规划器", reply)]))
        try:
            plan, _ = await plan_retrieval(rt, "他叫啥", budget=Budget(), now=BASE_TIME)
            assert set(plan.paths) <= set(PATHS) and plan.paths
        finally:
            rt.close()

    async def test_budget_paths_are_a_hard_constraint(self, runtime: MemoryRuntime) -> None:
        """调用方点了名的路径，规划器不能加戏。"""
        plan, _ = await plan_retrieval(
            runtime, "他喜欢喝什么", budget=Budget(paths={"lexical"}), now=BASE_TIME
        )
        assert plan.paths == ["lexical"]

    async def test_budget_paths_win_even_if_planner_disagrees(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        reply = json.dumps({"paths": ["semantic"], "depth": 5, "rewritten": "x"})
        rt = make_runtime(clock, FakeChat([("检索规划器", reply)]))
        try:
            plan, _ = await plan_retrieval(
                rt, "他叫啥", budget=Budget(paths={"symbolic"}), now=BASE_TIME
            )
            assert plan.paths == ["symbolic"]
        finally:
            rt.close()


class TestPaths:
    def test_recall_finds_the_right_fact(self, facade: MemoryFacade) -> None:
        seed(facade)
        result = facade.recall("他喜欢喝什么", budget=Budget())
        assert "用户喜欢喝美式咖啡" in [h.text for h in result.items]

    def test_hits_are_deduplicated_across_paths(self, facade: MemoryFacade) -> None:
        seed(facade)
        result = facade.recall("赵宁喜欢喝什么咖啡", budget=Budget())
        ids = [h.id for h in result.items]
        assert len(ids) == len(set(ids))

    def test_paths_used_subset_of_plan(self, facade: MemoryFacade) -> None:
        seed(facade)
        result = facade.recall("他喜欢喝什么", budget=Budget())
        assert result.plan is not None
        assert set(result.paths_used) <= set(result.plan.paths)

    def test_scores_normalized_to_unit_range(self, facade: MemoryFacade) -> None:
        """三路分数不同源，必须先压到同一量纲才好放进一个 hits[] 里。"""
        seed(facade)
        result = facade.recall("赵宁住在哪里", budget=Budget())
        assert all(0.0 <= h.score <= 1.0 for h in result.items)

    def test_superseded_facts_never_returned(self, clock: dict[str, dt.datetime]) -> None:
        """任务书验收条三：搬完家之后 `recall` 只回深圳。"""
        from memory_helpers import absorb_all

        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            facade.ingest("我住在北京", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            facade.ingest("我搬到深圳了", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            texts = " ".join(h.text for h in facade.recall("周末去哪", budget=Budget()).items)
            assert "深圳" in texts
            assert "北京" not in texts
        finally:
            facade.close()

    def test_one_broken_path_does_not_sink_the_others(
        self, facade: MemoryFacade, monkeypatch
    ) -> None:
        seed(facade)

        def explode(*_a: object, **_k: object) -> list:
            raise RuntimeError("字面路炸了")

        monkeypatch.setitem(retrieve_module._RUNNERS, "lexical", explode)
        result = facade.recall("他喜欢喝什么", budget=Budget())
        assert result.items, "语义路和标签路照样出结果"

    def test_empty_query_does_not_crash(self, facade: MemoryFacade) -> None:
        seed(facade)
        assert facade.recall("", budget=Budget()).items is not None


class TestBudget:
    def test_max_items_respected(self, facade: MemoryFacade) -> None:
        seed(facade)
        result = facade.recall("赵宁 咖啡 深圳 公司 跑步", budget=Budget(max_items=2))
        assert len(result.items) <= 2

    def test_max_tokens_respected(self, facade: MemoryFacade) -> None:
        seed(facade)
        budget = Budget(max_items=10, max_tokens=12)
        result = facade.recall("赵宁 咖啡 深圳 公司 跑步", budget=budget)
        assert (
            sum(len(h.text) for h in result.items) <= budget.max_tokens or len(result.items) == 1
        ), "第一条永远放得进去，之后才卡 token"

    def test_quota_shares_sum_to_one(self) -> None:
        assert set(PATH_QUOTA) == set(PATHS)
        assert abs(sum(PATH_QUOTA.values()) - 1.0) < 1e-9

    def test_defaults_match_contract(self) -> None:
        budget = Budget()
        assert (budget.max_items, budget.max_tokens, budget.paths) == (12, 2048, None)


class TestColdTier:
    def test_cold_hit_is_promoted_back_to_hot(self, facade: MemoryFacade) -> None:
        """命中冷条目要整条回热，并写进 `cold_promoted`（AD-10）。"""
        runtime = facade.runtime
        result = facade.ingest(
            "我以前在北京的一家出版社做过编辑",
            source=Source.DIALOGUE,
            speaker="user",
            ts=BASE_TIME,
        )
        fact_id = result.accepted[0]
        rows = runtime.lance.get_many([fact_id], "hot")
        runtime.lance.upsert([{k: r[k] for k in r if not k.startswith("_")} for r in rows], "cold")
        runtime.lance.delete_rows([fact_id], "hot")
        assert runtime.lance.count("hot") == 0

        recalled = facade.recall("他以前在哪里工作", budget=Budget())
        assert fact_id in recalled.cold_promoted
        assert runtime.lance.count("hot") == 1
        assert runtime.lance.count("cold") == 0

    def test_no_cold_dive_when_hot_is_full_enough(self, facade: MemoryFacade) -> None:
        seed(facade)
        result = facade.recall("他喜欢喝什么", budget=Budget(max_items=2))
        assert result.cold_promoted == []


class TestRecallEvent:
    def test_payload_matches_contract_v015(self, facade: MemoryFacade) -> None:
        seed(facade)
        facade.recall("他喜欢喝什么", budget=Budget())
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        payload = event.payload
        assert set(payload) == {
            "query",
            "plan",
            "hits",
            "skipped_paths",
            "tokens_injected",
            "cold_promoted",
        }
        assert set(payload["plan"]) == {"paths", "depth", "rewritten"}
        for hit in payload["hits"]:
            assert set(hit) == {"id", "text", "path", "score"}
            assert hit["text"], "v0.1.5 起 hits 要带 text，不然侧栏只有 id"
        assert isinstance(payload["tokens_injected"], int)

    def test_skipped_paths_reported(self, facade: MemoryFacade) -> None:
        seed(facade)
        facade.recall("他喜欢喝什么", budget=Budget(paths={"semantic"}))
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        assert set(event.payload["skipped_paths"]) == {"lexical", "symbolic"}

    def test_tokens_injected_matches_hits(self, facade: MemoryFacade) -> None:
        seed(facade)
        result = facade.recall("他喜欢喝什么", budget=Budget())
        event = next(e for e in reversed(facade.runtime.bus.history) if e.type == "recall")
        assert event.payload["tokens_injected"] == sum(len(h.text) for h in result.items)


class TestLastHit:
    def test_recall_updates_last_hit_at(self, facade: MemoryFacade, clock) -> None:
        """召回即「用过」，冷热调度靠 `last_hit_at`（AD-10）。"""
        runtime = facade.runtime
        result = facade.ingest(
            "我喜欢喝美式咖啡", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
        )
        later = BASE_TIME + dt.timedelta(days=3)
        clock["now"] = later
        facade.recall("他喜欢喝什么", budget=Budget(), now=later)
        row = runtime.lance.get_many(result.accepted, "hot")[0]
        assert row["last_hit_at"].replace(tzinfo=dt.UTC) == later


async def test_retrieve_returns_plan_object(runtime: MemoryRuntime) -> None:
    result = await retrieve(
        runtime, "他喜欢喝什么", budget=Budget(), now=BASE_TIME, trace_id="trc_test"
    )
    assert result.plan is not None
    assert result.to_dict()["plan"]["rewritten"]
