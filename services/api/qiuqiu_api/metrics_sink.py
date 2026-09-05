"""把 `qiuqiu_models.metrics` 的记录落到 SQLite `run_metrics`。

`run_metrics` 的写入方是 models 与 backend，读取方是 backend（ARCHITECTURE § 7）。
models 那层自己不 import `qiuqiu_data`，它只定义 sink 协议，落库由应用注入——
`MemoryRuntime` 的文档把这一步写成了启动第 3 步，本模块就是那一步的实现。

**mock 也记**（ARCHITECTURE § 7 的计量条），所以这里不按 provider 过滤。
sink 抛错不往上冒（`metrics.record` 自己吞了），计量坏了不该拖垮对话。
"""

from __future__ import annotations

import datetime as dt
from typing import Any

__all__ = ["SqliteMetricsSink"]


def _parse_ts(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


class SqliteMetricsSink:
    """`MetricsSink` 协议的实现：一条记录一行 `run_metrics`。"""

    def __init__(self, sqlite: Any) -> None:
        self._sqlite = sqlite

    def record(self, metric: Any) -> None:
        self._sqlite.record_metric(
            metric.trace_id,
            metric.stage,
            metric.provider,
            tokens_in=metric.tokens_in,
            tokens_out=metric.tokens_out,
            latency_ms=metric.latency_ms,
            ts=_parse_ts(getattr(metric, "ts", None)),
        )
