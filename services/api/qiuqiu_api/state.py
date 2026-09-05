"""进程级依赖：存储、记忆门面、人格、配置、语音会话表。

启动顺序照 `qiuqiu_memory.runtime` 的文档写死（那份文档是给 backend 看的）：

1. 载入 `.env`
2. `stores = qiuqiu_data.init()`
3. `qiuqiu_models.metrics.set_sink(...)` —— 早于任何模型调用，不然指标掉在内存里
4. `MemoryFacade(runtime)` 与 `PersonaService(runtime)` **共用同一个 runtime**

共用 runtime 不是省事：事件总线挂在 runtime 上，两边各建一个的话人格那边发的事件
到不了 `/events`，而事件是「记忆看得见」的唯一数据源（AD-14）。

AD-7 的边界在这里落地：记忆经 `facade` / `persona`，`sessions` `messages` `settings`
`providers` `run_metrics` 经 `state.sqlite` 直接读写，`event_log` 只读。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from typing import Any

import structlog

from .config import Config
from .errors import CapabilityUnavailable
from .metrics_sink import SqliteMetricsSink

__all__ = ["AppState", "VoiceSession", "new_trace_id"]

log = structlog.get_logger("qiuqiu_api.state")


def new_trace_id() -> str:
    """一次 `/chat` 或 `/ingest` 的 trace。贯穿 ingest、事件信封、run_metrics。"""
    return "trc_" + uuid.uuid4().hex[:12]


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class VoiceSession:
    """`POST /voice/session` 发出去的一张票，`WS /voice/stream` 拿它换连接。"""

    __slots__ = ("id", "session_id", "mode", "created_at")

    def __init__(self, session_id: str, mode: str) -> None:
        self.id = new_id("vs")
        self.session_id = session_id
        self.mode = mode
        self.created_at = dt.datetime.now(dt.UTC)

    def to_dict(self) -> dict[str, Any]:
        return {"voice_session_id": self.id, "mode": self.mode}


class AppState:
    """一个进程一份。测试里每个用例建一份，指向自己的临时 `DATA_DIR`。"""

    def __init__(self, *, stores: Any, facade: Any, persona: Any, config: Config) -> None:
        self.stores = stores
        self.facade = facade
        self.persona = persona
        self.config = config
        self.voice_sessions: dict[str, VoiceSession] = {}
        self.scheduler: Any | None = None
        self._started_at = dt.datetime.now(dt.UTC)

    # ---------- 建 / 拆 ----------

    @classmethod
    def create(cls, *, config: Config | None = None) -> AppState:
        import qiuqiu_data
        from qiuqiu_memory import MemoryFacade, PersonaService
        from qiuqiu_memory.runtime import MemoryRuntime
        from qiuqiu_models import metrics

        config = config or Config.from_env()
        stores = qiuqiu_data.init(config.data_dir)
        metrics.set_sink(SqliteMetricsSink(stores.sqlite))
        runtime = MemoryRuntime(stores=stores)
        state = cls(
            stores=stores,
            facade=MemoryFacade(runtime),
            persona=PersonaService(runtime),
            config=config,
        )
        log.info("state.ready", data_dir=str(stores.paths.root))
        return state

    def close(self) -> None:
        try:
            self.facade.close()
        except Exception:  # noqa: BLE001 - 收尾不该盖住真正的错误
            log.warning("state.close_failed", exc_info=True)
        self.stores.sqlite.close()

    # ---------- 直接读写的表（AD-7 后端归属） ----------

    @property
    def sqlite(self) -> Any:
        return self.stores.sqlite

    @property
    def blobs(self) -> Any:
        return self.stores.blobs

    @property
    def runtime(self) -> Any:
        return self.facade.runtime

    @property
    def uptime_s(self) -> float:
        return (dt.datetime.now(dt.UTC) - self._started_at).total_seconds()

    def setting_int(self, key: str, default: int) -> int:
        """SQLite `settings` 里的整数配置，读不到就用默认值。热改立刻生效。"""
        raw = self.sqlite.get_setting(key)
        try:
            return int(str(raw))
        except (TypeError, ValueError):
            return default

    # ---------- 模型（AD-8：只经 registry） ----------

    def capability(self, name: str) -> Any:
        """`registry.get(name)`，缺失时翻成带 hint 的 503。**不换 mock**（AD-16）。"""
        from qiuqiu_models import registry

        try:
            return registry.get(name)
        except Exception as exc:  # noqa: BLE001 - 统一成 CapabilityUnavailable
            hint = getattr(exc, "hint", None)
            raise CapabilityUnavailable(
                str(exc),
                hint=hint or "在 .env 里配好这项能力，或设 MODELS_MOCK=1 离线开发。",
                code=getattr(exc, "code", None) or "api.capability_unavailable",
            ) from exc

    def optional_capability(self, name: str) -> Any | None:
        """拿不到就返回 `None`。只给「有就用、没有就跳过」的能力用（本轮的 TTS）。"""
        try:
            return self.capability(name)
        except CapabilityUnavailable as exc:
            log.info("capability.absent", capability=name, hint=exc.hint)
            return None

    # ---------- 语音会话 ----------

    def open_voice_session(self, session_id: str, mode: str) -> VoiceSession:
        session = VoiceSession(session_id, mode)
        self.voice_sessions[session.id] = session
        return session

    # ---------- 阻塞调用 ----------

    @staticmethod
    async def off_loop(fn: Any, /, *args: Any, **kwargs: Any) -> Any:
        """`ingest()` `recall()` 是同步方法（CONTRACTS § 3），扔线程里跑别堵住循环。"""
        return await asyncio.to_thread(fn, *args, **kwargs)
