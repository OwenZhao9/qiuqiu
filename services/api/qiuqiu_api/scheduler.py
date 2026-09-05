"""定时任务。两件事：每日降冷，攒够轮数做一次性格沉淀。

记忆层不自带调度器（ARCHITECTURE § 5 memory 一节写死了这条），所以调度在后端：

- **降冷**：每天一次 `qiuqiu_memory.pipeline.tiering.nightly(runtime)`。判断标准由
  memory 定（30 天没命中就降冷），执行由 data 做，后端只管什么时候调（AD-10）。
  **不调 `qiuqiu_data.tiering`**——那是绕过判断直接搬运。
- **性格沉淀**：每轮对话记一次数，攒够 `settings.consolidate_every` 轮就后台调
  `PersonaService.run_consolidation()`。轮数落 SQLite `settings`，重启接着数。

两件都跑在线程里：`nightly()` 与 `run_consolidation()` 是同步的，直接在事件循环里
调会把 SSE 卡住。沉淀是「后台调」，所以开一个任务不等它，`/chat` 的 `done` 不受影响。
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any

import structlog

from .state import AppState

__all__ = ["Scheduler", "TURNS_KEY"]

log = structlog.get_logger("qiuqiu_api.scheduler")

TURNS_KEY = "consolidate.turns"
"""累计轮数落在 SQLite `settings` 的这个键上。`settings` 是后端归属表（AD-7）。"""

EVERY_KEY = "consolidate_every"
"""热改的阈值键。任务书写的就是 `settings.consolidate_every`。"""


class Scheduler:
    """一个 `AppState` 一个。`start()` / `stop()` 在应用的 lifespan 里调。"""

    def __init__(self, state: AppState) -> None:
        self.state = state
        self._nightly: asyncio.Task[None] | None = None
        self._jobs: set[asyncio.Task[Any]] = set()

    # ---------- 生命周期 ----------

    async def start(self) -> None:
        if not self.state.config.scheduler_enabled or self._nightly is not None:
            return
        self._nightly = asyncio.create_task(self._nightly_loop())
        log.info("scheduler.started", hour_utc=self.state.config.nightly_hour_utc)

    async def stop(self) -> None:
        if self._nightly is not None:
            self._nightly.cancel()
            self._nightly = None
        await self.drain(cancel=True)

    async def drain(self, *, cancel: bool = False) -> None:
        """等（或取消）后台作业。测试用它把「后台沉淀」变成确定的。"""
        jobs = list(self._jobs)
        for job in jobs:
            if cancel:
                job.cancel()
        for job in jobs:
            try:
                await job
            except (asyncio.CancelledError, Exception):  # noqa: B014 - 收尾不抛
                pass
        self._jobs.clear()

    def _spawn(self, coro: Any) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)
        self._jobs.add(task)
        task.add_done_callback(self._jobs.discard)
        return task

    # ---------- 性格沉淀 ----------

    @property
    def turns(self) -> int:
        return self.state.setting_int(TURNS_KEY, 0)

    @property
    def every(self) -> int:
        """`settings.consolidate_every` 优先，其次 `.env`，最后缺省。热改立刻生效。"""
        return max(1, self.state.setting_int(EVERY_KEY, self.state.config.consolidate_every))

    async def note_turn(self) -> bool:
        """记一轮。够数就后台起一次沉淀并清零，返回有没有触发。"""
        turns = self.turns + 1
        if turns < self.every:
            self.state.sqlite.set_setting(TURNS_KEY, str(turns))
            return False
        self.state.sqlite.set_setting(TURNS_KEY, "0")
        log.info("scheduler.consolidate_due", turns=turns, every=self.every)
        self._spawn(self.run_consolidation())
        return True

    async def run_consolidation(self) -> Any:
        """`PersonaService.run_consolidation()`，读 SQLite 原始会话归纳（AD-4）。"""
        try:
            learned = await self.state.off_loop(self.state.persona.run_consolidation)
        except Exception as exc:  # noqa: BLE001 - 沉淀失败不影响对话，下轮再来
            log.warning("consolidation.failed", error=str(exc))
            return None
        log.info("consolidation.done", learned=getattr(learned, "to_dict", dict)())
        return learned

    # ---------- 降冷 ----------

    async def run_nightly(self) -> dict[str, Any]:
        """降冷一轮。入口是记忆层的 `pipeline.tiering.nightly`，不是 data 的（AD-10）。"""
        from qiuqiu_memory.pipeline import tiering

        try:
            summary = await self.state.off_loop(tiering.nightly, self.state.runtime)
        except Exception as exc:  # noqa: BLE001 - 降冷失败不该拖垮服务
            log.warning("tiering.failed", error=str(exc))
            return {"error": str(exc)}
        log.info("tiering.done", **{k: v for k, v in summary.items() if not isinstance(v, list)})
        return summary

    async def _nightly_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._seconds_until_nightly())
                await self.run_nightly()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - 循环不能死
                log.warning("scheduler.nightly_loop_error", exc_info=True)
                await asyncio.sleep(60)

    def _seconds_until_nightly(self) -> float:
        now = dt.datetime.now(dt.UTC)
        target = now.replace(
            hour=self.state.config.nightly_hour_utc, minute=0, second=0, microsecond=0
        )
        if target <= now:
            target += dt.timedelta(days=1)
        return max(1.0, (target - now).total_seconds())
