"""HTTP / SSE / WebSocket 三处共用的错误体。

CONTRACTS § 1 只定了一种形状：``{"error": {"code", "message", "hint"}}``，``hint`` 必填。
ARCHITECTURE § 7 把这条推到 SSE 的 `error` 事件与 WebSocket 的 `error` 帧上，所以本模块
产出的是**裸的三元组**（`error_payload`），外面套不套 `{"error": ...}` 由通道决定：
HTTP 套，SSE 与 WS 不套（契约里那两处的 data 就是三元组本身）。

上游两层的异常自己就带 `hint`：`qiuqiu_models.ModelError.to_dict()` 给的是套好的
`{"error": {...}}`，`qiuqiu_memory.MemoryError_.to_dict()` 给的是裸三元组。
`from_exception()` 把这两种和本层的 `ApiError` 归一成一种。
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "ApiError",
    "BadRequest",
    "CapabilityUnavailable",
    "NotFound",
    "UpstreamFailed",
    "error_payload",
    "from_exception",
]


def error_payload(code: str, message: str, hint: str) -> dict[str, str]:
    """裸三元组。SSE `error` 事件与 WS `error` 帧直接用它。"""
    return {"code": code, "message": message, "hint": hint}


class ApiError(Exception):
    """后端自己抛的错。**构造时必须给 hint**，说明下一步能做什么。"""

    code = "api.error"
    status = 400

    def __init__(
        self,
        message: str,
        *,
        hint: str,
        code: str | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status

    def payload(self) -> dict[str, str]:
        return error_payload(self.code, self.message, self.hint)

    def body(self) -> dict[str, Any]:
        return {"error": self.payload()}


class BadRequest(ApiError):
    code = "api.bad_request"
    status = 400


class NotFound(ApiError):
    code = "api.not_found"
    status = 404


class CapabilityUnavailable(ApiError):
    """能力没接上（M5 才接的 ASR / VAD / TTS / RealtimeVoice，或缺 key）。

    **不静默换 mock**（AD-16）：把上游的 hint 原样带出去，用户才知道下一步做什么。
    """

    code = "api.capability_unavailable"
    status = 503


class UpstreamFailed(ApiError):
    """出网调用失败，重试完仍不行（ARCHITECTURE § 3）。"""

    code = "api.upstream_failed"
    status = 502


def from_exception(exc: BaseException) -> tuple[int, dict[str, str]]:
    """任意异常 → `(HTTP 状态码, 裸三元组)`。

    认三种来源：本层的 `ApiError`、模型层的 `ModelError`、记忆层的 `MemoryError_`。
    都不是的话给一条兜底的，仍然带 hint——「所有错误响应带 hint」没有例外。
    """
    if isinstance(exc, ApiError):
        return exc.status, exc.payload()

    payload = getattr(exc, "to_dict", None)
    hint = getattr(exc, "hint", None)
    if callable(payload) and hint:
        body = payload()
        inner = body.get("error", body) if isinstance(body, dict) else {}
        code = str(inner.get("code") or "upstream.error")
        message = str(inner.get("message") or str(exc))
        return _status_for(code), error_payload(code, message, str(hint))

    return 500, error_payload(
        "api.internal_error",
        str(exc) or exc.__class__.__name__,
        "这是后端没预料到的错误，重试一次；仍然失败就看服务端日志里同一条 trace_id。",
    )


#: 上游错误码 → HTTP 状态码。没列到的按 502 算（出网这一路），除非是契约违规。
_STATUS: dict[str, int] = {
    "model.unknown_capability": 400,
    "model.provider_not_configured": 503,
    "model.rate_limited": 429,
    "model.timeout": 504,
    "model.upstream_error": 502,
    "model.error": 502,
    "contract_violation": 400,
    "visible_memory_not_found": 404,
    "embedding_unavailable": 503,
    "chat_unavailable": 502,
    "memory_error": 500,
}


def _status_for(code: str) -> int:
    return _STATUS.get(code, 502)
