"""进程内事件总线。记忆的每一次判断从这里外发（AD-14）。

顺序是定死的：**先写 `event_log` 拿自增 id，信封 `id` = `evt_` + 该 id，再发布。**
`/events?since=<cursor>` 的游标就是那个自增 id，所以「落库」必须早于「广播」——
不然前端先看见 `evt_7`，后端再按 `since=7` 拉，就会漏。

`publish()` 是同步的、不阻塞主流程：写一行 SQLite（本地文件，微秒级），然后往每个
订阅者的队列里 `put_nowait`。**队列满了丢最旧的**，绝不反压到记忆管线——侧栏少一条
事件是小事，写记忆卡住是大事。

跨线程：`MemoryFacade` 的管线跑在自己的后台事件循环里，订阅者（后端 SSE）跑在
另一个循环里。所以每个订阅在注册时记下自己的循环，`publish()` 用
`loop.call_soon_threadsafe` 投递；同循环时直接 `put_nowait`。
"""

from __future__ import annotations

import asyncio
import threading
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

import structlog

from .types import MemoryEvent, iso

__all__ = ["EVENT_TYPES", "EventBus", "Subscription"]

EVENT_TYPES: tuple[str, ...] = ("filter", "write", "merge", "recall")
"""CONTRACTS § 1 的四类事件，别的类型不许发。"""

DEFAULT_QUEUE_SIZE = 512
DEFAULT_HISTORY = 256

log = structlog.get_logger("qiuqiu_memory.bus")


class Subscription:
    """一个订阅者。绑定注册时所在的事件循环。"""

    __slots__ = ("queue", "loop", "dropped")

    def __init__(self, maxsize: int) -> None:
        self.queue: asyncio.Queue[MemoryEvent] = asyncio.Queue(maxsize=maxsize)
        self.loop = asyncio.get_running_loop()
        self.dropped = 0

    def _offer(self, event: MemoryEvent) -> None:
        """在订阅者自己的循环里执行：满了就丢最旧的，保证不阻塞发布方。"""
        if self.queue.full():
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:  # pragma: no cover - 竞态下的兜底
                pass
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover - 同上
            self.dropped += 1

    def deliver(self, event: MemoryEvent) -> None:
        """发布方线程调用。跨循环走 `call_soon_threadsafe`。"""
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self._offer(event)
            return
        try:
            self.loop.call_soon_threadsafe(self._offer, event)
        except RuntimeError:
            # 订阅者的循环已经关了，等它自己取消注册；这里静默跳过
            pass

    async def get(self) -> MemoryEvent:
        return await self.queue.get()


class EventBus:
    """事件总线。一个实例对应一个 `event_log` 表。"""

    def __init__(
        self,
        sqlite: Any,
        *,
        queue_size: int = DEFAULT_QUEUE_SIZE,
        history: int = DEFAULT_HISTORY,
    ) -> None:
        self._sqlite = sqlite
        self._queue_size = queue_size
        self._subs: list[Subscription] = []
        self._lock = threading.RLock()
        self.history: deque[MemoryEvent] = deque(maxlen=history)
        """最近若干条事件，只给测试与诊断用。断线续传走 `event_log` 的 `since` 游标。"""

    # ---------- 订阅 ----------

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)

    def open(self) -> Subscription:
        """同步注册一个订阅。必须在有事件循环的协程里调。"""
        sub = Subscription(self._queue_size)
        with self._lock:
            self._subs.append(sub)
        return sub

    def close(self, sub: Subscription) -> None:
        with self._lock:
            if sub in self._subs:
                self._subs.remove(sub)

    async def stream(self) -> AsyncIterator[MemoryEvent]:
        """异步生成器：`async for ev in bus.stream()`。`MemoryFacade.subscribe()` 用它。"""
        sub = self.open()
        try:
            while True:
                yield await sub.get()
        finally:
            self.close(sub)

    # ---------- 发布 ----------

    def publish(self, event: MemoryEvent) -> MemoryEvent:
        """落 `event_log` 拿 id，回填信封，再广播。返回补全了 `id` 的同一个对象。"""
        if event.type not in EVENT_TYPES:
            raise ValueError(f"事件类型只能是 {list(EVENT_TYPES)}，收到 {event.type!r}")
        if not event.ts:
            event.ts = iso()
        row_id = self._sqlite.append_event(
            event.type,
            event.payload,
            trace_id=event.trace_id,
        )
        event.id = f"evt_{row_id}"
        self.history.append(event)
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            sub.deliver(event)
        log.debug("bus.publish", id=event.id, type=event.type, trace_id=event.trace_id)
        return event

    def emit(
        self,
        type: str,
        payload: dict[str, Any],
        *,
        trace_id: str,
        ts: str | None = None,
    ) -> MemoryEvent:
        """`publish()` 的便捷包装，省得每处都拼一遍信封。"""
        return self.publish(
            MemoryEvent(type=type, payload=payload, trace_id=trace_id, ts=ts or iso())
        )
