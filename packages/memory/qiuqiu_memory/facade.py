"""`MemoryFacade`：服务层能碰记忆的唯一入口（AD-7）。

五个方法的签名逐字按 CONTRACTS § 3，一个字都不能动。构造参数不在契约里，所以可注入的
东西全收在 `MemoryRuntime`（见 `runtime.py`）。

    facade = MemoryFacade(stores=qiuqiu_data.init())
    facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=datetime.now(UTC))
    facade.recall("他叫什么", budget=Budget())

**分流在这一层，不在后端**（AD-3）：`DIALOGUE` / `JOURNAL` 跳过筛选直接压缩，
`AMBIENT_*` 先过筛选，每次判断发一条 `filter` 事件。

**同步接口调异步模型。** 契约 § 3 写明 `ingest()` / `recall()` 是同步方法，内部经
`runtime.run()` 把协程丢到后台事件循环。后端在 FastAPI 里应当
`await asyncio.to_thread(facade.ingest, ...)`，别在自己的循环里直接调。

**一条 trace 贯穿一次调用。** `ingest()` / `recall()` 都收 `trace_id`（契约 v0.1.7），
调用方传了就用调用方的，这一次调用发出的每一条事件信封与 `run_metrics` 都挂在它上面。

**失败处理**（ARCHITECTURE § 3）：Chat 调不通时本次 `ingest` 返回空 `accepted`，
不重试；原话由后端留在 `messages` 表里。召回则退到确定性规划，照样出结果。
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any

import structlog

from .errors import ContractError, UnknownVisibleMemoryError
from .llm import ChatUnavailable
from .pipeline.compress import Fact, compress
from .pipeline.filter import Filter
from .pipeline.retrieve import retrieve
from .pipeline.synthesize import synthesize
from .text import preview
from .types import (
    AMBIENT_SOURCES,
    INGESTABLE_SOURCES,
    Budget,
    FactId,
    IngestResult,
    MemoryEvent,
    MergeOp,
    RecallResult,
    Rejection,
    Source,
    VisibleMemory,
    to_utc,
)

__all__ = ["LAYERS", "MemoryFacade", "layer_of", "new_trace_id"]

log = structlog.get_logger("qiuqiu_memory.facade")

LAYERS: tuple[str, ...] = ("L0", "L1", "L2")
"""`visible_memory.layer` 的取值域（CONTRACTS § 5），含义按契约 v0.1.7（§ 1 的表）：

- `L0` 身份：名字、称呼、生日、职业这类几乎不变的事实
- `L1` 偏好：喜欢什么、讨厌什么、习惯怎样，变得慢
- `L2` 近况：最近发生的事、临时的安排，变得快

是**稳定度**分层，不是重要度也不是时间。契约点名归层规则在 `layer_of`，函数名别改。
分层只影响记忆库界面怎么分组，不影响召回——召回按三路走，不看 layer。
"""

_L0_RE = re.compile(r"(叫|名字|姓名|生日|出生|职业|工作是|上学|专业|住在|家在)")
_L1_RE = re.compile(r"(喜欢|讨厌|爱吃|爱喝|想喝|想吃|习惯|偏好|不吃|不喝|常|总是|从不)")


def new_trace_id() -> str:
    """一次 `ingest` / `recall` 的 trace。后端有自己的就传进来，没有就在这儿生成。"""
    return "trc_" + uuid.uuid4().hex[:12]


def layer_of(text: str) -> str:
    """把一条事实归到 L0 / L1 / L2。规则见 `LAYERS`。

    **函数名是契约的一部分**：CONTRACTS § 1 点名「归层规则在
    `packages/memory/qiuqiu_memory/facade.py::layer_of`」。
    """
    if _L0_RE.search(text or ""):
        return "L0"
    if _L1_RE.search(text or ""):
        return "L1"
    return "L2"


def _visible_id(fact_id: str) -> str:
    return "vm_" + fact_id.removeprefix("fact_")


class MemoryFacade:
    """记忆中间件的门面。五个方法，签名按 CONTRACTS § 3。"""

    def __init__(self, runtime: Any | None = None, **runtime_kwargs: Any) -> None:
        from .runtime import MemoryRuntime

        self.runtime = runtime if runtime is not None else MemoryRuntime(**runtime_kwargs)
        self._filter = Filter(self.runtime)

    # ----------------------------------------------------------------- ingest

    def ingest(
        self,
        text: str,
        *,
        source: Source,
        speaker: str,
        ts: dt.datetime,
        blob_id: str | None = None,
        trace_id: str | None = None,
    ) -> IngestResult:
        """写入一段输入。被动采集先筛选，主动输入直接压缩（AD-3）。

        `trace_id` 由调用方传（契约 v0.1.7）：`/chat` 与 `/ingest` 生成一条，这一次调用
        发出的 `filter` `write` `merge` 事件与 `run_metrics` 全挂在它上面，侧栏才串得起
        「这一轮记了什么」。不传就在这儿生成一条，返回值里照常带回。
        """
        if not isinstance(source, Source):
            raise ContractError(
                f"source 必须是 Source 枚举，收到 {source!r}。",
                hint="用 qiuqiu_memory.Source 的成员之一。",
            )
        if source not in INGESTABLE_SOURCES:
            raise ContractError(
                f"{source.name} 不是 ingest() 的来源。",
                hint="Source.PERSONA 是中间件内部用的（CONTRACTS § 3），"
                "性格档案由 PersonaService.run_consolidation() 写冷表，别走 ingest()。",
            )
        if speaker not in {"user", "assistant"}:
            raise ContractError(
                f"speaker 只能是 user 或 assistant，收到 {speaker!r}。",
                hint="AI 自己的回复也要写进记忆，speaker 传 assistant（AD-6）。",
            )
        trace_id = trace_id or new_trace_id()
        moment = to_utc(ts)

        if source in AMBIENT_SOURCES:
            decision = self._screen(text, source=source, blob_id=blob_id, trace_id=trace_id)
            if decision.decision != "accept":
                return IngestResult(
                    trace_id=trace_id,
                    rejected=[
                        Rejection(
                            reason=decision.reason,
                            score=decision.score,
                            preview=preview(text),
                        )
                    ],
                    decision=decision.decision,
                )
            self._filter.remember(text)

        try:
            compressed = self.runtime.run(
                compress(
                    self.runtime,
                    text,
                    source=source,
                    speaker=speaker,
                    ts=moment,
                    trace_id=trace_id,
                    blob_id=blob_id,
                )
            )
        except ChatUnavailable as exc:
            # ARCHITECTURE § 3：中间件这一路失败就返回空 accepted，不重试。
            log.warning("ingest.chat_unavailable", trace_id=trace_id, hint=exc.hint)
            return IngestResult(trace_id=trace_id, decision="accept")

        merged = self.runtime.run(
            synthesize(self.runtime, compressed.facts, trace_id=trace_id, now=moment)
        )
        self._publish_visible(compressed.facts, merged)

        result = IngestResult(
            trace_id=trace_id,
            accepted=[f.id for f in compressed.facts],
            merged=merged,
            decision="accept",
            summary=compressed.summary,
        )
        log.info(
            "ingest.done",
            trace_id=trace_id,
            source=source.value,
            speaker=speaker,
            accepted=len(result.accepted),
            merged=len(merged),
        )
        return result

    def _screen(self, text: str, *, source: Source, blob_id: str | None, trace_id: str) -> Any:
        """筛一条被动输入并发 `filter` 事件。事件由门面发，筛选器本身不发（AD-14）。"""
        decision = self._filter.evaluate(text, source=source, blob_id=blob_id)
        self.runtime.bus.emit(
            "filter",
            {
                "decision": decision.decision,
                "score": decision.score,
                "reason": decision.reason,
                "source": source.value,
                "input_preview": preview(text),
            },
            trace_id=trace_id,
        )
        return decision

    # ----------------------------------------------------------------- recall

    def recall(
        self,
        query: str,
        *,
        budget: Budget,
        now: dt.datetime | None = None,
        trace_id: str | None = None,
    ) -> RecallResult:
        """召回。`now` 缺省为当前时间，场景回放传偏移后的时间。

        `trace_id` 同 `ingest()`：调用方传就用调用方的，`recall` 事件挂在它上面。
        """
        moment = to_utc(now) if now is not None else self.runtime.now()
        trace_id = trace_id or new_trace_id()
        return self.runtime.run(
            retrieve(self.runtime, query, budget=budget, now=moment, trace_id=trace_id)
        )

    # ---------------------------------------------------------- visible layer

    def list_visible(self, layer: str | None = None) -> list[VisibleMemory]:
        """用户可见的记忆库。`layer` 为空时返回全部。"""
        if layer is not None and layer not in LAYERS:
            raise ContractError(
                f"layer 只能是 {list(LAYERS)}，收到 {layer!r}。",
                hint="GET /memories?layer=L0|L1|L2，不传就是全部。",
            )
        rows = self.runtime.sqlite.list_visible_memory(layer=layer)
        return [VisibleMemory.from_row(r) for r in rows]

    def edit_visible(self, mid: str, **fields: Any) -> VisibleMemory:
        """改一条可见记忆。

        认得的键：`content` `layer` `enabled` `source` `fact_ids`，外加一个
        `deleted=True`——那是 `DELETE /memories/{id}` 的落点（契约 v0.1.7 定死的语义）：
        该条 `enabled` 置否，并对 `fact_ids` 逐条 `mark_superseded`，**两边都不删行**
        （AD-9）。用户看得见的是「这条没了」，底下留着痕迹，误删还能翻回来。
        """
        row = self.runtime.sqlite.get_visible_memory(mid)
        if row is None:
            raise UnknownVisibleMemoryError(
                f"记忆库里没有 {mid}。",
                hint="先用 GET /memories 拿一份现有的 id 列表。",
            )
        current = VisibleMemory.from_row(row)

        unknown = set(fields) - {"content", "layer", "enabled", "source", "fact_ids", "deleted"}
        if unknown:
            raise ContractError(
                f"VisibleMemory 没有这些字段：{sorted(unknown)}。",
                hint="能改的是 content / layer / enabled / source / fact_ids，"
                "删除传 deleted=True。",
            )
        if "layer" in fields and fields["layer"] not in LAYERS:
            raise ContractError(
                f"layer 只能是 {list(LAYERS)}，收到 {fields['layer']!r}。",
                hint="L0 身份 / L1 偏好 / L2 近况。",
            )

        if fields.get("deleted"):
            self._invalidate_facts(current.fact_ids)
            log.info("visible.deleted", id=mid, facts=len(current.fact_ids))
            enabled = False
        else:
            enabled = bool(fields.get("enabled", current.enabled))

        updated = self.runtime.sqlite.upsert_visible_memory(
            mid,
            fields.get("layer", current.layer),
            str(fields.get("content", current.content)),
            source=fields.get("source", current.source),
            enabled=enabled,
            fact_ids=list(fields.get("fact_ids", current.fact_ids)),
        )
        return VisibleMemory.from_row(updated)

    def _invalidate_facts(self, fact_ids: list[FactId]) -> None:
        """级联作废：`fact_ids` 逐条 `mark_superseded`，两层都写 `valid_to`，**不删行**（AD-9）。

        一次一条是 `lance.mark_superseded` 的签名（契约 v0.1.7 § 8 第 10 条按实现对齐）。
        """
        moment = self.runtime.now()
        for fact_id in fact_ids:
            for tier in ("hot", "cold"):
                self.runtime.lance.mark_superseded(fact_id, valid_to=moment, tier=tier)

    def _publish_visible(self, facts: list[Fact], merged: list[MergeOp]) -> None:
        """新事实进记忆库；被吸收的旧条目并进结果那一条。

        `visible_memory` 的写入方是 memory（ARCHITECTURE § 7 数据归属表），所以这一步
        放在门面里，后端只经 `list_visible` / `edit_visible` 读写。
        """
        for fact in facts:
            self.runtime.sqlite.upsert_visible_memory(
                _visible_id(fact.id),
                layer_of(fact.text),
                fact.text,
                source="auto",
                enabled=True,
                fact_ids=[fact.id],
            )
        for operation in merged:
            target = _visible_id(operation.result_id)
            row = self.runtime.sqlite.get_visible_memory(target)
            if row is None:
                continue
            keep = list(VisibleMemory.from_row(row).fact_ids)
            for absorbed in operation.absorbed:
                keep.append(absorbed["id"])
                # 被吸收的那一条自己可能也吸收过别人，把它挂着的 fact_ids 一并接过来，
                # 否则合并链一长，最早那几条事实就从记忆库里失联，级联作废也跟着漏。
                absorbed_row = self.runtime.sqlite.get_visible_memory(_visible_id(absorbed["id"]))
                if absorbed_row is not None:
                    keep.extend(VisibleMemory.from_row(absorbed_row).fact_ids)
                    self.runtime.sqlite.delete_visible_memory(_visible_id(absorbed["id"]))
            self.runtime.sqlite.upsert_visible_memory(
                target,
                layer_of(operation.result_text),
                operation.result_text,
                source="auto",
                enabled=True,
                fact_ids=list(dict.fromkeys(keep)),
            )

    # -------------------------------------------------------------- subscribe

    def subscribe(self) -> AsyncIterator[MemoryEvent]:
        """订阅记忆事件。`async for event in facade.subscribe():`

        注册发生在第一次 `__anext__`，所以订阅者在自己的事件循环里 `async for` 就行。
        断线续传不走这里——那是 `/events?since=` 按 `event_log` 自增 id 查（AD-14）。
        """
        return self.runtime.bus.stream()

    # ------------------------------------------------------------------- 收尾

    def close(self) -> None:
        """停掉后台事件循环。测试收尾用，进程退出不调也没关系。"""
        self.runtime.close()
