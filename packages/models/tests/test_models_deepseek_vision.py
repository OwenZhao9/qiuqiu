"""DeepSeek Vision：mock HTTP，不出网。"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

import httpx
import pytest
from qiuqiu_models import base, metrics, registry
from qiuqiu_models.providers.deepseek_vision import (
    DeepSeekVision,
    from_env,
    to_image_url,
)

FAKE_KEY = "sk-fake-key-for-tests-only"

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 16

REPLY = {
    "choices": [{"message": {"content": "画面里有一只圆圆的丘丘，趴在浅色桌面上。"}}],
    "usage": {"prompt_tokens": 500, "completion_tokens": 20},
}


def build(handler: Any) -> DeepSeekVision:
    async def no_sleep(_seconds: float) -> None:
        return None

    return DeepSeekVision(
        api_key=FAKE_KEY,
        base_url="https://api.deepseek.example/v1",
        model="deepseek-v4-flash-vision-exp",
        transport=httpx.MockTransport(handler),
        sleep=no_sleep,
    )


# ------------------------------------------------------------------ 图片入参


def test_bytes_become_a_base64_data_url() -> None:
    url = to_image_url(PNG)
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == PNG


def test_jpeg_and_webp_mime_detection() -> None:
    assert to_image_url(JPEG).startswith("data:image/jpeg;base64,")
    webp = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 8
    assert to_image_url(webp).startswith("data:image/webp;base64,")


def test_http_url_passes_through() -> None:
    assert to_image_url("https://example.com/a.png") == "https://example.com/a.png"
    assert to_image_url(" http://example.com/b.jpg ") == "http://example.com/b.jpg"


def test_bad_image_input_raises_with_hint() -> None:
    for bad in (b"", "file:///etc/passwd", "just a caption"):
        with pytest.raises(base.ModelError) as excinfo:
            to_image_url(bad)
        assert excinfo.value.hint


# ------------------------------------------------------------------ describe


async def test_describe_sends_image_url_content_block(
    sink: metrics.InMemoryMetricsSink,
) -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=REPLY)

    vision = build(handler)
    out = await vision.describe(PNG, "这是什么？")
    assert "丘丘" in out

    assert seen["url"] == "https://api.deepseek.example/v1/chat/completions"
    body = seen["body"]
    assert body["model"] == "deepseek-v4-flash-vision-exp"
    assert body["stream"] is False
    user = body["messages"][-1]
    assert user["role"] == "user"
    assert user["content"][0] == {"type": "text", "text": "这是什么？"}
    assert user["content"][1]["type"] == "image_url"
    assert user["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")

    m = sink.records[0]
    assert (m.provider, m.stage) == ("deepseek", "vision.describe")
    assert (m.tokens_in, m.tokens_out) == (500, 20)
    await vision.aclose()


async def test_describe_accepts_a_url() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=REPLY)

    vision = build(handler)
    await vision.describe("https://example.com/a.png", "看看这个")
    url = seen["body"]["messages"][-1]["content"][1]["image_url"]["url"]
    assert url == "https://example.com/a.png"
    await vision.aclose()


async def test_empty_prompt_falls_back_to_a_default_question() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=REPLY)

    vision = build(handler)
    await vision.describe(PNG, "")
    assert seen["body"]["messages"][-1]["content"][0]["text"]
    assert seen["body"]["messages"][0]["role"] == "system"
    await vision.aclose()


async def test_upstream_failure_raises_with_hint() -> None:
    vision = build(lambda _r: httpx.Response(500, text="boom"))
    with pytest.raises(base.UpstreamError) as excinfo:
        await vision.describe(PNG, "看看")
    assert excinfo.value.hint
    assert FAKE_KEY not in str(excinfo.value)
    await vision.aclose()


# ------------------------------------------------------------------ 装配


def test_from_env_reads_the_vision_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    monkeypatch.setenv("DEEPSEEK_VISION_MODEL", "vision-custom")
    assert from_env().model == "vision-custom"


def test_from_env_without_key_raises_with_hint() -> None:
    with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
        from_env()
    assert "DEEPSEEK_API_KEY" in excinfo.value.hint


def test_registry_returns_deepseek_vision(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    registry.reset()
    assert isinstance(registry.get("vision"), DeepSeekVision)


# ------------------------------------------------------------------ live


@pytest.mark.live
async def test_live_describe() -> None:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        pytest.skip("没有 DEEPSEEK_API_KEY")
    vision = from_env()
    try:
        assert await vision.describe(PNG, "这是什么？")
    finally:
        await vision.aclose()
