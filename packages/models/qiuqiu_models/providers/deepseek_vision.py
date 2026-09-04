"""Vision · DeepSeek。``describe(image, prompt)`` 返回中文描述。

``image`` 收两种：``bytes``（原图，转 base64 data URL）或 ``str``（http/https URL，
或已经是 ``data:`` URL 就原样用）。模型从 ``DEEPSEEK_VISION_MODEL`` 读。
"""

from __future__ import annotations

import base64
import os
from typing import Any

import httpx

from ..base import ModelError, ProviderNotConfiguredError
from ..metrics import measure
from ._deepseek import DeepSeekBase, usage_of
from .deepseek_chat import DEFAULT_BASE_URL, _first_content

DEFAULT_MODEL = "deepseek-v4-flash-vision-exp"

#: 不给 prompt 时的兜底指令，保证输出中文。
SYSTEM_PROMPT = "你是丘丘的眼睛。用简洁的中文描述图片内容，只说看到的，不要猜测、不要发挥。"

_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
)


class DeepSeekVision(DeepSeekBase):
    """``VisionModel`` 的 DeepSeek 实现。"""

    async def describe(self, image: bytes | str, prompt: str) -> str:
        url = to_image_url(image)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt or "这张图里有什么？"},
                        {"type": "image_url", "image_url": {"url": url}},
                    ],
                },
            ],
            "stream": False,
        }
        with measure(stage="vision.describe", provider=self.provider) as m:
            payload = await self._post_json("/chat/completions", body)
            m.usage(*usage_of(payload))
            return _first_content(payload, provider=self.provider)


def to_image_url(image: bytes | str) -> str:
    """``bytes`` → base64 data URL；``str`` → 校验后原样返回。"""

    if isinstance(image, bytes | bytearray):
        raw = bytes(image)
        if not raw:
            raise ModelError(
                "图片内容是空的。",
                hint="重新截一张图或换一张图片再试。",
                code="model.bad_image",
                capability="vision",
            )
        return f"data:{_mime_of(raw)};base64,{base64.b64encode(raw).decode('ascii')}"
    url = image.strip()
    if url.startswith(("http://", "https://", "data:")):
        return url
    raise ModelError(
        "图片地址不是 http(s) 或 data URL。",
        hint="传图片的原始 bytes，或者一个 http/https 开头的地址。",
        code="model.bad_image",
        capability="vision",
    )


def _mime_of(raw: bytes) -> str:
    for magic, mime in _MAGIC:
        if raw.startswith(magic):
            return mime
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def from_env(
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> DeepSeekVision:
    """按环境变量装配。缺 key 抛 ``ProviderNotConfiguredError``，不静默降级（AD-16）。"""

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise ProviderNotConfiguredError(
            "看图模型没配好：缺少 DEEPSEEK_API_KEY。",
            hint="在项目根的 .env 里填上 DEEPSEEK_API_KEY，或设 MODELS_MOCK=1 先用 mock 跑通链路。",
            capability="vision",
            provider="deepseek",
        )
    return DeepSeekVision(
        api_key=api_key,
        base_url=os.environ.get("DEEPSEEK_BASE_URL") or DEFAULT_BASE_URL,
        model=os.environ.get("DEEPSEEK_VISION_MODEL") or DEFAULT_MODEL,
        transport=transport,
    )
