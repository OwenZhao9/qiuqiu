"""检索：规划 → 三路并行 → 并集去重 → 按 `Budget` 截断 → 发 `recall` 事件。

**规划器**（SimpleMem 的「意图感知检索」那一段）先看一眼问题，决定三件事：

- `paths`：这次走哪几路。按意思（`semantic`）、按字面（`lexical`）、按标签（`symbolic`）。
- `depth`：每路取多深。
- `rewritten`：改写后的查询。人称归一（「他喜欢喝什么」→「用户喜欢喝什么」）、
  相对时间绝对化（用 `recall(now=...)` 传进来的那个时间，不是系统时钟）。

规划器调 Chat 出 JSON。Chat 答得不成形状或压根不可用时走确定性规划，**不中止检索**——
召回不出来的代价是回复少引用一句旧事，比整条请求失败轻得多。

**先热后冷**（AD-10）。热表先跑；热表没喂饱，或者规划器判断问的是久远的事，才下探冷表。
命中的冷条目整条回热（`data.tiering.promote`），`cold_promoted` 记下来，侧栏据此标
「回热 N 条」，丘丘切 `40` 表情。

**三路并行**：三路都是同步的 LanceDB 调用，各自丢进线程跑 `asyncio.gather`，
省掉串行三次的等待。

**截断**按 `Budget`：先按 `PATH_QUOTA` 给三路分名额，谁没用完让给别人，最后按
`max_tokens` 卡一刀。配额而不是纯按分数排，是因为三路的分数不同源，纯排序会让某一路
（通常是语义路）把名额吃光，「三路都看得见」这件事在侧栏上就没了。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import re
from dataclasses import dataclass
from typing import Any

import structlog

from ..llm import ChatUnavailable, complete_json
from ..text import (
    absolutize_time,
    entities_of,
    estimate_tokens,
    jaccard,
    normalize_query_person,
    tokenize,
)
from ..types import PATHS, Budget, Hit, RecallResult, RetrievalPlan, iso, to_utc
from .tiering import promote

__all__ = ["PATH_QUOTA", "DEFAULT_DEPTH", "plan_retrieval", "retrieve"]

log = structlog.get_logger("qiuqiu_memory.retrieve")

DEFAULT_DEPTH = 8
"""规划器不给深度时每路取多少条。"""

MAX_DEPTH = 32

PATH_QUOTA: dict[str, float] = {"semantic": 0.5, "lexical": 0.3, "symbolic": 0.2}
"""`Budget.max_items` 在三路之间的配额。语义路给一半，字面路三成，标签路两成。

理由：语义路覆盖面最宽、最常命中；字面路负责专名与原话复述；标签路是兜底的召回，
命中少但一命中往往正中要害。名额没用完的会让给还有候选的路，所以配额是下限不是上限。
"""

_LEXICAL_SATURATION = 3.0
"""BM25 分数压到 0–1 用的饱和常数：`s / (s + 3)`，s=3 时正好 0.5。

三路的分数不同源，必须先压到同一个量纲才能放进同一个 `hits[]` 里比较。
"""

_OLD_HINT_RE = re.compile(
    r"(以前|之前|从前|当初|当时|那时|最早|去年|前年|上个月|上一次|三个月前|"
    r"好久|很久|一直|曾经|原来|以往|旧的|过去)"
)
"""确定性规划里判断「问的是久远的事」的词。命中就直接下探冷表。"""


@dataclass(slots=True)
class _Candidate:
    """三路各自的候选。同一条事实可能被多路命中，`_merge` 时保留最高分那一路。"""

    id: str
    text: str
    path: str
    score: float
    valid_from: str
    tier: str
    #: 这条事实是从谁说的话里抽出来的。`assistant` 的那些是丘丘自己说过的，
    #: 不是用户告诉它的——两者在 prompt 里必须分开摆，见 `_memory_block`
    speaker: str


# --------------------------------------------------------------------------- 规划


_SYSTEM = (
    "你是记忆检索规划器。看一句用户提问，决定该怎么去记忆库里找，只输出 JSON，不要解释。"
    "三条检索路径：semantic 按意思找，lexical 按字面找专名和原话，symbolic 按实体标签找。"
)

_USER_TEMPLATE = """用户这次问的是：{query}

当前时间：{now}

请规划检索：
1. paths：从 semantic / lexical / symbolic 里选一到三条。问法笼统、要靠理解的选 semantic；
   带人名地名产品名、要原话的加 lexical；围绕某个具体事物打转的加 symbolic
2. depth：每路取多少条，1 到 {max_depth} 之间。问得越宽、越需要凑上下文就取越大
3. rewritten：把问题改写成便于检索的陈述句。人称换成「用户」，相对时间换成具体日期；
   没什么可改的就原样返回
4. cold：这句问的是不是几个月前的旧事。是就 true，问最近的事就 false

只输出这个 JSON：
{{"paths": ["semantic"], "depth": 8, "rewritten": "...", "cold": false}}
"""


def _deterministic_plan(query: str, now: dt.datetime) -> tuple[RetrievalPlan, bool]:
    """不调模型的规划。也是模型答不成形状时的兜底。

    规则：语义路永远走；查询里有两字以上的 token 就加字面路；抽得出实体就加标签路。
    深度按查询长度在 4–16 之间伸缩。
    """
    rewritten = absolutize_time(normalize_query_person(query or ""), now)
    tokens = [t for t in tokenize(rewritten) if len(t) >= 2]
    paths = ["semantic"]
    if tokens:
        paths.append("lexical")
    if entities_of(rewritten):
        paths.append("symbolic")
    depth = max(4, min(16, DEFAULT_DEPTH + len(tokens) // 2))
    cold = bool(_OLD_HINT_RE.search(query or ""))
    return RetrievalPlan(paths=paths, depth=depth, rewritten=rewritten), cold


async def plan_retrieval(
    runtime: Any, query: str, *, budget: Budget, now: dt.datetime
) -> tuple[RetrievalPlan, bool]:
    """出一份检索计划，外加「要不要下探冷表」。

    先问 Chat；模型不可用或答得不成形状就退到 `_deterministic_plan`。
    `Budget.paths` 不为 `None` 时是硬约束——调用方点了名的路径，规划器不能加戏。
    """
    fallback, fallback_cold = _deterministic_plan(query, now)
    plan, cold = fallback, fallback_cold

    try:
        parsed = await complete_json(
            runtime,
            system=_SYSTEM,
            user=_USER_TEMPLATE.format(query=query, now=iso(now), max_depth=MAX_DEPTH),
            stage="retrieve.plan",
        )
    except ChatUnavailable:
        log.warning("retrieve.plan.chat_unavailable")
        parsed = None

    if isinstance(parsed, dict):
        picked = [p for p in parsed.get("paths") or [] if p in PATHS]
        rewritten = parsed.get("rewritten")
        plan = RetrievalPlan(
            paths=list(dict.fromkeys(picked)) or fallback.paths,
            depth=_clamp_depth(parsed.get("depth"), fallback.depth),
            rewritten=str(rewritten).strip()
            if isinstance(rewritten, str) and rewritten.strip()
            else fallback.rewritten,
        )
        cold = bool(parsed.get("cold")) or fallback_cold

    if budget.paths is not None:
        allowed = [p for p in plan.paths if p in budget.paths]
        plan.paths = allowed or [p for p in PATHS if p in budget.paths]
    return plan, cold


def _clamp_depth(value: Any, default: int) -> int:
    try:
        depth = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(MAX_DEPTH, depth))


# --------------------------------------------------------------------------- 三路


def _semantic(runtime: Any, plan: RetrievalPlan, tier: str) -> list[_Candidate]:
    vector = runtime.embedder.embed_one(plan.rewritten)
    rows = runtime.lance.query_vector(vector, k=plan.depth, tier=tier, only_valid=True)
    out = []
    for row in rows:
        cosine = 1.0 - float(row.get("_distance", 1.0))
        out.append(_candidate(row, "semantic", max(0.0, min(1.0, cosine)), tier))
    return out


def _lexical(runtime: Any, plan: RetrievalPlan, tier: str) -> list[_Candidate]:
    # `tokens` 列的 FTS 用 simple 分词器按空白切，查询串必须用同一套 token 拼，
    # 两边对不上就永远搜不到（见 `text.tokenize` 的模块文档）。
    query = " ".join(tokenize(plan.rewritten))
    if not query:
        return []
    rows = runtime.lance.query_fts(query, k=plan.depth, tier=tier, only_valid=True)
    out = []
    for row in rows:
        raw = float(row.get("_score", 0.0))
        out.append(_candidate(row, "lexical", raw / (raw + _LEXICAL_SATURATION), tier))
    return out


def _symbolic(runtime: Any, plan: RetrievalPlan, tier: str) -> list[_Candidate]:
    wanted = entities_of(plan.rewritten)
    if not wanted:
        return []
    rows = runtime.lance.query_scalar(
        tier, entities=wanted, only_valid=True, limit=max(plan.depth, 1)
    )
    out = []
    for row in rows:
        overlap = jaccard(wanted, row.get("entities") or [])
        out.append(_candidate(row, "symbolic", max(overlap, 1.0 / len(wanted)), tier))
    return out


_RUNNERS = {"semantic": _semantic, "lexical": _lexical, "symbolic": _symbolic}


def _candidate(row: dict[str, Any], path: str, score: float, tier: str) -> _Candidate:
    valid_from = row.get("valid_from")
    return _Candidate(
        id=str(row.get("id")),
        text=row.get("text") or "",
        path=path,
        score=round(float(score), 4),
        valid_from=iso(valid_from) if isinstance(valid_from, dt.datetime) else "",
        tier=tier,
        speaker=str(row.get("speaker") or ""),
    )


async def _run_paths(runtime: Any, plan: RetrievalPlan, tier: str) -> list[_Candidate]:
    """三路并行跑。每路是同步的 LanceDB 调用，各自丢进线程。"""
    tasks = [asyncio.to_thread(_RUNNERS[p], runtime, plan, tier) for p in plan.paths]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out: list[_Candidate] = []
    for path, result in zip(plan.paths, results, strict=True):
        if isinstance(result, BaseException):
            # 一路炸了不该拖垮另外两路：记下来，继续。
            log.warning("retrieve.path_failed", path=path, tier=tier, error=str(result))
            continue
        out.extend(result)
    return out


def _merge(candidates: list[_Candidate]) -> dict[str, _Candidate]:
    """并集去重：同一条被多路命中时，留分最高的那一路。"""
    best: dict[str, _Candidate] = {}
    for candidate in candidates:
        current = best.get(candidate.id)
        if current is None or candidate.score > current.score:
            best[candidate.id] = candidate
    return best


# --------------------------------------------------------------------------- 截断


def _truncate(merged: dict[str, _Candidate], budget: Budget, paths: list[str]) -> list[Hit]:
    """按 `PATH_QUOTA` 给三路分名额，没用完的让出去，最后按 `max_tokens` 卡一刀。"""
    by_path: dict[str, list[_Candidate]] = {p: [] for p in paths}
    for candidate in merged.values():
        by_path.setdefault(candidate.path, []).append(candidate)
    for bucket in by_path.values():
        bucket.sort(key=lambda c: (-c.score, c.id))

    picked: list[_Candidate] = []
    taken: set[str] = set()
    for path, bucket in by_path.items():
        quota = max(1, round(budget.max_items * PATH_QUOTA.get(path, 0.0))) if bucket else 0
        for candidate in bucket[:quota]:
            picked.append(candidate)
            taken.add(candidate.id)

    # 名额有剩就按分数补，直到 max_items
    leftovers = sorted(
        (c for c in merged.values() if c.id not in taken), key=lambda c: (-c.score, c.id)
    )
    picked.extend(leftovers[: max(0, budget.max_items - len(picked))])
    picked.sort(key=lambda c: (-c.score, c.id))
    picked = picked[: budget.max_items]

    hits: list[Hit] = []
    spent = 0
    for candidate in picked:
        cost = estimate_tokens(candidate.text)
        if hits and spent + cost > budget.max_tokens:
            break
        spent += cost
        hits.append(
            Hit(
                id=candidate.id,
                text=candidate.text,
                path=candidate.path,
                score=candidate.score,
                valid_from=candidate.valid_from,
                speaker=candidate.speaker,
            )
        )
    return hits


# --------------------------------------------------------------------------- 入口


def _needs_cold(
    hot: dict[str, _Candidate], plan: RetrievalPlan, budget: Budget, cold: bool
) -> bool:
    """热表没喂饱，或者规划器说这问的是旧事，就下探冷表。"""
    if cold:
        return True
    want = min(budget.max_items, plan.depth)
    return len(hot) < max(1, want // 2)


async def retrieve(
    runtime: Any,
    query: str,
    *,
    budget: Budget,
    now: dt.datetime,
    trace_id: str,
) -> RecallResult:
    """一次完整召回。发一条 `recall` 事件，返回 `RecallResult`。"""
    moment = to_utc(now)
    plan, cold_hint = await plan_retrieval(runtime, query, budget=budget, now=moment)

    hot = _merge(await _run_paths(runtime, plan, "hot"))
    promoted: list[str] = []
    if _needs_cold(hot, plan, budget, cold_hint):
        cold = _merge(await _run_paths(runtime, plan, "cold"))
        cold_ids = [c.id for c in cold.values() if c.id not in hot]
        if cold_ids:
            # 命中冷条目就整条回热并更新 last_hit_at（AD-10），由 data 执行搬运
            promoted = promote(runtime, cold_ids, at=moment)
        for candidate in cold.values():
            if candidate.id not in hot:
                hot[candidate.id] = candidate

    hits = _truncate(hot, budget, plan.paths)
    used = list(dict.fromkeys(h.path for h in hits))
    skipped = [p for p in PATHS if p not in plan.paths]
    tokens_injected = sum(estimate_tokens(h.text) for h in hits)

    # 召回即「用过」：更新 last_hit_at，冷热调度靠它（AD-10）
    hit_ids = [h.id for h in hits]
    if hit_ids:
        runtime.lance.touch(hit_ids, moment, "hot")

    runtime.bus.emit(
        "recall",
        {
            "query": query,
            "plan": plan.to_dict(),
            "hits": [h.to_event_hit() for h in hits],
            "skipped_paths": skipped,
            "tokens_injected": tokens_injected,
            "cold_promoted": promoted,
        },
        trace_id=trace_id,
    )
    log.info(
        "retrieve.done",
        trace_id=trace_id,
        hits=len(hits),
        paths=plan.paths,
        depth=plan.depth,
        cold_promoted=len(promoted),
    )
    return RecallResult(items=hits, paths_used=used, plan=plan, cold_promoted=promoted)
