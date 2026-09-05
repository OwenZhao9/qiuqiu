"""冷热分层。判断标准在 memory，搬运动作在 `qiuqiu_data.tiering`（AD-10）。"""

from __future__ import annotations

import datetime as dt

from memory_helpers import BASE_TIME
from qiuqiu_memory.facade import MemoryFacade
from qiuqiu_memory.pipeline.tiering import STALE_DAYS, make_tiering, nightly, promote
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import Budget, Source


def write_fact(runtime: MemoryRuntime, fact_id: str, text: str, at: dt.datetime, tier: str) -> None:
    runtime.lance.upsert(
        [
            {
                "id": fact_id,
                "text": text,
                "vector": runtime.embedder.embed_one(text),
                "tokens": ["测试"],
                "entities": ["用户"],
                "speaker": "user",
                "source": "dialogue",
                "valid_from": at,
                "last_hit_at": at,
            }
        ],
        tier,
    )


def test_stale_days_matches_ad10() -> None:
    """AD-10 定的是 30 天。改它要同步改架构决策。"""
    assert STALE_DAYS == 30


class TestPromote:
    def test_moves_row_from_cold_to_hot(self, runtime: MemoryRuntime) -> None:
        write_fact(runtime, "fact_cold1", "用户以前在北京工作", BASE_TIME, "cold")
        moved = promote(runtime, ["fact_cold1"])
        assert moved == ["fact_cold1"]
        assert runtime.lance.count("hot") == 1
        assert runtime.lance.count("cold") == 0

    def test_updates_last_hit_at_with_injected_clock(self, runtime: MemoryRuntime) -> None:
        write_fact(runtime, "fact_cold1", "用户以前在北京工作", BASE_TIME, "cold")
        later = BASE_TIME + dt.timedelta(days=100)
        promote(runtime, ["fact_cold1"], at=later)
        row = runtime.lance.get_many(["fact_cold1"], "hot")[0]
        assert row["last_hit_at"].replace(tzinfo=dt.UTC) == later

    def test_missing_ids_skipped(self, runtime: MemoryRuntime) -> None:
        assert promote(runtime, ["fact_nope"]) == []

    def test_empty_and_blank_ids_are_no_ops(self, runtime: MemoryRuntime) -> None:
        assert promote(runtime, []) == []
        assert promote(runtime, ["", ""]) == []

    def test_duplicate_ids_collapsed(self, runtime: MemoryRuntime) -> None:
        write_fact(runtime, "fact_cold1", "用户以前在北京工作", BASE_TIME, "cold")
        assert promote(runtime, ["fact_cold1", "fact_cold1"]) == ["fact_cold1"]


class TestNightly:
    def test_demotes_only_stale_rows(self, runtime: MemoryRuntime, clock) -> None:
        write_fact(runtime, "fact_old", "很久没提过的事", BASE_TIME, "hot")
        write_fact(runtime, "fact_new", "刚说过的事", BASE_TIME + dt.timedelta(days=40), "hot")
        clock["now"] = BASE_TIME + dt.timedelta(days=45)

        summary = nightly(runtime)
        assert summary["demoted"] == 1
        assert summary["demoted_ids"] == ["fact_old"]
        assert summary["hot_rows"] == 1 and summary["cold_rows"] == 1

    def test_nothing_stale_is_a_no_op(self, runtime: MemoryRuntime) -> None:
        write_fact(runtime, "fact_new", "刚说过的事", BASE_TIME, "hot")
        assert nightly(runtime)["demoted"] == 0

    def test_custom_window(self, runtime: MemoryRuntime, clock) -> None:
        write_fact(runtime, "fact_old", "三天前的事", BASE_TIME, "hot")
        clock["now"] = BASE_TIME + dt.timedelta(days=3)
        assert nightly(runtime, days=1)["demoted"] == 1

    def test_summary_shape_is_loggable(self, runtime: MemoryRuntime) -> None:
        summary = nightly(runtime)
        assert set(summary) == {
            "ran_at",
            "days",
            "demoted",
            "demoted_ids",
            "hot_rows",
            "cold_rows",
        }


class TestClockInjection:
    def test_make_tiering_uses_runtime_clock(self, runtime: MemoryRuntime, clock) -> None:
        clock["now"] = dt.datetime(2030, 1, 1, tzinfo=dt.UTC)
        assert make_tiering(runtime).now() == clock["now"]

    def test_explicit_at_overrides_runtime_clock(self, runtime: MemoryRuntime) -> None:
        fixed = dt.datetime(2031, 2, 3, tzinfo=dt.UTC)
        assert make_tiering(runtime, at=fixed).now() == fixed


class TestRoundTrip:
    def test_demote_then_recall_promotes_back(self, facade: MemoryFacade, clock) -> None:
        """降冷 → 召回命中 → 回热，一整圈跑通。"""
        runtime = facade.runtime
        result = facade.ingest(
            "我以前在北京的一家出版社做过编辑",
            source=Source.DIALOGUE,
            speaker="user",
            ts=BASE_TIME,
        )
        fact_id = result.accepted[0]

        clock["now"] = BASE_TIME + dt.timedelta(days=STALE_DAYS + 5)
        assert nightly(runtime)["demoted_ids"] == [fact_id]
        assert runtime.lance.count("hot") == 0

        recalled = facade.recall("他以前在哪里工作", budget=Budget(), now=clock["now"])
        assert fact_id in recalled.cold_promoted
        assert runtime.lance.count("hot") == 1
