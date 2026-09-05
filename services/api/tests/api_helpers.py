"""后端测试的公共构件：SSE 读取。

放在 conftest 之外是因为 `packages/*/tests/` 下也各有一个 `conftest.py`，
`import conftest` 会撞车（记忆层那边用 `memory_helpers.py` 是同一个理由）。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

__all__ = ["SSEProbe", "parse_sse"]


# ---------------------------------------------------------------- SSE 读取


def parse_sse(text: str) -> list[tuple[str | None, Any]]:
    """把一段 SSE 文本解析成 `[(事件名, 数据)]`。事件名缺省是 `None`（`/events` 那种）。"""
    out: list[tuple[str | None, Any]] = []
    name: str | None = None
    data: list[str] = []
    for line in text.splitlines():
        if line.startswith(":"):
            continue
        if not line:
            if data:
                out.append((name, _loads("\n".join(data))))
            name, data = None, []
            continue
        if line.startswith("event: "):
            name = line[7:]
        elif line.startswith("data: "):
            data.append(line[6:])
    if data:
        out.append((name, _loads("\n".join(data))))
    return out


def _loads(raw: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return raw


# ------------------------------------------------------- 无限 SSE 流的读法

# Starlette 的 TestClient 与 httpx 的 ASGITransport 都会**把响应整段缓冲**再返回
# （两边都是 `await app(scope, receive, send)` 跑完才组装 Response），拿它们读
# `/events` 这种永不结束的流会直接挂死。所以这里自己驱动一次 ASGI 调用，
# 逐块收 `http.response.body`——顺带把「客户端断线」也变成可控的一步。


class SSEProbe:
    """驱动一次 ASGI 请求，增量地读 SSE。`close()` 相当于客户端断线。"""

    def __init__(
        self,
        app: Any,
        path: str,
        headers: dict[str, str] | None = None,
        *,
        method: str = "GET",
        json_body: Any = None,
    ) -> None:
        self._app = app
        self._path = path
        self._method = method
        self._body = b"" if json_body is None else json.dumps(json_body).encode()
        self._headers = dict(headers or {})
        if json_body is not None:
            self._headers.setdefault("content-type", "application/json")
            self._headers.setdefault("content-length", str(len(self._body)))
        self._chunks: Any = None
        self._task: Any = None
        self._started: Any = None
        self._disconnect: Any = None
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self._buffer = ""

    async def __aenter__(self) -> SSEProbe:
        path, _, query = self._path.partition("?")
        self._chunks = asyncio.Queue()
        self._started = asyncio.Event()
        self._disconnect = asyncio.Event()

        sent_body = False

        async def receive() -> dict[str, Any]:
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": self._body, "more_body": False}
            await self._disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                self.status = message["status"]
                self.headers = {k.decode(): v.decode() for k, v in message.get("headers", [])}
                self._started.set()
            elif message["type"] == "http.response.body":
                await self._chunks.put(message.get("body", b""))
                if not message.get("more_body", False):
                    await self._chunks.put(None)

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": self._method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": [(k.lower().encode(), v.encode()) for k, v in self._headers.items()],
            "client": ("testclient", 50000),
            "server": ("testserver", 80),
        }
        self._task = asyncio.create_task(self._app(scope, receive, send))
        await asyncio.wait_for(self._started.wait(), timeout=5.0)
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._disconnect is not None:
            self._disconnect.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: B014 - 收尾不抛
                pass
            self._task = None

    async def read(self, count: int, *, timeout: float = 5.0) -> list[dict[str, Any]]:
        """读满 `count` 条 `data:` 事件。注释（心跳）与 `id:` 行跳过。"""
        got: list[dict[str, Any]] = []

        async def _pump() -> None:
            while len(got) < count:
                chunk = await self._chunks.get()
                if chunk is None:
                    raise AssertionError("SSE 流提前结束")
                self._buffer += chunk.decode()
                while "\n\n" in self._buffer:
                    block, self._buffer = self._buffer.split("\n\n", 1)
                    for line in block.splitlines():
                        if line.startswith("data: "):
                            got.append(json.loads(line[6:]))

        try:
            await asyncio.wait_for(_pump(), timeout=timeout)
        except TimeoutError as exc:
            raise AssertionError(f"等 {count} 条事件超时，只等到 {len(got)} 条：{got}") from exc
        return got

    async def read_frames(
        self, count: int, *, timeout: float = 5.0
    ) -> list[tuple[str | None, Any]]:
        """读满 `count` 帧，连事件名一起返回。`/chat` 的 `meta` / `delta` / `done` 用它。"""
        got: list[tuple[str | None, Any]] = []

        async def _pump() -> None:
            while len(got) < count:
                chunk = await self._chunks.get()
                if chunk is None:
                    raise AssertionError("SSE 流提前结束")
                self._buffer += chunk.decode()
                while "\n\n" in self._buffer:
                    block, self._buffer = self._buffer.split("\n\n", 1)
                    name: str | None = None
                    payload: Any = None
                    for line in block.splitlines():
                        if line.startswith("event: "):
                            name = line[7:]
                        elif line.startswith("data: "):
                            payload = _loads(line[6:])
                    if payload is not None:
                        got.append((name, payload))

        try:
            await asyncio.wait_for(_pump(), timeout=timeout)
        except TimeoutError as exc:
            raise AssertionError(f"等 {count} 帧超时，只等到 {len(got)} 帧：{got}") from exc
        return got

    async def read_lines(self, prefix: str, count: int, *, timeout: float = 5.0) -> list[str]:
        """读满 `count` 条以 `prefix` 开头的原始行（用来验 `id:` 游标行）。"""
        got: list[str] = []

        async def _pump() -> None:
            while len(got) < count:
                chunk = await self._chunks.get()
                if chunk is None:
                    raise AssertionError("SSE 流提前结束")
                self._buffer += chunk.decode()
                while "\n" in self._buffer:
                    line, self._buffer = self._buffer.split("\n", 1)
                    if line.startswith(prefix):
                        got.append(line[len(prefix) :])

        try:
            await asyncio.wait_for(_pump(), timeout=timeout)
        except TimeoutError as exc:
            raise AssertionError(f"等 {count} 行 {prefix!r} 超时：{got}") from exc
        return got
