"""合成：同义的事实合并成一条，旧的作废。

**不物理删除**（AD-9）。作废写两列：`valid_to` = 作废时间，`superseded_by` = 取代它的
那条事实 id。历史因此可追溯——三个月后想知道「用户以前住哪」，翻得出来。

判定同义分两步，**召回宽、判定严**：

1. **召回候选**：向量取最近的 `CANDIDATE_DEPTH` 条仍然有效的旧事实。这里**不设
   相似度下限**——「想喝咖啡」和「喜欢燕麦奶」词面几乎不重合，设了门槛它们就永远
   见不到模型，可「都是喝的偏好」这件事只有模型看得出来。
2. **判定**：把新事实与候选一起交给 Chat，问它哪几条被这条取代、合并后写成什么。
   矛盾更新（「住北京」→「搬到深圳」）也在这一步认出来。
   Chat 不可用或答得不成形状时退回确定性判据：token Jaccard ≥ `merge_jaccard`
   或余弦 ≥ `merge_cosine` 才算同义。代价是跨词面的合并会漏——漏合并只是多存一条，
   错合并会把两件事搅成一件，宁可漏。

每次合并发一条 `merge` 事件（契约 v0.1.5：`absorbed` 与 `invalidated` 都带 `text`，
侧栏要显示「哪条被划掉了」而不只是一串 id）。
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

import structlog

from ..llm import ChatUnavailable, complete_json
from ..text import jaccard, tokenize
from ..types import MergeOp, iso, to_utc
from .compress import Fact

__all__ = ["CANDIDATE_DEPTH", "synthesize"]

log = structlog.get_logger("qiuqiu_memory.synthesize")

CANDIDATE_DEPTH = 8
"""每条新事实向量召回多少条旧事实进候选池。"""


@dataclass(slots=True)
class Candidate:
    """一条候选旧事实，连同两个确定性相似度——Chat 不可用时靠它们判定。"""

    id: str
    text: str
    cosine: float
    overlap: float


_SYSTEM = (
    "你是记忆合成器。判断一条新事实是否取代了若干条旧事实，只输出 JSON，不要解释。"
    "取代的情形有两种：说的是同一件事（同义），或者新的推翻了旧的（更新、搬家、改变主意）。"
)

_USER_TEMPLATE = """新事实：{new_text}

候选旧事实：
{candidates}

判断哪些旧事实被新事实取代了。只输出这个 JSON：
{{"absorbed": ["旧事实的 id"], "result_text": "合并后的一句话，通常就是新事实本身"}}
没有任何一条被取代时，absorbed 给空数组。
"""


async def synthesize(
    runtime: Any,
    facts: list[Fact],
    *,
    trace_id: str,
    now: dt.datetime,
) -> list[MergeOp]:
    """把新写入的事实与热表里已有的同义事实合并。返回发生的合并操作。"""
    moment = to_utc(now)
    new_ids = {f.id for f in facts}
    merged: list[MergeOp] = []
    invalidated: set[str] = set()

    for fact in facts:
        candidates = _candidates(runtime, fact, skip=new_ids | invalidated)
        if not candidates:
            continue
        absorbed_ids, result_text = await _pick(runtime, fact, candidates)
        absorbed_ids = [i for i in absorbed_ids if i in candidates]
        if not absorbed_ids:
            continue

        if result_text and result_text != fact.text:
            _rewrite(runtime, fact, result_text)

        stamp = iso(moment)
        for old_id in absorbed_ids:
            runtime.lance.mark_superseded(
                old_id, superseded_by=fact.id, valid_to=moment, tier="hot"
            )
            invalidated.add(old_id)

        operation = MergeOp(
            result_id=fact.id,
            result_text=fact.text,
            absorbed=[{"id": i, "text": candidates[i].text} for i in absorbed_ids],
            invalidated=[
                {"id": i, "text": candidates[i].text, "valid_to": stamp} for i in absorbed_ids
            ],
        )
        merged.append(operation)
        runtime.bus.emit("merge", operation.to_dict(), trace_id=trace_id)
        log.info("synthesize.merge", trace_id=trace_id, result=fact.id, absorbed=absorbed_ids)

    return merged


def _candidates(runtime: Any, fact: Fact, *, skip: set[str]) -> dict[str, Candidate]:
    """向量召回一批仍然有效的旧事实。**不设相似度下限**，判定交给 `_pick`。"""
    rows = runtime.lance.query_vector(
        fact.vector, k=CANDIDATE_DEPTH + len(skip), tier="hot", only_valid=True
    )
    picked: dict[str, Candidate] = {}
    for row in rows:
        row_id = row.get("id")
        if not row_id or row_id in skip:
            continue
        picked[row_id] = Candidate(
            id=row_id,
            text=row.get("text") or "",
            cosine=round(1.0 - float(row.get("_distance", 1.0)), 4),
            overlap=round(jaccard(fact.tokens, row.get("tokens") or []), 4),
        )
        if len(picked) >= CANDIDATE_DEPTH:
            break
    return picked


async def _pick(
    runtime: Any, fact: Fact, candidates: dict[str, Candidate]
) -> tuple[list[str], str]:
    """问 Chat 哪几条被取代。模型不可用或答得不对形状时，退回确定性判据。"""
    listing = "\n".join(f"- {c.id}: {c.text}" for c in candidates.values())
    try:
        parsed = await complete_json(
            runtime,
            system=_SYSTEM,
            user=_USER_TEMPLATE.format(new_text=fact.text, candidates=listing),
            stage="synthesize",
        )
    except ChatUnavailable:
        log.warning("synthesize.chat_unavailable", fact=fact.id)
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("absorbed"), list):
        result_text = parsed.get("result_text")
        return (
            [str(i) for i in parsed["absorbed"]],
            str(result_text) if isinstance(result_text, str) and result_text.strip() else "",
        )
    return _deterministic(runtime, candidates), ""


def _deterministic(runtime: Any, candidates: dict[str, Candidate]) -> list[str]:
    """确定性兜底：词面或向量高度重合才算同义。严，宁可漏。"""
    jaccard_gate = runtime.thresholds.get("merge_jaccard")
    cosine_gate = runtime.thresholds.get("merge_cosine")
    return [
        c.id for c in candidates.values() if c.overlap >= jaccard_gate or c.cosine >= cosine_gate
    ]


def _rewrite(runtime: Any, fact: Fact, text: str) -> None:
    """合并后的文本变了：重算向量与 token，覆盖写回热表。"""
    fact.text = text
    fact.tokens = tokenize(text)
    fact.vector = runtime.embedder.embed_one(text)
    runtime.lance.upsert([fact.to_row()], "hot")
