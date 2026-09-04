"""事实表的读写：幂等、三条查询路径、作废不删行。"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pyarrow as pa
import pytest
from conftest import BASE_TIME, make_fact, make_vector
from qiuqiu_data.lance import VECTOR_DIM, LanceStore


@pytest.fixture
def store(data_root: Path) -> LanceStore:
    s = LanceStore()
    s.init()
    return s


def test_upsert_same_id_twice_is_idempotent(store: LanceStore, rng) -> None:
    fact = make_fact("f1", rng)

    store.upsert([fact])
    first = store.get("f1", "hot")
    store.upsert([fact])
    second = store.get("f1", "hot")

    assert store.count("hot") == 1
    assert first == second
    assert first is not None
    assert first["text"] == "事实 f1"
    assert first["tokens"] == ["喜欢", "咖啡", "f1"]
    assert first["valid_from"] == BASE_TIME
    assert first["valid_to"] is None
    assert len(first["vector"]) == VECTOR_DIM


def test_upsert_updates_existing_row_in_place(store: LanceStore, rng) -> None:
    store.upsert([make_fact("f1", rng, text="旧的")])
    store.upsert([make_fact("f1", rng, text="新的")])

    row = store.get("f1", "hot")
    assert store.count("hot") == 1
    assert row is not None and row["text"] == "新的"


def test_upsert_dedupes_within_one_batch(store: LanceStore, rng) -> None:
    written = store.upsert([make_fact("f1", rng, text="A"), make_fact("f1", rng, text="B")])

    assert written == 1
    row = store.get("f1", "hot")
    assert row is not None and row["text"] == "B"


def test_upsert_rejects_wrong_vector_dim(store: LanceStore, rng) -> None:
    bad = make_fact("f1", rng)
    bad["vector"] = [0.1, 0.2]

    with pytest.raises(ValueError, match="维度"):
        store.upsert([bad])


def test_upsert_rejects_unknown_field(store: LanceStore, rng) -> None:
    bad = make_fact("f1", rng) | {"score": 1.0}

    with pytest.raises(ValueError, match="没有这些字段"):
        store.upsert([bad])


def test_get_without_tier_looks_hot_then_cold(store: LanceStore, rng) -> None:
    store.upsert([make_fact("hot1", rng)], "hot")
    store.upsert([make_fact("cold1", rng)], "cold")

    assert store.get("hot1") is not None
    assert store.get("cold1") is not None
    assert store.get("nope") is None
    assert store.get("cold1", "hot") is None


def test_query_vector_returns_nearest_first(store: LanceStore, rng) -> None:
    target = make_vector(rng)
    store.upsert([make_fact("target", rng, vector=target)])
    store.upsert([make_fact(f"noise{i}", rng) for i in range(20)])

    hits = store.query_vector(target, k=5)

    assert [h["id"] for h in hits][0] == "target"
    assert len(hits) == 5
    assert "_distance" in hits[0]


def test_query_vector_accepts_filter_and_dim_guard(store: LanceStore, rng) -> None:
    store.upsert([make_fact("a", rng, speaker="user"), make_fact("b", rng, speaker="qiuqiu")])

    hits = store.query_vector(make_vector(rng), k=10, where="speaker = 'qiuqiu'")
    assert [h["id"] for h in hits] == ["b"]

    with pytest.raises(ValueError, match="维度"):
        store.query_vector([0.0, 1.0])


def test_query_fts_matches_tokens(store: LanceStore, rng) -> None:
    store.upsert(
        [
            make_fact("a", rng, tokens=["喜欢", "咖啡"]),
            make_fact("b", rng, tokens=["讨厌", "香菜"]),
        ]
    )

    hits = store.query_fts("咖啡", k=10)

    assert [h["id"] for h in hits] == ["a"]
    assert "_score" in hits[0]


def test_query_scalar_by_entity_speaker_and_time(store: LanceStore, rng) -> None:
    old = dt.datetime(2026, 1, 1)
    store.upsert(
        [
            make_fact("a", rng, entities=["猫"], speaker="user"),
            make_fact("b", rng, entities=["狗"], speaker="user"),
            make_fact("c", rng, entities=["猫"], speaker="qiuqiu", valid_from=old),
        ]
    )

    assert {r["id"] for r in store.query_scalar(entities=["猫"])} == {"a", "c"}
    assert {r["id"] for r in store.query_scalar(speaker="user")} == {"a", "b"}
    assert {r["id"] for r in store.query_scalar(valid_from_after=BASE_TIME)} == {"a", "b"}
    assert {r["id"] for r in store.query_scalar(entities=["猫"], speaker="qiuqiu")} == {"c"}
    assert store.query_scalar(entities=["鱼"]) == []


def test_mark_superseded_writes_valid_to_without_deleting(store: LanceStore, rng) -> None:
    store.upsert([make_fact("old", rng), make_fact("new", rng)])
    at = dt.datetime(2026, 9, 20, 8, 0, 0)

    changed = store.mark_superseded("old", superseded_by="new", valid_to=at)

    assert changed is True
    assert store.count("hot") == 2  # 行还在（AD-9）
    row = store.get("old", "hot")
    assert row is not None
    assert row["valid_to"] == at
    assert row["superseded_by"] == "new"

    still_valid = store.query_scalar(only_valid=True)
    assert {r["id"] for r in still_valid} == {"new"}
    assert {h["id"] for h in store.query_vector(make_vector(rng), k=10, only_valid=True)} == {"new"}


def test_mark_superseded_on_missing_id_returns_false(store: LanceStore, rng) -> None:
    assert store.mark_superseded("nope") is False


def test_touch_updates_last_hit_at(store: LanceStore, rng) -> None:
    store.upsert([make_fact("a", rng), make_fact("b", rng)])
    at = dt.datetime(2026, 10, 1)

    assert store.touch(["a"], at) == 1

    assert store.get("a", "hot")["last_hit_at"] == at
    assert store.get("b", "hot")["last_hit_at"] == BASE_TIME


def test_timezone_aware_input_is_stored_as_utc(store: LanceStore, rng) -> None:
    tz = dt.timezone(dt.timedelta(hours=8))
    aware = dt.datetime(2026, 9, 1, 20, 0, 0, tzinfo=tz)
    store.upsert([make_fact("a", rng, valid_from=aware)])

    assert store.get("a", "hot")["valid_from"] == dt.datetime(2026, 9, 1, 12, 0, 0)


def test_sql_quotes_in_id_do_not_break_queries(store: LanceStore, rng) -> None:
    weird = "it's/a'id"
    store.upsert([make_fact(weird, rng, entities=["x"])])

    row = store.get(weird, "hot")
    assert row is not None and row["id"] == weird
    assert store.mark_superseded(weird) is True


def test_ensure_indexes_is_repeatable(store: LanceStore, rng) -> None:
    before = store.ensure_indexes("hot")
    after = store.ensure_indexes("hot")

    assert before == after
    assert set(after) == {"tokens_idx", "entities_idx", "speaker_idx", "valid_from_idx"}


def test_empty_upsert_is_a_noop(store: LanceStore) -> None:
    assert store.upsert([]) == 0
    assert store.delete_rows([], "hot") == 0
    assert store.touch([]) == 0
    assert store.get_many([], "hot") == []


def test_vector_column_is_fixed_size_float32(store: LanceStore, rng) -> None:
    store.upsert([make_fact("a", rng)])
    schema = store.table("hot").schema

    field = schema.field("vector")
    assert field.type.list_size == VECTOR_DIM
    assert pa.types.is_float32(field.type.value_type)
