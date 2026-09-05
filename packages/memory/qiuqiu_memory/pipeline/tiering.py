"""冷热联动。**判断标准在这里，搬运动作在 `qiuqiu_data.tiering`**（AD-10）。

两个方向：

- 召回命中冷条目 → `promote()` 整条回热并更新 `last_hit_at`。`pipeline/retrieve.py`
  在下探冷表之后调它，返回值进 `recall` 事件的 `cold_promoted`。
- `last_hit_at` 早于 `STALE_DAYS` 天 → 降冷。入口是
  `qiuqiu_memory.pipeline.tiering.nightly(runtime)`（契约 § 3），**由后端定时任务调**，
  本层不自带调度器。

`STALE_DAYS = 30` 是 AD-10 定的「热表存近 30 天命中过的事实」。改它要同步改 AD-10。

时钟走 `runtime.now()`，场景回放把时间推到三个月后也不用动系统时钟。
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from typing import Any

import structlog

from ..types import to_utc

__all__ = ["STALE_DAYS", "make_tiering", "nightly", "promote"]

log = structlog.get_logger("qiuqiu_memory.tiering")

STALE_DAYS = 30
"""热表只留近 30 天命中过的事实（AD-10）。"""


def make_tiering(runtime: Any, *, at: dt.datetime | None = None) -> Any:
    """建一个 `qiuqiu_data.tiering.Tiering`，时钟接到 `runtime.now()` 上。"""
    from qiuqiu_data.tiering import Tiering

    moment = to_utc(at) if at is not None else None
    return Tiering(runtime.lance, now=(lambda: moment) if moment else runtime.now)


def promote(runtime: Any, fact_ids: Sequence[str], *, at: dt.datetime | None = None) -> list[str]:
    """冷条目整条回热。返回真正搬动的 id（本来就在热表的会被跳过）。"""
    ids = [i for i in dict.fromkeys(fact_ids) if i]
    if not ids:
        return []
    moved = make_tiering(runtime, at=at).promote(ids)
    if moved:
        log.info("tiering.promote", count=len(moved))
    return list(moved)


def nightly(runtime: Any, *, days: int = STALE_DAYS) -> dict[str, Any]:
    """定时入口：降冷一轮 + 合并索引碎片，返回可写日志的摘要。

    契约 § 3 点名的降冷入口就是 `qiuqiu_memory.pipeline.tiering.nightly(runtime)`
    （v0.1.7 收编）。后端的定时任务调这个，**不**调 `qiuqiu_data.tiering.nightly`——
    阈值属于记忆层的判断，搬运才是 data 的活（AD-10）。`days` 不在契约里，留给测试与
    场景回放覆盖，缺省就是 `STALE_DAYS`。
    """
    summary = make_tiering(runtime).nightly(days)
    log.info("tiering.nightly", days=days, demoted=summary.get("demoted"))
    return summary
