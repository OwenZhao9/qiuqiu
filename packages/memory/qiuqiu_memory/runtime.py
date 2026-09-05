"""把「记忆层要用的东西」装在一个对象里：存储、总线、嵌入器、Chat、时钟、阈值。

为什么要这么一层：`MemoryFacade` 与 `PersonaService` 的方法签名被 CONTRACTS § 3 定死了，
构造参数没被定死。所有可注入的依赖收在 `MemoryRuntime` 里，测试换一个临时目录、换一个
假时钟就行，门面本身不用改签名。

**同步门面调异步模型。** 契约里 `ingest()` / `recall()` 是普通 `def`，而
`ChatModel.complete()` 是 `async`。这里起一条后台线程跑自己的事件循环，
`run(coro)` 用 `run_coroutine_threadsafe` 把协程丢过去等结果。好处是无论调用方在不在
事件循环里都能用；后端在 FastAPI 里应当 `await asyncio.to_thread(facade.ingest, ...)`，
免得阻塞它自己的循环。

**初始化顺序**（给 backend 看）：
1. 载入 `.env`
2. `stores = qiuqiu_data.init()`
3. `qiuqiu_models.metrics.set_sink(<写 stores.sqlite.record_metric 的 sink>)`
4. `facade = MemoryFacade(stores=stores)`
不传 `stores` 的话本模块会自己调一次 `qiuqiu_data.init()`——能跑，但指标 sink 就没人注入了。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import threading
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

import structlog

from .bus import EventBus
from .embed import Embedder, get_embedder
from .types import utcnow

__all__ = ["DEFAULTS", "MemoryRuntime", "Thresholds"]

T = TypeVar("T")

log = structlog.get_logger("qiuqiu_memory.runtime")

DEFAULTS: dict[str, Any] = {
    # 筛选判定（契约 v0.1.5 的 /config/thresholds）
    "accept": 0.72,
    "uncertain": 0.45,
    # 同义合并：token Jaccard 与余弦，任一过线就当同义
    "merge_jaccard": 0.60,
    "merge_cosine": 0.90,
    # 被动采集去重时回看多少条最近输入
    "dedup_window": 20,
    # 检索规划的基准深度
    "base_depth": 8,
    # 性格沉淀读最近多少条消息
    "consolidate_rounds": 50,
}

_SETTINGS_BLOB_KEY = "thresholds"
"""后端 `PUT /config/thresholds` 存的整块 JSON，形如 `{"accept": 0.72, "uncertain": 0.45}`。"""


class Thresholds:
    """判定阈值。每次读都回 SQLite 拿，所以 `/config/thresholds` 改完立刻生效。"""

    __slots__ = ("_sqlite",)

    def __init__(self, sqlite: Any) -> None:
        self._sqlite = sqlite

    def get(self, key: str) -> float:
        default = float(DEFAULTS[key])
        blob = self._sqlite.get_setting(_SETTINGS_BLOB_KEY)
        if blob:
            try:
                parsed = json.loads(blob)
            except (TypeError, ValueError):
                parsed = None
            if isinstance(parsed, dict) and key in parsed:
                return _as_float(parsed[key], default)
        return _as_float(self._sqlite.get_setting(f"{_SETTINGS_BLOB_KEY}.{key}"), default)

    @property
    def accept(self) -> float:
        return self.get("accept")

    @property
    def uncertain(self) -> float:
        return self.get("uncertain")

    def decide(self, score: float) -> str:
        """契约 v0.1.5 的判定规则：>= accept 留，>= uncertain 拿不准，否则丢。"""
        if score >= self.accept:
            return "accept"
        if score >= self.uncertain:
            return "uncertain"
        return "reject"


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


class _LoopThread:
    """一条后台线程 + 一个事件循环。惰性启动，进程退出时随守护线程一起走。"""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is not None:
            return self._loop
        with self._lock:
            if self._loop is not None:
                return self._loop
            loop = asyncio.new_event_loop()
            ready = threading.Event()

            def _run() -> None:
                asyncio.set_event_loop(loop)
                ready.set()
                loop.run_forever()

            thread = threading.Thread(target=_run, name="qiuqiu-memory-loop", daemon=True)
            thread.start()
            ready.wait()
            self._loop, self._thread = loop, thread
            return loop

    def run(self, coro: Coroutine[Any, Any, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self.loop()).result()

    def close(self) -> None:
        loop, thread = self._loop, self._thread
        self._loop = self._thread = None
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=5)
        if loop is not None:
            loop.close()


class MemoryRuntime:
    """记忆层的运行时依赖集合。"""

    def __init__(
        self,
        *,
        stores: Any | None = None,
        data_dir: str | None = None,
        bus: EventBus | None = None,
        embedder: Embedder | None = None,
        chat: Any | None = None,
        clock: Callable[[], dt.datetime] | None = None,
    ) -> None:
        if stores is None:
            import qiuqiu_data

            stores = qiuqiu_data.init(data_dir)
        self.stores = stores
        self.lance = stores.lance
        self.sqlite = stores.sqlite
        self.blobs = stores.blobs
        self.bus = bus if bus is not None else EventBus(self.sqlite)
        self.embedder = embedder if embedder is not None else get_embedder()
        self.thresholds = Thresholds(self.sqlite)
        self._chat = chat
        self._clock = clock or utcnow
        self._loop_thread = _LoopThread()

    # ---------- 时钟 ----------

    def now(self) -> dt.datetime:
        """当前时间（带时区 UTC）。场景回放不改系统时钟，改这里注入的钟。"""
        return self._clock()

    # ---------- 模型（AD-8：只经 registry） ----------

    @property
    def chat(self) -> Any:
        """Chat 实例。**只从 `qiuqiu_models.registry` 拿**，不 import 任何供应商。"""
        if self._chat is None:
            from qiuqiu_models import registry

            self._chat = registry.get("chat")
        return self._chat

    @property
    def chat_provider(self) -> str:
        return str(getattr(self.chat, "provider", "unknown"))

    # ---------- 设置 ----------

    def setting_int(self, key: str) -> int:
        raw = self.sqlite.get_setting(key)
        try:
            return int(str(raw))
        except (TypeError, ValueError):
            return int(DEFAULTS[key])

    # ---------- 异步 ----------

    def run(self, coro: Coroutine[Any, Any, T]) -> T:
        """在后台循环里跑一个协程并等结果。同步门面调异步模型走这里。"""
        return self._loop_thread.run(coro)

    def close(self) -> None:
        """停掉后台循环。测试收尾用；进程退出不调也没关系（守护线程）。"""
        self._loop_thread.close()
