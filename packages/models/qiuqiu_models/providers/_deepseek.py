"""DeepSeek 两个供应商共用的 HTTP 底座（OpenAI 兼容 ``/chat/completions``）。

统一处理：超时、重试 2 次（间隔 1s、4s）、429 退避、SSE 解析、``usage`` 计量、
错误脱敏。**key 只从环境变量读，不进日志、不进异常消息**——``_redact()`` 是最后一道兜底。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import httpx

from ..base import RateLimitedError, TimeoutError_, UpstreamError

#: 重试间隔，秒。长度即重试次数（首次调用之外再试 2 次）。
RETRY_DELAYS: tuple[float, ...] = (1.0, 4.0)

#: 默认超时。连接快，读慢（等首字）。
DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)

_RETRY_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})

_BODY_SNIPPET = 200


class DeepSeekBase:
    """持有 client、重试与请求执行。子类只管拼 body 与解析结果。"""

    #: 出错 hint 里提示改哪个环境变量
    key_env = "DEEPSEEK_API_KEY"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout: httpx.Timeout | float | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self._api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._timeout = timeout if timeout is not None else DEFAULT_TIMEOUT
        self._transport = transport
        self._sleep = sleep or asyncio.sleep
        self._client: httpx.AsyncClient | None = None

    # ---------------------------------------------------------------- 基础设施

    @property
    def provider(self) -> str:
        return "deepseek"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self._timeout,
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _redact(self, text: str) -> str:
        """兜底：任何要外发的字符串里都不能出现 key。"""

        if self._api_key and self._api_key in text:
            text = text.replace(self._api_key, "***")
        return text

    def _fail(self, status: int, body: str) -> UpstreamError:
        snippet = self._redact(body.strip()[:_BODY_SNIPPET])
        if status == 429:
            return RateLimitedError(
                f"DeepSeek 限流（HTTP 429）：{snippet}",
                hint="等一会儿再说，或去设置里换一个供应商 / 提高配额。",
                provider=self.provider,
            )
        return UpstreamError(
            f"DeepSeek 调用失败（HTTP {status}）：{snippet}",
            hint=f"检查网络与 {self.key_env} 是否有效，稍后重试；也可以先用文字继续聊。",
            provider=self.provider,
        )

    def _timeout_error(self) -> TimeoutError_:
        return TimeoutError_(
            "DeepSeek 调用超时。",
            hint="检查网络连通性，或稍后重试。",
            provider=self.provider,
        )

    @staticmethod
    def _retry_after(response: httpx.Response, fallback: float) -> float:
        raw = response.headers.get("retry-after")
        if not raw:
            return fallback
        try:
            return max(0.0, min(30.0, float(raw)))
        except ValueError:
            return fallback

    # ---------------------------------------------------------------- 非流式

    async def _post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        """带重试的一次性 POST，返回解析后的 JSON。"""

        last: Exception | None = None
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                response = await self.client().post(path, json=body, headers=self._headers())
            except httpx.TimeoutException:
                last = self._timeout_error()
            except httpx.HTTPError as exc:
                last = UpstreamError(
                    f"DeepSeek 连接失败：{self._redact(type(exc).__name__)}",
                    hint="检查网络连通性，稍后重试；也可以先用文字继续聊。",
                    provider=self.provider,
                )
            else:
                if response.status_code < 400:
                    try:
                        return response.json()
                    except json.JSONDecodeError:
                        raise UpstreamError(
                            "DeepSeek 返回的不是合法 JSON。",
                            hint="多半是网关或代理改写了响应，检查 DEEPSEEK_BASE_URL。",
                            provider=self.provider,
                        ) from None
                error = self._fail(response.status_code, response.text)
                if response.status_code not in _RETRY_STATUS:
                    raise error
                last = error
                if attempt < len(RETRY_DELAYS) and response.status_code == 429:
                    await self._sleep(self._retry_after(response, RETRY_DELAYS[attempt]))
                    continue
            if attempt < len(RETRY_DELAYS):
                await self._sleep(RETRY_DELAYS[attempt])
        assert last is not None
        raise last

    # ---------------------------------------------------------------- 流式

    async def _post_sse(self, path: str, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        """带重试的流式 POST，产出每个 SSE ``data`` 的 JSON。

        只在**首个 chunk 之前**重试；已经吐字了再断，直接抛错，免得重复内容。
        """

        last: Exception | None = None
        for attempt in range(len(RETRY_DELAYS) + 1):
            started = False
            try:
                async with self.client().stream(
                    "POST", path, json=body, headers=self._headers()
                ) as response:
                    if response.status_code >= 400:
                        raw = (await response.aread()).decode("utf-8", "replace")
                        error = self._fail(response.status_code, raw)
                        if response.status_code not in _RETRY_STATUS:
                            raise error
                        last = error
                        if attempt < len(RETRY_DELAYS):
                            delay = (
                                self._retry_after(response, RETRY_DELAYS[attempt])
                                if response.status_code == 429
                                else RETRY_DELAYS[attempt]
                            )
                            await self._sleep(delay)
                        continue
                    async for line in response.aiter_lines():
                        payload = _sse_data(line)
                        if payload is None:
                            continue
                        if payload == "[DONE]":
                            return
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        started = True
                        yield chunk
                    return
            except httpx.TimeoutException:
                if started:
                    raise self._timeout_error() from None
                last = self._timeout_error()
            except httpx.HTTPError as exc:
                error = UpstreamError(
                    f"DeepSeek 流中断：{self._redact(type(exc).__name__)}",
                    hint="检查网络连通性，稍后重试；也可以先用文字继续聊。",
                    provider=self.provider,
                )
                if started:
                    raise error from None
                last = error
            if attempt < len(RETRY_DELAYS):
                await self._sleep(RETRY_DELAYS[attempt])
        assert last is not None
        raise last


def _sse_data(line: str) -> str | None:
    """从一行 SSE 里取 ``data:`` 后面的内容，其余行返回 None。"""

    line = line.strip()
    if not line or not line.startswith("data:"):
        return None
    return line[len("data:") :].strip()


def usage_of(payload: dict[str, Any]) -> tuple[int, int]:
    """从 OpenAI 兼容响应里取 ``(prompt_tokens, completion_tokens)``，缺就当 0。"""

    usage = payload.get("usage") or {}
    return int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0)
