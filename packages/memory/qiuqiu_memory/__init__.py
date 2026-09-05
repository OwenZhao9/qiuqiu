"""丘丘 · 记忆中间件与人格层。

调用方（backend）只需要三样东西，别的都是实现细节（AD-7）：

    from qiuqiu_memory import Budget, MemoryFacade, PersonaService, Source

    facade = MemoryFacade(stores=qiuqiu_data.init())
    persona = PersonaService(facade.runtime)          # 复用同一个 runtime

`MemoryFacade` 五个方法、`PersonaService` 五个方法的签名逐字按 CONTRACTS § 3。
`ingest()` / `recall()` 是同步方法，后端在事件循环里调要走 `await asyncio.to_thread(...)`，
`trace_id` 由调用方传进来，一次调用发出的所有事件挂同一条 trace。
事件信封与四类 payload 按 § 1，先写 `event_log` 拿自增 id，信封 `id` 是 `evt_` 加它。

六个环节在 `pipeline/`：筛选、压缩、合成、检索、冷热调度、性格沉淀。
定时任务的两个入口给后端调：`pipeline.tiering.nightly(runtime)` 与
`PersonaService.run_consolidation()`——本层不自带调度器。
"""

from __future__ import annotations

from .bus import EventBus
from .errors import ContractError, MemoryError_, UnknownVisibleMemoryError
from .facade import LAYERS, MemoryFacade
from .llm import ChatUnavailable
from .persona import BOUNDARY, PRESETS, PersonaService
from .runtime import MemoryRuntime
from .types import (
    AMBIENT_SOURCES,
    INGESTABLE_SOURCES,
    PATHS,
    Budget,
    FactId,
    FilterDecision,
    Hit,
    IngestResult,
    Learned,
    MemoryEvent,
    MergeOp,
    RecallResult,
    Rejection,
    RetrievalPlan,
    Sliders,
    Source,
    VisibleMemory,
)

__version__ = "0.1.0"

CONTRACT_VERSION = "v0.1.15"
"""本包实现的契约版本。改契约先改 `docs/CONTRACTS.md`，再改这里。"""

__all__ = [
    "AMBIENT_SOURCES",
    "BOUNDARY",
    "CONTRACT_VERSION",
    "ChatUnavailable",
    "ContractError",
    "Budget",
    "EventBus",
    "FactId",
    "FilterDecision",
    "Hit",
    "INGESTABLE_SOURCES",
    "IngestResult",
    "LAYERS",
    "Learned",
    "MemoryError_",
    "MemoryEvent",
    "MemoryFacade",
    "MemoryRuntime",
    "MergeOp",
    "PATHS",
    "PRESETS",
    "PersonaService",
    "RecallResult",
    "Rejection",
    "RetrievalPlan",
    "Sliders",
    "Source",
    "UnknownVisibleMemoryError",
    "VisibleMemory",
    "__version__",
]
