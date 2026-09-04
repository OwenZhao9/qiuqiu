"""SQLite 八表、WAL、幂等迁移、event_log 游标、persona_learned 历史版本。"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
from qiuqiu_data.sqlite import TABLES, SqliteStore


@pytest.fixture
def store(tmp_path: Path) -> SqliteStore:
    s = SqliteStore(path=tmp_path / "qiuqiu.db")
    s.migrate()
    yield s
    s.close()


def test_migrate_creates_eight_tables_in_wal_mode(store: SqliteStore) -> None:
    assert set(TABLES) <= store.table_names()
    assert len(TABLES) == 8
    assert store.journal_mode().lower() == "wal"


def test_migrate_is_idempotent(tmp_path: Path) -> None:
    store = SqliteStore(path=tmp_path / "qiuqiu.db")

    first = store.migrate()
    second = store.migrate()
    third = store.migrate()

    assert first == ["001_init"]
    assert second == []
    assert third == []
    assert store.applied_migrations() == ["001_init"]
    store.close()


def test_migrate_survives_a_lost_ledger(store: SqliteStore) -> None:
    # 账本没了也能重跑：迁移脚本本身全是 IF NOT EXISTS
    store.upsert_session("s1", "旧会话")
    store.conn.execute("DROP TABLE schema_migrations")
    store.conn.commit()

    assert store.migrate() == ["001_init"]
    assert store.get_session("s1") is not None


def test_sessions_and_messages_roundtrip(store: SqliteStore) -> None:
    store.upsert_session("s1", "第一次聊天")
    store.add_message("m1", "s1", "user", "你好", created_at=dt.datetime(2026, 9, 1, 10))
    store.add_message(
        "m2",
        "s1",
        "assistant",
        "你也好",
        model="deepseek-v4-flash",
        created_at=dt.datetime(2026, 9, 1, 10, 1),
    )

    session = store.get_session("s1")
    assert session is not None
    assert session["title"] == "第一次聊天"
    assert session["archived"] is False

    messages = store.list_messages("s1")
    assert [m["id"] for m in messages] == ["m1", "m2"]
    assert messages[1]["model"] == "deepseek-v4-flash"
    assert messages[1]["favorite"] is False


def test_message_requires_existing_session(store: SqliteStore) -> None:
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        store.add_message("m1", "missing", "user", "你好")


def test_session_archive_and_listing(store: SqliteStore) -> None:
    store.upsert_session("s1", "在用的")
    store.upsert_session("s2", "归档的")
    store.set_session_archived("s2", True)

    assert [s["id"] for s in store.list_sessions()] == ["s1"]
    assert [s["id"] for s in store.list_sessions(archived=True)] == ["s2"]
    assert len(store.list_sessions(archived=None)) == 2


def test_favorite_messages(store: SqliteStore) -> None:
    store.upsert_session("s1")
    store.add_message("m1", "s1", "user", "记住这句")
    store.set_message_favorite("m1", True)

    assert [m["id"] for m in store.list_favorite_messages()] == ["m1"]


def test_visible_memory_json_column_roundtrips_as_list(store: SqliteStore) -> None:
    store.upsert_visible_memory(
        "v1", layer="fact", content="我喜欢咖啡", source="chat", fact_ids=["f1", "f2"]
    )

    row = store.get_visible_memory("v1")
    assert row is not None
    assert row["fact_ids_json"] == ["f1", "f2"]
    assert row["enabled"] is True

    store.set_visible_memory_enabled("v1", False)
    assert store.list_visible_memory(enabled=True) == []
    assert len(store.list_visible_memory(enabled=False)) == 1


def test_event_log_ids_increment_and_since_cursor_works(store: SqliteStore) -> None:
    ids = [store.append_event("write", {"n": i}, trace_id=f"t{i}") for i in range(5)]

    assert ids == sorted(ids)
    assert ids == list(range(ids[0], ids[0] + 5))
    assert store.latest_event_id() == ids[-1]

    tail = store.events_since(ids[1])
    assert [e["id"] for e in tail] == ids[2:]
    assert tail[0]["payload_json"] == {"n": 2}
    assert store.events_since(ids[-1]) == []
    assert len(store.events_since(0)) == 5


def test_event_log_cursor_filters_and_limit(store: SqliteStore) -> None:
    store.append_event("write", {"a": 1})
    store.append_event("recall", {"b": 2}, trace_id="tr")
    store.append_event("write", {"c": 3})

    assert [e["type"] for e in store.events_since(0, types=["write"])] == ["write", "write"]
    assert [e["type"] for e in store.events_since(0, trace_id="tr")] == ["recall"]
    assert len(store.events_since(0, limit=2)) == 2


def test_persona_learned_keeps_history_and_latest(store: SqliteStore) -> None:
    assert store.latest_persona_learned() is None

    first = store.append_persona_learned({"reply_length": "short"})
    second = store.append_persona_learned({"reply_length": "long", "nickname": "丘丘"})

    assert first["version"] == 1
    assert second["version"] == 2

    latest = store.latest_persona_learned()
    assert latest is not None
    assert latest["version"] == 2
    assert latest["learned_json"] == {"reply_length": "long", "nickname": "丘丘"}

    # 老版本没被覆盖
    old = store.get_persona_learned(1)
    assert old is not None and old["learned_json"] == {"reply_length": "short"}
    assert [r["version"] for r in store.list_persona_learned()] == [2, 1]


def test_settings_roundtrip(store: SqliteStore) -> None:
    store.set_setting("preset", "quiet")
    store.set_setting("preset", "spicy")
    store.set_setting("threshold.recall", "0.6")

    assert store.get_setting("preset") == "spicy"
    assert store.get_setting("missing") is None
    assert store.get_setting("missing", "fallback") == "fallback"
    assert store.all_settings() == {"preset": "spicy", "threshold.recall": "0.6"}
    assert store.delete_setting("preset") is True
    assert store.get_setting("preset") is None


def test_providers_roundtrip(store: SqliteStore) -> None:
    store.upsert_provider(
        "deepseek", "DeepSeek", base_url="https://api.deepseek.com/v1", models=["chat", "vision"]
    )
    store.upsert_provider("mock", "Mock", enabled=False)

    row = store.get_provider("deepseek")
    assert row is not None
    assert row["models_json"] == ["chat", "vision"]
    assert row["enabled"] is True
    assert row["api_key"] is None
    assert [p["id"] for p in store.list_providers(enabled=True)] == ["deepseek"]
    assert [p["id"] for p in store.list_providers()] == ["deepseek", "mock"]


def test_run_metrics_roundtrip(store: SqliteStore) -> None:
    store.record_metric("tr1", "chat", "deepseek", tokens_in=120, tokens_out=80, latency_ms=430)
    store.record_metric("tr1", "embed", "mock", tokens_in=30, latency_ms=12)
    store.record_metric("tr2", "chat", "mock", latency_ms=900)

    rows = store.list_metrics(trace_id="tr1")
    assert [r["stage"] for r in rows] == ["chat", "embed"]
    assert rows[0]["provider"] == "deepseek"
    assert rows[0]["tokens_out"] == 80
    assert rows[1]["tokens_out"] is None
    assert len(store.list_metrics()) == 3
    assert len(store.list_metrics(provider="mock")) == 2


def test_run_metrics_provider_is_required(store: SqliteStore) -> None:
    # 契约 v0.1.3：provider 非空
    columns = {
        row[1]: row for row in store.conn.execute("PRAGMA table_info(run_metrics)").fetchall()
    }
    assert list(columns) == [
        "trace_id",
        "stage",
        "provider",
        "tokens_in",
        "tokens_out",
        "latency_ms",
        "ts",
    ]
    assert columns["provider"][3] == 1  # notnull
