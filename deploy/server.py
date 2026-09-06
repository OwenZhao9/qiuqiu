"""托管版入口：一个进程同时端出前端静态页和后端 API。

**为什么要这一层。** 前端 `apiBase()` 默认打同源的 `/api`（`apps/web/src/api.ts`），
开发时由 vite 反代过去。托管时没有 vite，所以这里把后端挂在 `/api`、把
`vite build` 的产物挂在 `/`，同源，前端一行都不用改。

**Starlette 不会把 lifespan 传给被挂载的子应用**，所以要自己驱动一次——
不驱动的话 `app.state.qiuqiu` 永远是空的，每个请求都 500。

**口令用纯 ASGI 中间件，不用 `BaseHTTPMiddleware`**：后者会把响应体经一层
队列转发，SSE 的 delta 会被攒住，首字延迟就没了（原因见 `qiuqiu_api/app.py`
开头那段）。这里只看一眼 header/cookie 就放行，不碰响应体。
"""

from __future__ import annotations

import os
import pathlib
import secrets
from urllib.parse import parse_qs, quote, unquote
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from qiuqiu_api.app import create_app

#: 前端产物。Dockerfile 里由 `vite build` 生成后拷到这儿。
WEB_DIR = pathlib.Path(os.environ.get("QIUQIU_WEB_DIR") or "/app/web")

#: 访问口令。设了就要求带上，没设就完全开放（本地起着看的时候方便）。
PASSWORD = (os.environ.get("DEMO_PASSWORD") or "").strip()

#: 放行的路径前缀：健康检查要免口令，否则平台探活会一直失败。
OPEN_PATHS = ("/health", "/api/health", "/favicon.ico")

api = create_app()


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    # 手动驱动子应用的 lifespan，AppState 才建得起来
    async with api.router.lifespan_context(api):
        yield


root = FastAPI(title="丘丘 · 托管版", lifespan=_lifespan, docs_url=None, redoc_url=None)
root.mount("/api", api)
if WEB_DIR.is_dir():
    root.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


class Gate:
    """口令闸。`?k=` 带对一次就种 cookie，之后不用再带。"""

    def __init__(self, app: object, password: str) -> None:
        self.app = app
        self.password = password

    async def __call__(self, scope: dict, receive: object, send: object) -> None:  # type: ignore[override]
        if scope["type"] != "http" or not self.password:
            await self.app(scope, receive, send)  # type: ignore[operator]
            return
        path = scope.get("path", "")
        if path.startswith(OPEN_PATHS):
            await self.app(scope, receive, send)  # type: ignore[operator]
            return

        headers = {k.decode(): v.decode() for k, v in scope.get("headers", [])}
        want = self.password.encode()

        def _same(v: str) -> bool:
            # `compare_digest` 不收非 ASCII 字符串，所以比字节；
            # URL 与 cookie 里都是百分号编码过的，先还原
            return secrets.compare_digest(unquote(v).encode(), want)

        ok_cookie = any(
            _same(c.strip()[len("qq=") :])
            for c in headers.get("cookie", "").split(";")
            if c.strip().startswith("qq=")
        )
        ok_query = any(
            _same(v) for v in parse_qs(scope.get("query_string", b"").decode()).get("k", [])
        )
        if ok_cookie:
            await self.app(scope, receive, send)  # type: ignore[operator]
            return
        if ok_query:
            # 带对了就种上 cookie，刷新和后续的 SSE 请求就不用再挂 `?k=`
            cookie = f"qq={quote(self.password)}; Path=/; Max-Age=86400; SameSite=Lax".encode()

            async def send_with_cookie(message: dict) -> None:
                if message["type"] == "http.response.start":
                    message.setdefault("headers", []).append((b"set-cookie", cookie))
                await send(message)  # type: ignore[operator]

            await self.app(scope, receive, send_with_cookie)  # type: ignore[operator]
            return

        body = b"need a key: add ?k=... to the url"
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"text/plain; charset=utf-8"),
                                (b"content-length", str(len(body)).encode())]})  # type: ignore[operator]
        await send({"type": "http.response.body", "body": body})  # type: ignore[operator]


app = Gate(root, PASSWORD) if PASSWORD else root
