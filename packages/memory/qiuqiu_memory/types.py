"""记忆层的数据类。字段名与 CONTRACTS § 1 / § 3 / § 7 逐字对应。

这里只放「跨模块看得见」的形状。内部中间结构（压缩结果、检索候选）放在各自的
pipeline 模块里，不外泄。

时间约定（ARCHITECTURE § 7）：对外的字符串时间一律 ISO-8601 UTC，带 ``Z``；
进出接口的 ``datetime`` 允许 naive（按 UTC 解释）也允许带时区。
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

__all__ = [
    "AMBIENT_SOURCES",
    "Budget",
    "FactId",
    "FilterDecision",
    "Hit",
    "INGESTABLE_SOURCES",
    "IngestResult",
    "Learned",
    "MemoryEvent",
    "MergeOp",
    "PATHS",
    "Rejection",
    "RetrievalPlan",
    "RecallResult",
    "Sliders",
    "Source",
    "VisibleMemory",
    "iso",
    "to_utc",
    "utcnow",
]

FactId = str

PATHS: tuple[str, ...] = ("semantic", "lexical", "symbolic")
"""检索三路，取值域见 CONTRACTS § 1 的 ``recall.plan.paths``。"""


class Source(Enum):
    """``ingest()`` 的来源。取值就是 LanceDB ``facts.source`` 列的取值（CONTRACTS § 5）。"""

    DIALOGUE = "dialogue"  # 用户或 AI 说的，跳过筛选
    JOURNAL = "journal"  # 日记随笔，跳过筛选，另出摘要
    AMBIENT_AUDIO = "ambient_audio"
    AMBIENT_IMAGE = "ambient_image"
    PERSONA = "persona"  # 性格沉淀写冷存储的性格档案；中间件内部用，调用方不传（v0.1.7）


AMBIENT_SOURCES: frozenset[Source] = frozenset({Source.AMBIENT_AUDIO, Source.AMBIENT_IMAGE})
"""必须先过筛选的两种来源（AD-3）。"""

INGESTABLE_SOURCES: frozenset[Source] = frozenset(Source) - {Source.PERSONA}
"""`ingest()` 认的来源。

`PERSONA` 不在里面：契约 v0.1.7 写明它「中间件内部用，调用方不传」，只由性格沉淀
（`pipeline/consolidate.py`）往冷表写性格档案时贴在 `facts.source` 上。走 `ingest()`
进来的性格档案会被压缩成原子事实、进合成、进记忆库，那是三条不该发生的事，所以这一层
直接拒。
"""


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def to_utc(value: dt.datetime) -> dt.datetime:
    """naive 当 UTC 解释，带时区的折算到 UTC。返回带时区的 datetime。"""
    if value.tzinfo is None:
        return value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC)


def iso(value: dt.datetime | None = None, *, millis: bool = True) -> str:
    """ISO-8601 UTC 字符串，形如 ``2026-09-04T22:31:00.000Z``（CONTRACTS § 1 的样例）。"""
    moment = to_utc(value or utcnow())
    text = moment.isoformat(timespec="milliseconds" if millis else "seconds")
    return text.replace("+00:00", "Z")


# ---------- 事件（CONTRACTS § 1） ----------


@dataclass(slots=True)
class MemoryEvent:
    """事件信封。``id`` 由事件总线写完 ``event_log`` 之后回填。"""

    type: str  # filter | write | merge | recall
    payload: dict[str, Any]
    trace_id: str
    id: str = ""
    ts: str = field(default_factory=iso)

    def to_dict(self) -> dict[str, Any]:
        # 键序按契约里的信封写法：id, ts, trace_id, type, payload
        return {
            "id": self.id,
            "ts": self.ts,
            "trace_id": self.trace_id,
            "type": self.type,
            "payload": self.payload,
        }


# ---------- 筛选 ----------


@dataclass(slots=True)
class FilterDecision:
    """筛选器的统一输出。``score`` 越高越该留，判定规则见 ``pipeline/filter.py``。"""

    decision: str  # accept | reject | uncertain
    score: float  # 0–1
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {"decision": self.decision, "score": self.score, "reason": self.reason}


# ---------- ingest（CONTRACTS § 3） ----------


@dataclass(slots=True)
class Rejection:
    """被筛掉的一段输入。字段与 ``filter`` 事件里同名字段一致。"""

    reason: str
    score: float
    preview: str

    def to_dict(self) -> dict[str, Any]:
        return {"reason": self.reason, "score": self.score, "preview": self.preview}


@dataclass(slots=True)
class MergeOp:
    """一次同义合并。与 ``merge`` 事件同形（契约 v0.1.5：吸收与作废都带 text）。"""

    result_id: FactId
    result_text: str
    absorbed: list[dict[str, str]] = field(default_factory=list)  # [{id, text}]
    invalidated: list[dict[str, str]] = field(default_factory=list)  # [{id, text, valid_to}]

    def to_dict(self) -> dict[str, Any]:
        return {
            "result_id": self.result_id,
            "result_text": self.result_text,
            "absorbed": self.absorbed,
            "invalidated": self.invalidated,
        }


@dataclass(slots=True)
class IngestResult:
    """`ingest()` 的返回。六个字段逐字按 CONTRACTS § 3。

    后两个是**契约 v0.1.7 收编的**（§ 8 第 2 条），此前是本包报上去的缺口：

    - ``decision``：`POST /ingest` 的响应体 `{trace_id, decision}` 直接透传这一项。
      主动输入恒为 `"accept"`，被动采集是筛选的判定。
    - ``summary``：仅 `JOURNAL`，日记界面显示这段摘要。
    """

    trace_id: str
    accepted: list[FactId] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    merged: list[MergeOp] = field(default_factory=list)
    decision: str = "accept"
    summary: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "accepted": list(self.accepted),
            "rejected": [r.to_dict() for r in self.rejected],
            "merged": [m.to_dict() for m in self.merged],
            "decision": self.decision,
            "summary": self.summary,
        }


# ---------- recall（CONTRACTS § 3） ----------


@dataclass(slots=True)
class Budget:
    max_items: int = 12
    max_tokens: int = 2048
    paths: set[str] | None = None  # None = 交给规划器


@dataclass(slots=True)
class RetrievalPlan:
    """检索规划器的输出。字段与 ``recall`` 事件的 ``plan`` 逐字一致。"""

    paths: list[str]
    depth: int
    rewritten: str

    def to_dict(self) -> dict[str, Any]:
        return {"paths": list(self.paths), "depth": self.depth, "rewritten": self.rewritten}


@dataclass(slots=True)
class Hit:
    id: FactId
    text: str
    path: str  # semantic | lexical | symbolic
    score: float
    valid_from: str
    #: 这条事实是从谁说的话里抽出来的：`user` / `assistant` / 采集来源。
    #:
    #: **调用方必须分开摆。** AD-6 让 AI 的回复也进记忆（不然它答应过的事没法召回），
    #: 代价是它自己的猜测也一起进去了：丘丘随口问一句「早上还想喝美式咖啡吧？」，
    #: 抽出来就是一条「丘丘询问赵宁是否喝到了美式咖啡」。下一轮召回把它和用户
    #: 真说过的话混在同一个「你记得的事」列表里，模型读不出区别，就当成事实接着编，
    #: 编出来的又被 ingest 一遍——一个会自我强化的幻觉环。
    speaker: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "path": self.path,
            "score": self.score,
            "valid_from": self.valid_from,
            "speaker": self.speaker,
        }

    def to_event_hit(self) -> dict[str, Any]:
        """``recall`` 事件里的 hit 形状（契约 v0.1.5 加了 ``text``，没有 ``valid_from``）。"""
        return {"id": self.id, "text": self.text, "path": self.path, "score": self.score}


@dataclass(slots=True)
class RecallResult:
    items: list[Hit] = field(default_factory=list)
    paths_used: list[str] = field(default_factory=list)
    plan: RetrievalPlan | None = None
    cold_promoted: list[FactId] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "items": [h.to_dict() for h in self.items],
            "paths_used": list(self.paths_used),
            "plan": self.plan.to_dict() if self.plan else None,
            "cold_promoted": list(self.cold_promoted),
        }


# ---------- 可见记忆（CONTRACTS § 1） ----------


@dataclass(slots=True)
class VisibleMemory:
    id: str
    layer: str  # L0 | L1 | L2
    content: str
    source: str  # auto | manual
    enabled: bool
    fact_ids: list[str] = field(default_factory=list)
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "layer": self.layer,
            "content": self.content,
            "source": self.source,
            "enabled": self.enabled,
            "fact_ids": list(self.fact_ids),
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> VisibleMemory:
        return cls(
            id=row["id"],
            layer=row["layer"],
            content=row["content"],
            source=row.get("source") or "auto",
            enabled=bool(row.get("enabled", True)),
            fact_ids=list(row.get("fact_ids_json") or []),
            updated_at=row.get("updated_at") or "",
        )


# ---------- 人格（CONTRACTS § 1 的 Sliders / Learned，§ 7 的合成规则） ----------


@dataclass(slots=True)
class Sliders:
    """四个滑块，0–100。名字与 CONTRACTS § 1 的 ``Sliders`` 逐字一致。"""

    initiative: int = 50
    verbosity: int = 50
    emotion: int = 50
    humor: int = 50

    def to_dict(self) -> dict[str, int]:
        return {
            "initiative": self.initiative,
            "verbosity": self.verbosity,
            "emotion": self.emotion,
            "humor": self.humor,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> Sliders:
        raw = raw or {}
        return cls(
            initiative=_clamp_slider(raw.get("initiative", 50)),
            verbosity=_clamp_slider(raw.get("verbosity", 50)),
            emotion=_clamp_slider(raw.get("emotion", 50)),
            humor=_clamp_slider(raw.get("humor", 50)),
        )


def _clamp_slider(value: Any) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return 50
    return max(0, min(100, number))


@dataclass(slots=True)
class Learned:
    """相处沉淀出来的性格。四个键全是可选，缺的沿用上一版（CONTRACTS § 1）。"""

    nickname: str | None = None
    humor_tolerance: int | None = None
    topics: list[str] | None = None
    reply_length: str | None = None  # short | medium | long

    def to_dict(self) -> dict[str, Any]:
        """只输出非 None 的键——「缺失」和「显式为空」在增量合并里是两回事。"""
        out: dict[str, Any] = {}
        if self.nickname is not None:
            out["nickname"] = self.nickname
        if self.humor_tolerance is not None:
            out["humor_tolerance"] = self.humor_tolerance
        if self.topics is not None:
            out["topics"] = list(self.topics)
        if self.reply_length is not None:
            out["reply_length"] = self.reply_length
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> Learned:
        raw = raw or {}
        topics = raw.get("topics")
        humor = raw.get("humor_tolerance")
        reply_length = raw.get("reply_length")
        return cls(
            nickname=str(raw["nickname"]) if raw.get("nickname") else None,
            humor_tolerance=_clamp_slider(humor) if humor is not None else None,
            topics=[str(t) for t in topics] if isinstance(topics, list) and topics else None,
            reply_length=str(reply_length) if reply_length in {"short", "medium", "long"} else None,
        )

    def merge(self, newer: Learned) -> Learned:
        """增量合并：新值覆盖，缺失沿用（``run_consolidation`` 用）。"""
        merged = dict(self.to_dict())
        merged.update(newer.to_dict())
        return Learned.from_dict(merged)
