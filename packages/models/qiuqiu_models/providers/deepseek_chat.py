"""Chat · DeepSeek。OpenAI 兼容 ``/chat/completions``，流式与非流式。

模型从 ``DEEPSEEK_CHAT_MODEL`` 读，key 从 ``DEEPSEEK_API_KEY`` 读，base url 从
``DEEPSEEK_BASE_URL`` 读。重试与退避见 ``_deepseek.py``。
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

import httpx

from ..base import Message, ProviderNotConfiguredError, UpstreamError
from ..metrics import measure
from ._deepseek import DeepSeekBase, usage_of

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_MODEL = "deepseek-v4-flash"


class DeepSeekChat(DeepSeekBase):
    """``ChatModel`` 的 DeepSeek 实现。"""

    async def stream(
        self, messages: list[Message], *, temperature: float = 0.7
    ) -> AsyncIterator[str]:
        body = self._body(messages, temperature=temperature, stream=True)

        async def _gen() -> AsyncIterator[str]:
            with measure(stage="chat.stream", provider=self.provider) as m:
                tokens_out = 0
                async for chunk in self._post_sse("/chat/completions", body):
                    tokens_in, out = usage_of(chunk)
                    if tokens_in or out:
                        m.usage(tokens_in or None, out or None)
                    for choice in chunk.get("choices") or ():
                        text = (choice.get("delta") or {}).get("content")
                        if text:
                            tokens_out += len(text)
                            yield text
                if not m.tokens_out:
                    # 上游没回 usage（流式常见），按字符数兜底，指标不留空
                    m.usage(None, tokens_out)

        return _gen()

    async def complete(self, messages: list[Message]) -> str:
        body = self._body(messages, temperature=0.7, stream=False)
        with measure(stage="chat.complete", provider=self.provider) as m:
            payload = await self._post_json("/chat/completions", body)
            m.usage(*usage_of(payload))
            return _first_content(payload, provider=self.provider)

    def _body(self, messages: list[Message], *, temperature: float, stream: bool) -> dict[str, Any]:
        return {
            "model": self.model,
            "messages": [m.to_dict() for m in messages],
            "temperature": temperature,
            "stream": stream,
        }


def _first_content(payload: dict[str, Any], *, provider: str) -> str:
    choices = payload.get("choices") or ()
    if not choices:
        raise UpstreamError(
            "DeepSeek 没有返回任何回复内容。",
            hint="换个说法再试一次；若持续如此，检查模型名是否正确。",
            provider=provider,
        )
    return (choices[0].get("message") or {}).get("content") or ""


def from_env(
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> DeepSeekChat:
    """按环境变量装配。缺 key 抛 ``ProviderNotConfiguredError``，不静默降级（AD-16）。"""

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise ProviderNotConfiguredError(
            "对话模型没配好：缺少 DEEPSEEK_API_KEY。",
            hint="在项目根的 .env 里填上 DEEPSEEK_API_KEY，或设 MODELS_MOCK=1 先用 mock 跑通链路。",
            capability="chat",
            provider="deepseek",
        )
    return DeepSeekChat(
        api_key=api_key,
        base_url=os.environ.get("DEEPSEEK_BASE_URL") or DEFAULT_BASE_URL,
        model=os.environ.get("DEEPSEEK_CHAT_MODEL") or DEFAULT_MODEL,
        transport=transport,
    )
