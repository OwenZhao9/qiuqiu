"""SQLite：CONTRACTS § 5 的八张表，WAL 模式，迁移幂等可重复。

数据归属见 ARCHITECTURE § 7：`sessions` `messages` `settings` `providers`
`run_metrics` 由 backend 直接读写；`visible_memory` `event_log` `persona_learned`
由 memory 写、backend 经门面或 `since` 游标读。本层只管读写正确，不判断语义。

约定：
- 时间列一律 ISO-8601 UTC 字符串，写入时不传就取当前时间。
- `*_json` 列在接口层收发 Python 对象（dict / list），序列化与反序列化在本模块内做，
  返回的行字典里键名仍是契约里的列名，值已经是 Python 对象。
- 布尔列（`archived` `favorite` `enabled`）在库里是 0/1，接口层收发 `bool`。
- 与 LanceDB 不做跨库事务。
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import threading
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from .config import paths

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

TABLES: tuple[str, ...] = (
    "sessions",
    "messages",
    "visible_memory",
    "event_log",
    "persona_learned",
    "settings",
    "providers",
    "run_metrics",
)

_JSON_COLUMNS: frozenset[str] = frozenset(
    {"payload_json", "fact_ids_json", "learned_json", "models_json"}
)
_BOOL_COLUMNS: frozenset[str] = frozenset({"archived", "favorite", "enabled"})


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def to_iso(value: dt.datetime | None = None) -> str:
    """datetime → ISO-8601 UTC 字符串。不传取当前时间。"""
    moment = value or utcnow()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.UTC)
    return moment.astimezone(dt.UTC).isoformat()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in row.keys():
        value = row[key]
        if key in _JSON_COLUMNS and isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                pass
        elif key in _BOOL_COLUMNS and value is not None:
            value = bool(value)
        out[key] = value
    return out


class SqliteStore:
    """一个实例一个库文件。连接懒建，跨线程共享，写操作加锁串行化。"""

    def __init__(
        self,
        data_dir: str | os.PathLike[str] | None = None,
        *,
        path: str | os.PathLike[str] | None = None,
    ) -> None:
        if path is not None:
            self.path = Path(path)
            self.path.parent.mkdir(parents=True, exist_ok=True)
        else:
            self.path = paths(data_dir).sqlite
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.RLock()

    # ---------- 连接 ----------

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            conn = sqlite3.connect(str(self.path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._conn = conn
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> SqliteStore:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def journal_mode(self) -> str:
        return str(self.conn.execute("PRAGMA journal_mode").fetchone()[0])

    def table_names(self) -> set[str]:
        rows = self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        return {r[0] for r in rows}

    # ---------- 迁移 ----------

    def migrate(self) -> list[str]:
        """按文件名顺序跑没跑过的迁移，返回本次新应用的版本号。

        幂等有两层保险：`schema_migrations` 账本，加上迁移脚本本身全是
        `IF NOT EXISTS`——账本丢了重跑也不炸。
        """
        with self._lock:
            conn = self.conn
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "  version TEXT PRIMARY KEY,"
                "  applied_at TEXT NOT NULL"
                ")"
            )
            conn.commit()
            applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
            newly: list[str] = []
            for script in sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9]_*.sql")):
                version = script.stem
                if version in applied:
                    continue
                conn.executescript(script.read_text(encoding="utf-8"))
                conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, to_iso()),
                )
                conn.commit()
                newly.append(version)
            return newly

    def applied_migrations(self) -> list[str]:
        rows = self.conn.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
        return [r[0] for r in rows]

    # ---------- 内部 ----------

    def _execute(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self.conn.execute(sql, tuple(params))
            self.conn.commit()
            return cur

    def _query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        rows = self.conn.execute(sql, tuple(params)).fetchall()
        return [_row_to_dict(r) for r in rows]

    def _query_one(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        row = self.conn.execute(sql, tuple(params)).fetchone()
        return _row_to_dict(row) if row is not None else None

    # ---------- sessions ----------

    def upsert_session(
        self,
        session_id: str,
        title: str | None = None,
        *,
        archived: bool = False,
        created_at: dt.datetime | None = None,
        updated_at: dt.datetime | None = None,
    ) -> dict[str, Any]:
        self._execute(
            "INSERT INTO sessions(id, title, archived, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            "   title = excluded.title,"
            "   archived = excluded.archived,"
            "   updated_at = excluded.updated_at",
            (session_id, title, int(archived), to_iso(created_at), to_iso(updated_at)),
        )
        result = self.get_session(session_id)
        assert result is not None
        return result

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        return self._query_one("SELECT * FROM sessions WHERE id = ?", (session_id,))

    def list_sessions(
        self, *, archived: bool | None = False, limit: int = 100, offset: int = 0
    ) -> list[dict[str, Any]]:
        if archived is None:
            return self._query(
                "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?", (limit, offset)
            )
        return self._query(
            "SELECT * FROM sessions WHERE archived = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            (int(archived), limit, offset),
        )

    def set_session_archived(self, session_id: str, archived: bool) -> bool:
        cur = self._execute(
            "UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?",
            (int(archived), to_iso(), session_id),
        )
        return cur.rowcount > 0

    # ---------- messages ----------

    def add_message(
        self,
        message_id: str,
        session_id: str,
        role: str,
        content: str,
        *,
        model: str | None = None,
        favorite: bool = False,
        created_at: dt.datetime | None = None,
    ) -> dict[str, Any]:
        self._execute(
            "INSERT INTO messages(id, session_id, role, content, model, favorite, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            "   role = excluded.role,"
            "   content = excluded.content,"
            "   model = excluded.model,"
            "   favorite = excluded.favorite",
            (
                message_id,
                session_id,
                role,
                content,
                model,
                int(favorite),
                to_iso(created_at),
            ),
        )
        result = self._query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
        assert result is not None
        return result

    def list_messages(
        self, session_id: str, *, limit: int = 200, offset: int = 0
    ) -> list[dict[str, Any]]:
        return self._query(
            "SELECT * FROM messages WHERE session_id = ?"
            " ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
            (session_id, limit, offset),
        )

    def list_favorite_messages(self, *, limit: int = 200) -> list[dict[str, Any]]:
        return self._query(
            "SELECT * FROM messages WHERE favorite = 1 ORDER BY created_at DESC LIMIT ?", (limit,)
        )

    def set_message_favorite(self, message_id: str, favorite: bool) -> bool:
        cur = self._execute(
            "UPDATE messages SET favorite = ? WHERE id = ?", (int(favorite), message_id)
        )
        return cur.rowcount > 0

    # ---------- visible_memory ----------

    def upsert_visible_memory(
        self,
        memory_id: str,
        layer: str,
        content: str,
        *,
        source: str | None = None,
        enabled: bool = True,
        fact_ids: Sequence[str] | None = None,
        updated_at: dt.datetime | None = None,
    ) -> dict[str, Any]:
        self._execute(
            "INSERT INTO visible_memory"
            "  (id, layer, content, source, enabled, fact_ids_json, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            "   layer = excluded.layer,"
            "   content = excluded.content,"
            "   source = excluded.source,"
            "   enabled = excluded.enabled,"
            "   fact_ids_json = excluded.fact_ids_json,"
            "   updated_at = excluded.updated_at",
            (
                memory_id,
                layer,
                content,
                source,
                int(enabled),
                json.dumps(list(fact_ids or []), ensure_ascii=False),
                to_iso(updated_at),
            ),
        )
        result = self.get_visible_memory(memory_id)
        assert result is not None
        return result

    def get_visible_memory(self, memory_id: str) -> dict[str, Any] | None:
        return self._query_one("SELECT * FROM visible_memory WHERE id = ?", (memory_id,))

    def list_visible_memory(
        self, *, layer: str | None = None, enabled: bool | None = None, limit: int = 500
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if layer is not None:
            clauses.append("layer = ?")
            params.append(layer)
        if enabled is not None:
            clauses.append("enabled = ?")
            params.append(int(enabled))
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(limit)
        return self._query(
            f"SELECT * FROM visible_memory{where} ORDER BY updated_at DESC LIMIT ?", params
        )

    def set_visible_memory_enabled(self, memory_id: str, enabled: bool) -> bool:
        cur = self._execute(
            "UPDATE visible_memory SET enabled = ?, updated_at = ? WHERE id = ?",
            (int(enabled), to_iso(), memory_id),
        )
        return cur.rowcount > 0

    def delete_visible_memory(self, memory_id: str) -> bool:
        cur = self._execute("DELETE FROM visible_memory WHERE id = ?", (memory_id,))
        return cur.rowcount > 0

    # ---------- event_log ----------

    def append_event(
        self,
        type: str,
        payload: Any = None,
        *,
        trace_id: str | None = None,
        ts: dt.datetime | None = None,
    ) -> int:
        """追加一条事件，返回自增 `id`——就是 backend 的游标值。"""
        cur = self._execute(
            "INSERT INTO event_log(ts, trace_id, type, payload_json) VALUES (?, ?, ?, ?)",
            (to_iso(ts), trace_id, type, json.dumps(payload or {}, ensure_ascii=False)),
        )
        return int(cur.lastrowid or 0)

    def events_since(
        self,
        since: int = 0,
        *,
        limit: int = 200,
        types: Iterable[str] | None = None,
        trace_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """游标查询：返回 `id > since` 的事件，按 `id` 升序。`since=0` 取全部。"""
        clauses = ["id > ?"]
        params: list[Any] = [since]
        type_list = list(types) if types is not None else None
        if type_list:
            clauses.append(f"type IN ({', '.join('?' for _ in type_list)})")
            params.extend(type_list)
        if trace_id is not None:
            clauses.append("trace_id = ?")
            params.append(trace_id)
        params.append(limit)
        return self._query(
            f"SELECT * FROM event_log WHERE {' AND '.join(clauses)} ORDER BY id ASC LIMIT ?",
            params,
        )

    def latest_event_id(self) -> int:
        row = self.conn.execute("SELECT COALESCE(MAX(id), 0) FROM event_log").fetchone()
        return int(row[0])

    # ---------- persona_learned ----------

    def append_persona_learned(
        self, learned: Any, *, consolidated_at: dt.datetime | None = None
    ) -> dict[str, Any]:
        """追加一版性格档案，`version` 自动加一。历史版本永不覆盖。"""
        with self._lock:
            row = self.conn.execute(
                "SELECT COALESCE(MAX(version), 0) FROM persona_learned"
            ).fetchone()
            version = int(row[0]) + 1
            self.conn.execute(
                "INSERT INTO persona_learned(version, learned_json, consolidated_at)"
                " VALUES (?, ?, ?)",
                (version, json.dumps(learned, ensure_ascii=False), to_iso(consolidated_at)),
            )
            self.conn.commit()
        result = self.get_persona_learned(version)
        assert result is not None
        return result

    def get_persona_learned(self, version: int) -> dict[str, Any] | None:
        return self._query_one("SELECT * FROM persona_learned WHERE version = ?", (version,))

    def latest_persona_learned(self) -> dict[str, Any] | None:
        """取最新一版；一条都没有时返回 None。"""
        return self._query_one("SELECT * FROM persona_learned ORDER BY version DESC LIMIT 1")

    def list_persona_learned(self, *, limit: int = 50) -> list[dict[str, Any]]:
        return self._query("SELECT * FROM persona_learned ORDER BY version DESC LIMIT ?", (limit,))

    # ---------- settings ----------

    def get_setting(self, key: str, default: str | None = None) -> str | None:
        row = self._query_one("SELECT value FROM settings WHERE key = ?", (key,))
        return default if row is None else row["value"]

    def set_setting(self, key: str, value: str | None) -> None:
        self._execute(
            "INSERT INTO settings(key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def all_settings(self) -> dict[str, str | None]:
        return {r["key"]: r["value"] for r in self._query("SELECT * FROM settings ORDER BY key")}

    def delete_setting(self, key: str) -> bool:
        return self._execute("DELETE FROM settings WHERE key = ?", (key,)).rowcount > 0

    # ---------- providers ----------

    def upsert_provider(
        self,
        provider_id: str,
        name: str,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        models: Sequence[str] | None = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        self._execute(
            "INSERT INTO providers(id, name, base_url, api_key, models_json, enabled)"
            " VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            "   name = excluded.name,"
            "   base_url = excluded.base_url,"
            "   api_key = excluded.api_key,"
            "   models_json = excluded.models_json,"
            "   enabled = excluded.enabled",
            (
                provider_id,
                name,
                base_url,
                api_key,
                json.dumps(list(models or []), ensure_ascii=False),
                int(enabled),
            ),
        )
        result = self.get_provider(provider_id)
        assert result is not None
        return result

    def get_provider(self, provider_id: str) -> dict[str, Any] | None:
        return self._query_one("SELECT * FROM providers WHERE id = ?", (provider_id,))

    def list_providers(self, *, enabled: bool | None = None) -> list[dict[str, Any]]:
        if enabled is None:
            return self._query("SELECT * FROM providers ORDER BY id")
        return self._query("SELECT * FROM providers WHERE enabled = ? ORDER BY id", (int(enabled),))

    def delete_provider(self, provider_id: str) -> bool:
        return self._execute("DELETE FROM providers WHERE id = ?", (provider_id,)).rowcount > 0

    # ---------- run_metrics ----------

    def record_metric(
        self,
        trace_id: str,
        stage: str,
        provider: str,
        *,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
        latency_ms: int | None = None,
        ts: dt.datetime | None = None,
    ) -> None:
        """记一条运行指标。`provider` 如 `mock` / `deepseek` / `edge` / `volc`。"""
        self._execute(
            "INSERT INTO run_metrics"
            "  (trace_id, stage, provider, tokens_in, tokens_out, latency_ms, ts)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (trace_id, stage, provider, tokens_in, tokens_out, latency_ms, to_iso(ts)),
        )

    def list_metrics(
        self,
        *,
        trace_id: str | None = None,
        provider: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if trace_id is not None:
            clauses.append("trace_id = ?")
            params.append(trace_id)
        if provider is not None:
            clauses.append("provider = ?")
            params.append(provider)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        order = "ts ASC" if trace_id is not None else "ts DESC"
        params.append(limit)
        return self._query(f"SELECT * FROM run_metrics{where} ORDER BY {order} LIMIT ?", params)
