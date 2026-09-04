"""模型调用计量。每次调用记一条 ``run_metrics``，mock 也记。

字段按 CONTRACTS § 5 的 ``run_metrics(trace_id, stage, tokens_in, tokens_out, latency_ms, ts)``，
外加一个 ``provider``（mock 实现填 ``"mock"``），用来区分真假调用。

**落库由上层注入。** ``packages/data`` 这一轮还没合进来，本模块不 import ``qiuqiu_data``：
这里只定义 ``MetricsSink`` Protocol 和一个默认的内存实现。M3 由 backend 在启动时
``metrics.set_sink(...)`` 注入 ``qiuqiu_data.sqlite`` 的实现，把记录写进 ``run_metrics`` 表。
在没人注入之前，记录攒在内存里（有上限，不会无限涨），不落盘、不打日志。

``trace_id`` 走 ``contextvars``：调用方在一次请求开始时 ``with use_trace_id("trc_xxx"):``，
模型层记录的每条指标就自动挂上同一个 trace。没设的话每条自己生成一个。
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, runtime_checkable

__all__ = [
    "InMemoryMetricsSink",
    "MetricsSink",
    "RunMetric",
    "current_trace_id",
    "get_sink",
    "measure",
    "new_trace_id",
    "record",
    "set_sink",
    "use_trace_id",
]

_MAX_BUFFERED = 1000


@dataclass(slots=True)
class RunMetric:
    """一次模型调用的计量记录。"""

    trace_id: str
    stage: str
    tokens_in: int
    tokens_out: int
    latency_ms: int
    ts: str
    provider: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "stage": self.stage,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "latency_ms": self.latency_ms,
            "ts": self.ts,
            "provider": self.provider,
        }


@runtime_checkable
class MetricsSink(Protocol):
    """指标落地的去处。M3 由 backend 注入 SQLite 实现。"""

    def record(self, metric: RunMetric) -> None: ...


class InMemoryMetricsSink:
    """默认实现：攒在内存里，最多 ``maxlen`` 条，超了丢最旧的。测试直接读 ``records``。"""

    def __init__(self, maxlen: int = _MAX_BUFFERED) -> None:
        self._records: deque[RunMetric] = deque(maxlen=maxlen)

    def record(self, metric: RunMetric) -> None:
        self._records.append(metric)

    @property
    def records(self) -> list[RunMetric]:
        return list(self._records)

    def clear(self) -> None:
        self._records.clear()


_sink: MetricsSink = InMemoryMetricsSink()

_trace_id: ContextVar[str | None] = ContextVar("qiuqiu_models_trace_id", default=None)


def set_sink(sink: MetricsSink) -> MetricsSink:
    """换掉指标去处，返回旧的（测试里方便还原）。"""

    global _sink
    old, _sink = _sink, sink
    return old


def get_sink() -> MetricsSink:
    return _sink


def new_trace_id() -> str:
    return "trc_" + uuid.uuid4().hex[:12]


def current_trace_id() -> str:
    """当前上下文的 trace_id，没设就现生成一个。"""

    return _trace_id.get() or new_trace_id()


@contextmanager
def use_trace_id(trace_id: str) -> Iterator[str]:
    """在这个上下文里，模型层记的指标都挂在 ``trace_id`` 上。"""

    token = _trace_id.set(trace_id)
    try:
        yield trace_id
    finally:
        _trace_id.reset(token)


def record(
    *,
    stage: str,
    provider: str,
    tokens_in: int = 0,
    tokens_out: int = 0,
    latency_ms: int = 0,
    trace_id: str | None = None,
    ts: str | None = None,
) -> RunMetric:
    """记一条指标，返回它。sink 抛错不往上冒——计量坏了不该拖垮对话。"""

    metric = RunMetric(
        trace_id=trace_id or current_trace_id(),
        stage=stage,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        latency_ms=latency_ms,
        ts=ts or datetime.now(UTC).isoformat(timespec="milliseconds"),
        provider=provider,
    )
    try:
        _sink.record(metric)
    except Exception:  # noqa: BLE001 - 计量失败不影响主流程
        pass
    return metric


class _Measurement:
    """``measure()`` 交出去的句柄，供应商在中途填 token 数。"""

    __slots__ = ("tokens_in", "tokens_out", "metric")

    def __init__(self) -> None:
        self.tokens_in = 0
        self.tokens_out = 0
        self.metric: RunMetric | None = None

    def usage(self, tokens_in: int | None, tokens_out: int | None) -> None:
        if tokens_in is not None:
            self.tokens_in = int(tokens_in)
        if tokens_out is not None:
            self.tokens_out = int(tokens_out)


@contextmanager
def measure(*, stage: str, provider: str, trace_id: str | None = None) -> Iterator[_Measurement]:
    """计时并记一条指标。失败也记（延迟照记，token 记已知的部分），异常照常往上抛。"""

    handle = _Measurement()
    started = time.perf_counter()
    try:
        yield handle
    finally:
        handle.metric = record(
            stage=stage,
            provider=provider,
            tokens_in=handle.tokens_in,
            tokens_out=handle.tokens_out,
            latency_ms=int((time.perf_counter() - started) * 1000),
            trace_id=trace_id,
        )
