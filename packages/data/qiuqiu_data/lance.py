"""LanceDB 事实表：`facts_hot` 与 `facts_cold`，schema 严格按 CONTRACTS § 5。

三层索引（AD-10 的执行面）：

- 向量：条数不足 `VECTOR_INDEX_MIN_ROWS` 时**不建**索引，LanceDB 全扫；过万后建
  `IVF_HNSW_SQ`。`query_vector` 对外行为不随索引有无变化。
- 全文：`tokens` 上的 FTS 倒排。`tokens` 是 memory 切好的字面路 token，所以关掉
  词干还原与停用词，只做小写与 ascii 折叠，保证字面匹配不被英语规则改写。
- 标量：`entities`（LabelList，列表列）、`speaker`、`valid_from`（BTree）。

冷表按任务书只建向量索引，标量字段照样能过滤（LanceDB 无索引时走全扫）。

本层不做任何语义判断：什么该写、什么该降冷由 memory 决定，这里只执行。
唯一的删行操作是冷热搬运（AD-9），作废走 `mark_superseded`，只写 `valid_to`
与 `superseded_by`，不删行。
"""

from __future__ import annotations

import datetime as dt
import os
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

import lancedb
import pyarrow as pa
from lancedb.index import FTS, BTree, IvfHnswSq, LabelList

from .config import paths

VECTOR_DIM = 1024
"""与 ARCHITECTURE § 4 的 Embedding 选型一致：Qwen3-Embedding-0.6B，1024 维。"""

HOT_TABLE = "facts_hot"
COLD_TABLE = "facts_cold"

Tier = Literal["hot", "cold"]
TIERS: tuple[Tier, Tier] = ("hot", "cold")

VECTOR_INDEX_MIN_ROWS = 10_000
"""条数不足一万不建向量索引，全扫更快也更准；过万后建 HNSW。"""

VECTOR_METRIC = "cosine"

FACT_FIELDS: tuple[str, ...] = (
    "id",
    "text",
    "vector",
    "tokens",
    "entities",
    "speaker",
    "source",
    "valid_from",
    "valid_to",
    "superseded_by",
    "last_hit_at",
    "blob_id",
)

SCHEMA = pa.schema(
    [
        pa.field("id", pa.string(), nullable=False),
        pa.field("text", pa.string()),
        pa.field("vector", pa.list_(pa.float32(), VECTOR_DIM)),
        pa.field("tokens", pa.list_(pa.string())),
        pa.field("entities", pa.list_(pa.string())),
        pa.field("speaker", pa.string()),
        pa.field("source", pa.string()),
        pa.field("valid_from", pa.timestamp("us")),
        pa.field("valid_to", pa.timestamp("us")),
        pa.field("superseded_by", pa.string()),
        pa.field("last_hit_at", pa.timestamp("us")),
        pa.field("blob_id", pa.string()),
    ]
)

_TABLE_NAMES: dict[str, str] = {"hot": HOT_TABLE, "cold": COLD_TABLE}

_HOT_SCALAR_INDEXES: tuple[tuple[str, str], ...] = (
    ("entities", "LabelList"),
    ("speaker", "BTree"),
    ("valid_from", "BTree"),
)


def utcnow() -> dt.datetime:
    """统一的当前时间：naive UTC，与表里的 `timestamp[us]` 对齐。"""
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


def _to_naive_utc(value: dt.datetime | None) -> dt.datetime | None:
    """带时区的时间统一折成 naive UTC，避免同一列出现两种语义。"""
    if value is None:
        return None
    if not isinstance(value, dt.datetime):
        raise TypeError(f"需要 datetime，收到 {type(value).__name__}")
    if value.tzinfo is not None:
        return value.astimezone(dt.UTC).replace(tzinfo=None)
    return value


def _sql_str(value: str) -> str:
    """SQL 字符串字面量，单引号转义。"""
    return "'" + value.replace("'", "''") + "'"


def _sql_ts(value: dt.datetime) -> str:
    """SQL 时间字面量。"""
    naive = _to_naive_utc(value)
    assert naive is not None
    return f"timestamp '{naive.isoformat(sep=' ', timespec='microseconds')}'"


def _and(clauses: Sequence[str | None]) -> str | None:
    kept = [c for c in clauses if c]
    if not kept:
        return None
    return " AND ".join(f"({c})" for c in kept)


class LanceStore:
    """两张事实表的读写封装。一个实例对应一个 `DATA_DIR`。"""

    def __init__(self, data_dir: str | os.PathLike[str] | None = None) -> None:
        self.paths = paths(data_dir)
        self.uri: Path = self.paths.lance
        self._db: lancedb.DBConnection | None = None

    # ---------- 连接与建表 ----------

    @property
    def db(self) -> lancedb.DBConnection:
        if self._db is None:
            self._db = lancedb.connect(str(self.uri))
        return self._db

    @staticmethod
    def table_name(tier: Tier) -> str:
        try:
            return _TABLE_NAMES[tier]
        except KeyError:
            raise ValueError(f"未知的层：{tier!r}，只能是 'hot' 或 'cold'") from None

    def table_names(self) -> set[str]:
        """当前库里有哪些表。"""
        return set(self.db.list_tables().tables)

    def table(self, tier: Tier) -> lancedb.table.Table:
        """打开表，不存在就按 schema 建（幂等）。"""
        name = self.table_name(tier)
        return self.db.create_table(name, schema=SCHEMA, exist_ok=True)

    def init(self) -> None:
        """建两张表并把当前条数允许建的索引都建上。重复调用无副作用。"""
        for tier in TIERS:
            self.table(tier)
            self.ensure_indexes(tier)

    # ---------- 索引 ----------

    def list_indexes(self, tier: Tier) -> dict[str, str]:
        """返回 `{索引名: 索引类型}`，测试与诊断用。"""
        return {idx.name: idx.index_type for idx in self.table(tier).list_indices()}

    def ensure_indexes(self, tier: Tier) -> dict[str, str]:
        """按层把该建的索引补齐，已存在的不重建。

        热表：全文 + 三个标量常建；向量索引等条数过万再建。
        冷表：只建向量索引，同样等条数过万。
        """
        table = self.table(tier)
        existing = {idx.name for idx in table.list_indices()}

        if tier == "hot":
            if "tokens_idx" not in existing:
                table.create_index(
                    "tokens",
                    config=FTS(base_tokenizer="simple", stem=False, remove_stop_words=False),
                    name="tokens_idx",
                    replace=True,
                )
            for column, kind in _HOT_SCALAR_INDEXES:
                name = f"{column}_idx"
                if name in existing:
                    continue
                config = LabelList() if kind == "LabelList" else BTree()
                table.create_index(column, config=config, name=name, replace=True)

        if "vector_idx" not in existing and table.count_rows() >= VECTOR_INDEX_MIN_ROWS:
            table.create_index(
                "vector",
                config=IvfHnswSq(distance_type=VECTOR_METRIC),
                name="vector_idx",
                replace=True,
            )

        return self.list_indexes(tier)

    def optimize(self, tier: Tier) -> None:
        """把新写入的行并进已有索引。定时任务调，不放在写路径上。"""
        self.table(tier).optimize()

    # ---------- 写 ----------

    def _normalize(self, record: Mapping[str, Any]) -> dict[str, Any]:
        unknown = set(record) - set(FACT_FIELDS)
        if unknown:
            raise ValueError(f"facts 表没有这些字段：{sorted(unknown)}")
        fact_id = record.get("id")
        if not isinstance(fact_id, str) or not fact_id:
            raise ValueError("id 必填且必须是非空字符串")
        vector = record.get("vector")
        if vector is None:
            raise ValueError(f"{fact_id}: vector 必填")
        vector = [float(x) for x in vector]
        if len(vector) != VECTOR_DIM:
            raise ValueError(f"{fact_id}: vector 维度应为 {VECTOR_DIM}，收到 {len(vector)}")
        now = utcnow()
        return {
            "id": fact_id,
            "text": record.get("text"),
            "vector": vector,
            "tokens": list(record.get("tokens") or []),
            "entities": list(record.get("entities") or []),
            "speaker": record.get("speaker"),
            "source": record.get("source"),
            "valid_from": _to_naive_utc(record.get("valid_from")) or now,
            "valid_to": _to_naive_utc(record.get("valid_to")),
            "superseded_by": record.get("superseded_by"),
            "last_hit_at": _to_naive_utc(record.get("last_hit_at")) or now,
            "blob_id": record.get("blob_id"),
        }

    def upsert(self, records: Iterable[Mapping[str, Any]], tier: Tier = "hot") -> int:
        """按 `id` 合并写入。同一条重复写结果一致（幂等）。返回写入条数。"""
        rows = [self._normalize(r) for r in records]
        if not rows:
            return 0
        # 同一批里 id 重复的话保留最后一条，否则 merge_insert 会报多重匹配
        deduped: dict[str, dict[str, Any]] = {}
        for row in rows:
            deduped[row["id"]] = row
        payload = pa.Table.from_pylist(list(deduped.values()), schema=SCHEMA)
        (
            self.table(tier)
            .merge_insert("id")
            .when_matched_update_all()
            .when_not_matched_insert_all()
            .execute(payload)
        )
        return len(deduped)

    def mark_superseded(
        self,
        fact_id: str,
        superseded_by: str | None = None,
        valid_to: dt.datetime | None = None,
        tier: Tier = "hot",
    ) -> bool:
        """作废一条事实：写 `valid_to` 与 `superseded_by`，**不删行**（AD-9）。

        `valid_to` 不传时取当前时间。返回是否命中了行。
        """
        values: dict[str, Any] = {"valid_to": _to_naive_utc(valid_to) or utcnow()}
        if superseded_by is not None:
            values["superseded_by"] = superseded_by
        result = self.table(tier).update(where=f"id = {_sql_str(fact_id)}", values=values)
        return bool(getattr(result, "rows_updated", 0))

    def touch(
        self, fact_ids: Sequence[str], at: dt.datetime | None = None, tier: Tier = "hot"
    ) -> int:
        """更新 `last_hit_at`，冷热调度的依据。返回更新条数。"""
        if not fact_ids:
            return 0
        where = f"id IN ({', '.join(_sql_str(i) for i in fact_ids)})"
        result = self.table(tier).update(
            where=where, values={"last_hit_at": _to_naive_utc(at) or utcnow()}
        )
        return int(getattr(result, "rows_updated", 0))

    def delete_rows(self, fact_ids: Sequence[str], tier: Tier) -> int:
        """物理删行。**只给冷热搬运用**——那是 AD-9 允许的唯一删行场景。"""
        if not fact_ids:
            return 0
        where = f"id IN ({', '.join(_sql_str(i) for i in fact_ids)})"
        self.table(tier).delete(where)
        return len(fact_ids)

    # ---------- 读 ----------

    def count(self, tier: Tier, where: str | None = None) -> int:
        return self.table(tier).count_rows(filter=where)

    def get(self, fact_id: str, tier: Tier | None = None) -> dict[str, Any] | None:
        """取一条。`tier` 不传时先热后冷。"""
        for candidate in (tier,) if tier else TIERS:
            rows = (
                self.table(candidate).search().where(f"id = {_sql_str(fact_id)}").limit(1).to_list()
            )
            if rows:
                return rows[0]
        return None

    def get_many(self, fact_ids: Sequence[str], tier: Tier) -> list[dict[str, Any]]:
        """按 id 批量取，顺序按传入的 `fact_ids`，取不到的跳过。"""
        if not fact_ids:
            return []
        where = f"id IN ({', '.join(_sql_str(i) for i in fact_ids)})"
        rows = self.table(tier).search().where(where).limit(len(fact_ids)).to_list()
        by_id = {row["id"]: row for row in rows}
        return [by_id[i] for i in fact_ids if i in by_id]

    def query_vector(
        self,
        vector: Sequence[float],
        k: int = 10,
        tier: Tier = "hot",
        *,
        where: str | None = None,
        only_valid: bool = False,
    ) -> list[dict[str, Any]]:
        """语义路。返回的每条带 `_distance`。

        有没有向量索引对调用方不可见：没索引时 LanceDB 全扫，语义与返回结构一样。
        """
        if len(vector) != VECTOR_DIM:
            raise ValueError(f"vector 维度应为 {VECTOR_DIM}，收到 {len(vector)}")
        query = self.table(tier).search(list(vector), vector_column_name="vector")
        clause = _and([where, "valid_to IS NULL" if only_valid else None])
        if clause:
            query = query.where(clause)
        return query.limit(k).to_list()

    def query_fts(
        self,
        query: str,
        k: int = 10,
        tier: Tier = "hot",
        *,
        where: str | None = None,
        only_valid: bool = False,
    ) -> list[dict[str, Any]]:
        """字面路：`tokens` 上的全文检索。返回的每条带 `_score`。"""
        builder = self.table(tier).search(query, query_type="fts", fts_columns="tokens")
        clause = _and([where, "valid_to IS NULL" if only_valid else None])
        if clause:
            builder = builder.where(clause)
        return builder.limit(k).to_list()

    def query_scalar(
        self,
        tier: Tier = "hot",
        *,
        entities: Sequence[str] | None = None,
        speaker: str | None = None,
        source: str | None = None,
        valid_from_after: dt.datetime | None = None,
        valid_from_before: dt.datetime | None = None,
        last_hit_before: dt.datetime | None = None,
        only_valid: bool = False,
        where: str | None = None,
        limit: int | None = 100,
    ) -> list[dict[str, Any]]:
        """标签路：按标量字段过滤。`limit=None` 取全部（调用方自己掂量数据量）。"""
        clauses: list[str | None] = [where]
        if entities:
            listed = ", ".join(_sql_str(e) for e in entities)
            clauses.append(f"array_has_any(entities, [{listed}])")
        if speaker is not None:
            clauses.append(f"speaker = {_sql_str(speaker)}")
        if source is not None:
            clauses.append(f"source = {_sql_str(source)}")
        if valid_from_after is not None:
            clauses.append(f"valid_from >= {_sql_ts(valid_from_after)}")
        if valid_from_before is not None:
            clauses.append(f"valid_from < {_sql_ts(valid_from_before)}")
        if last_hit_before is not None:
            clauses.append(f"last_hit_at < {_sql_ts(last_hit_before)}")
        if only_valid:
            clauses.append("valid_to IS NULL")

        builder = self.table(tier).search()
        clause = _and(clauses)
        if clause:
            builder = builder.where(clause)
        return builder.limit(limit).to_list()
