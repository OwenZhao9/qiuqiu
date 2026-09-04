"""冷热搬运的执行面（AD-10）。

判断标准由 memory 定，这里只执行：给什么 id 就搬什么，超过多少天算旧由调用方传。
搬运是 AD-9 里唯一允许删源表行的操作——整条搬过去，再删源表。

`now` 可注入，测试用它把时间推到 31 天后而不动系统时钟。
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Sequence
from typing import Any

import structlog

from .lance import FACT_FIELDS, LanceStore, utcnow

Clock = Callable[[], dt.datetime]

DEFAULT_STALE_DAYS = 30
DEFAULT_BATCH_SIZE = 1000

log = structlog.get_logger("qiuqiu_data.tiering")


def _pick_fields(row: dict[str, Any]) -> dict[str, Any]:
    """去掉查询带回来的 `_distance` / `_score` 之类，只留表里的字段。"""
    return {k: row[k] for k in FACT_FIELDS if k in row}


class Tiering:
    """冷热两表之间的搬运。"""

    def __init__(
        self,
        store: LanceStore,
        *,
        now: Clock = utcnow,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        self.store = store
        self.now = now
        self.batch_size = batch_size

    # ---------- 冷 → 热 ----------

    def promote(self, fact_ids: Sequence[str]) -> list[str]:
        """把冷表里的条目整条搬回热表，更新 `last_hit_at`，删掉冷表行。

        返回真正搬动的 id。冷表里找不到的（比如本来就在热表）直接跳过。
        """
        ids = list(dict.fromkeys(fact_ids))
        if not ids:
            return []
        rows = self.store.get_many(ids, "cold")
        if not rows:
            return []
        moment = self.now()
        payload = []
        for row in rows:
            record = _pick_fields(row)
            record["last_hit_at"] = moment
            payload.append(record)
        moved = [r["id"] for r in payload]
        self.store.upsert(payload, "hot")
        self.store.delete_rows(moved, "cold")
        # 搬完补索引：热表条数可能刚好跨过建向量索引的门槛
        self.store.ensure_indexes("hot")
        log.info("tiering.promote", moved=len(moved))
        return moved

    # ---------- 热 → 冷 ----------

    def demote_stale(self, days: int = DEFAULT_STALE_DAYS) -> list[str]:
        """把热表里 `last_hit_at` 早于阈值的条目搬冷，删热表行。

        分批搬，单批 `batch_size` 条，避免一次把整张表读进内存。
        """
        cutoff = self.now() - dt.timedelta(days=days)
        moved: list[str] = []
        while True:
            rows = self.store.query_scalar("hot", last_hit_before=cutoff, limit=self.batch_size)
            if not rows:
                break
            payload = [_pick_fields(r) for r in rows]
            batch_ids = [r["id"] for r in payload]
            self.store.upsert(payload, "cold")
            self.store.delete_rows(batch_ids, "hot")
            moved.extend(batch_ids)
            if len(rows) < self.batch_size:
                break
        if moved:
            self.store.ensure_indexes("cold")
            self.store.ensure_indexes("hot")
        log.info("tiering.demote_stale", days=days, cutoff=cutoff.isoformat(), moved=len(moved))
        return moved

    # ---------- 定时入口 ----------

    def nightly(self, days: int = DEFAULT_STALE_DAYS) -> dict[str, Any]:
        """定时任务入口：跑一次降冷，顺带合并索引碎片，返回一份可写日志的摘要。

        由 backend 的定时任务调（AD-10），本模块不自带调度器。
        """
        started = self.now()
        demoted = self.demote_stale(days)
        for tier in ("hot", "cold"):
            self.store.optimize(tier)
        summary = {
            "ran_at": started.isoformat(),
            "days": days,
            "demoted": len(demoted),
            "demoted_ids": demoted,
            "hot_rows": self.store.count("hot"),
            "cold_rows": self.store.count("cold"),
        }
        log.info("tiering.nightly", **{k: v for k, v in summary.items() if k != "demoted_ids"})
        return summary
