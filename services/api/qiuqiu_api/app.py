"""FastAPI 应用装配：lifespan、错误处理、CORS、路由挂载。

错误统一成 CONTRACTS § 1 的 `{"error": {code, message, hint}}`，四类来源各一个 handler：
本层的 `ApiError`、模型层的 `ModelError`、记忆层的 `MemoryError_`、参数校验。
兜底那个也带 hint——「所有错误响应带 hint」没有例外。

**不用 `BaseHTTPMiddleware`**：它会把响应体经一层队列转发，SSE 的 delta 会被攒住，
首字延迟是排第二的质量属性，不能为了写个日志中间件搭进去。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .config import Config
from .errors import ApiError, error_payload, from_exception
from .log_config import configure_logging
from .routes import api_router
from .scheduler import Scheduler
from .state import AppState

__all__ = ["create_app"]

log = structlog.get_logger("qiuqiu_api.app")


def _json_error(status: int, payload: dict[str, str]) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": payload})


def create_app(
    *,
    state: AppState | None = None,
    config: Config | None = None,
    start_scheduler: bool | None = None,
) -> FastAPI:
    """建应用。`state` 传进来就复用（测试用），否则在 lifespan 里自己建自己拆。"""
    configure_logging()
    injected = state

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        own = injected is None
        current = injected or AppState.create(config=config)
        app.state.qiuqiu = current
        current.scheduler = Scheduler(current)
        wanted = current.config.scheduler_enabled if start_scheduler is None else start_scheduler
        if wanted:
            await current.scheduler.start()
        log.info("app.started", version=__version__)
        try:
            yield
        finally:
            await current.scheduler.stop()
            current.scheduler = None
            if own:
                current.close()

    app = FastAPI(
        title="丘丘 · 后端",
        version=__version__,
        description="路由、对话编排、SSE、事件总线出口。接口契约见 docs/CONTRACTS.md § 1。",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # 只监听 127.0.0.1，两个端（Electron 与网页）来源不同
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Trace-Id"],
    )
    app.include_router(api_router)
    _install_error_handlers(app)
    return app


def _install_error_handlers(app: FastAPI) -> None:
    from qiuqiu_memory.errors import MemoryError_
    from qiuqiu_models.base import ModelError

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return _json_error(exc.status, exc.payload())

    @app.exception_handler(ModelError)
    async def _model_error(_request: Request, exc: ModelError) -> JSONResponse:
        status, payload = from_exception(exc)
        return _json_error(status, payload)

    @app.exception_handler(MemoryError_)
    async def _memory_error(_request: Request, exc: MemoryError_) -> JSONResponse:
        status, payload = from_exception(exc)
        return _json_error(status, payload)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        return _json_error(
            422,
            error_payload(
                "api.bad_request",
                _describe(exc.errors()),
                "对照 docs/CONTRACTS.md § 1 检查请求体的字段名与类型。",
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return _json_error(
            exc.status_code,
            error_payload(
                f"api.http_{exc.status_code}",
                str(exc.detail),
                "检查请求方法与路径；全部路由见 docs/CONTRACTS.md § 1。",
            ),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        log.warning("app.unhandled", error=str(exc), exc_info=True)
        status, payload = from_exception(exc)
        return _json_error(status, payload)


def _describe(errors: list[dict[str, Any]]) -> str:
    parts = []
    for item in errors[:5]:
        where = ".".join(str(p) for p in item.get("loc", ()) if p != "body")
        parts.append(f"{where or 'body'}: {item.get('msg')}")
    return "请求体不合法 —— " + "；".join(parts)
