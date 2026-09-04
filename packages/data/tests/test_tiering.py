"""冷热搬运：时间注入、降冷清空热表、回热删冷表行。"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
from conftest import BASE_TIME, make_fact, make_vector
from qiuqiu_data.lance import LanceStore
from qiuqiu_data.tiering import Tiering


class FakeClock:
    """可注入的时钟：测试用它把时间推到 31 天后，不动系统时钟。"""

    def __init__(self, start: dt.datetime) -> None:
        self.at = start

    def __call__(self) -> dt.datetime:
        return self.at

    def advance(self, days: int) -> None:
        self.at += dt.timedelta(days=days)


@pytest.fixture
def store(data_root: Path) -> LanceStore:
    s = LanceStore()
    s.init()
    return s


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(BASE_TIME)


@pytest.fixture
def tiering(store: LanceStore, clock: FakeClock) -> Tiering:
    return Tiering(store, now=clock)


def test_demote_stale_moves_everything_after_31_days(
    store: LanceStore, tiering: Tiering, clock: FakeClock, rng
) -> None:
    facts = [make_fact(f"f{i}", rng) for i in range(5)]
    store.upsert(facts)
    assert store.count("hot") == 5

    # 还没到 30 天，一条都不动
    clock.advance(29)
    assert tiering.demote_stale() == []
    assert store.count("hot") == 5

    # 时间前进到第 31 天
    clock.advance(2)
    moved = tiering.demote_stale()

    assert sorted(moved) == [f"f{i}" for i in range(5)]
    assert store.count("hot") == 0
    assert store.count("cold") == 5
    cold = store.get("f0", "cold")
    assert cold is not None
    assert cold["text"] == "事实 f0"
    assert cold["last_hit_at"] == BASE_TIME  # 整条搬，不改字段


def test_demote_stale_only_touches_rows_older_than_threshold(
    store: LanceStore, tiering: Tiering, clock: FakeClock, rng
) -> None:
    store.upsert(
        [
            make_fact("old", rng, last_hit_at=BASE_TIME),
            make_fact("fresh", rng, last_hit_at=BASE_TIME + dt.timedelta(days=25)),
        ]
    )
    clock.advance(31)

    assert tiering.demote_stale(days=30) == ["old"]
    assert [r["id"] for r in store.query_scalar("hot")] == ["fresh"]
    assert [r["id"] for r in store.query_scalar("cold")] == ["old"]


def test_demote_stale_batches(store: LanceStore, clock: FakeClock, rng) -> None:
    store.upsert([make_fact(f"f{i}", rng) for i in range(7)])
    clock.advance(31)
    small_batches = Tiering(store, now=clock, batch_size=2)

    moved = small_batches.demote_stale()

    assert len(moved) == 7
    assert store.count("hot") == 0
    assert store.count("cold") == 7


def test_promote_brings_row_back_and_deletes_cold_row(
    store: LanceStore, tiering: Tiering, clock: FakeClock, rng
) -> None:
    target = make_vector(rng)
    store.upsert([make_fact("f0", rng, vector=target), make_fact("f1", rng)])
    clock.advance(31)
    tiering.demote_stale()
    assert store.count("hot") == 0

    promoted = tiering.promote(["f0"])

    assert promoted == ["f0"]
    assert store.count("hot") == 1
    assert store.count("cold") == 1
    assert store.get("f0", "cold") is None
    # 回热后各条路径都能查到
    hot = store.get("f0", "hot")
    assert hot is not None
    assert hot["last_hit_at"] == clock.at  # promote 更新 last_hit_at
    assert [h["id"] for h in store.query_vector(target, k=1)] == ["f0"]
    assert [h["id"] for h in store.query_fts("f0", k=5)] == ["f0"]
    assert [r["id"] for r in store.query_scalar(entities=["f0"])] == ["f0"]
    assert store.list_indexes("hot")["tokens_idx"] == "FTS"


def test_promote_skips_ids_not_in_cold(tiering: Tiering, store: LanceStore, rng) -> None:
    store.upsert([make_fact("hot_only", rng)], "hot")

    assert tiering.promote([]) == []
    assert tiering.promote(["hot_only", "nope"]) == []
    assert store.count("hot") == 1


def test_promote_then_demote_roundtrip_is_stable(
    store: LanceStore, tiering: Tiering, clock: FakeClock, rng
) -> None:
    store.upsert([make_fact("f0", rng)])
    before = store.get("f0", "hot")

    clock.advance(31)
    tiering.demote_stale()
    tiering.promote(["f0"])

    after = store.get("f0", "hot")
    assert after is not None and before is not None
    assert {k: v for k, v in after.items() if k != "last_hit_at"} == {
        k: v for k, v in before.items() if k != "last_hit_at"
    }


def test_nightly_returns_summary(
    store: LanceStore, tiering: Tiering, clock: FakeClock, rng
) -> None:
    store.upsert([make_fact(f"f{i}", rng) for i in range(3)])
    clock.advance(31)

    summary = tiering.nightly()

    assert summary["demoted"] == 3
    assert summary["hot_rows"] == 0
    assert summary["cold_rows"] == 3
    assert summary["days"] == 30
    assert summary["ran_at"] == clock.at.isoformat()

    # 再跑一次没东西可搬
    assert tiering.nightly()["demoted"] == 0
