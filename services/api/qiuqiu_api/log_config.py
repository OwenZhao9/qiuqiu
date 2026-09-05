"""structlog 配置：JSON 一行一条，每条带 `trace_id`（CONVENTIONS 的日志约定）。

`trace_id` 走 structlog 的 contextvars：路由拿到 trace 之后 `bind_trace(trace_id)`，
这一条请求链上的日志就都带上它，不用逐处手传。
"""

from __future__ import annotations

import logging
import os
import sys

import structlog

__all__ = ["bind_trace", "configure_logging"]

_configured = False


def configure_logging(level: str | None = None) -> None:
    """配一次就够。重复调用无副作用（测试里每建一个 app 都会调）。"""
    global _configured
    if _configured:
        return
    _configured = True
    resolved = (level or os.environ.get("LOG_LEVEL") or "INFO").upper()
    logging.basicConfig(format="%(message)s", stream=sys.stderr, level=resolved)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping().get(resolved, logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )


def bind_trace(trace_id: str) -> None:
    structlog.contextvars.bind_contextvars(trace_id=trace_id)
