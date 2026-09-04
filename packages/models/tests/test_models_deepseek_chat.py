"""DeepSeek Chat：mock HTTP，不出网。真实 key 的用例标 live，默认不跑。"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import pytest
from qiuqiu_models import Message, base, metrics, registry
from qiuqiu_models.providers.deepseek_chat import DeepSeekChat, from_env

FAKE_KEY = "sk-fake-key-for-tests-only"


def sse(*chunks: dict[str, Any]) -> str:
    body = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks)
    return body + "data: [DONE]\n\n"


def delta(text: str) -> dict[str, Any]:
    return {"choices": [{"delta": {"content": text}}]}


def build(handler: Any, **kw: Any) -> DeepSeekChat:
    async def no_sleep(_seconds: float) -> None:
        return None

    return DeepSeekChat(
        api_key=FAKE_KEY,
        base_url="https://api.deepseek.example/v1",
        model="deepseek-v4-flash",
        transport=httpx.MockTransport(handler),
        sleep=kw.pop("sleep", no_sleep),
        **kw,
    )


COMPLETION = {
    "choices": [{"message": {"role": "assistant", "content": "你好，我是丘丘。"}}],
    "usage": {"prompt_tokens": 12, "completion_tokens": 7},
}


# ------------------------------------------------------------------ 非流式


async def test_complete_parses_content_and_usage(sink: metrics.InMemoryMetricsSink) -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=COMPLETION)

    chat = build(handler)
    assert await chat.complete([Message(role="user", content="你好")]) == "你好，我是丘丘。"

    assert seen["url"] == "https://api.deepseek.example/v1/chat/completions"
    assert seen["auth"] == f"Bearer {FAKE_KEY}"
    assert seen["body"]["model"] == "deepseek-v4-flash"
    assert seen["body"]["stream"] is False
    assert seen["body"]["messages"] == [{"role": "user", "content": "你好"}]

    m = sink.records[0]
    assert (m.provider, m.stage) == ("deepseek", "chat.complete")
    assert (m.tokens_in, m.tokens_out) == (12, 7)
    await chat.aclose()


async def test_complete_without_choices_raises_with_hint() -> None:
    chat = build(lambda _r: httpx.Response(200, json={"choices": []}))
    with pytest.raises(base.UpstreamError) as excinfo:
        await chat.complete([Message(role="user", content="hi")])
    assert excinfo.value.hint
    await chat.aclose()


# ------------------------------------------------------------------ 流式


async def test_stream_yields_deltas(sink: metrics.InMemoryMetricsSink) -> None:
    body = sse(delta("你"), delta("好"), {"choices": [{"delta": {}}]}, delta("呀"))

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, text=body)

    chat = build(handler)
    out = [d async for d in await chat.stream([Message(role="user", content="嗨")])]
    assert out == ["你", "好", "呀"]

    m = sink.records[0]
    assert (m.provider, m.stage) == ("deepseek", "chat.stream")
    assert m.tokens_out == 3  # 上游没回 usage 时按字符兜底
    await chat.aclose()


async def test_stream_reads_usage_when_upstream_sends_it(
    sink: metrics.InMemoryMetricsSink,
) -> None:
    body = sse(
        delta("好"),
        {"choices": [], "usage": {"prompt_tokens": 30, "completion_tokens": 40}},
    )
    chat = build(lambda _r: httpx.Response(200, text=body))
    assert [d async for d in await chat.stream([Message(role="user", content="嗨")])] == ["好"]
    assert (sink.records[0].tokens_in, sink.records[0].tokens_out) == (30, 40)
    await chat.aclose()


async def test_stream_temperature_is_passed_through() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, text=sse(delta("哦")))

    chat = build(handler)
    async for _ in await chat.stream([Message(role="user", content="嗨")], temperature=0.1):
        pass
    assert seen["temperature"] == 0.1
    await chat.aclose()


# ------------------------------------------------------------------ 重试与退避


async def test_retries_twice_with_1s_and_4s(sink: metrics.InMemoryMetricsSink) -> None:
    calls: list[int] = []
    slept: list[float] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(503, text="upstream busy")
        return httpx.Response(200, json=COMPLETION)

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    chat = build(handler, sleep=fake_sleep)
    assert await chat.complete([Message(role="user", content="嗨")]) == "你好，我是丘丘。"
    assert len(calls) == 3
    assert slept == [1.0, 4.0]
    await chat.aclose()


async def test_gives_up_after_two_retries() -> None:
    calls: list[int] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503, text="still busy")

    chat = build(handler)
    with pytest.raises(base.UpstreamError) as excinfo:
        await chat.complete([Message(role="user", content="嗨")])
    assert len(calls) == 3
    assert excinfo.value.hint
    await chat.aclose()


async def test_429_backs_off_and_reports_rate_limited() -> None:
    calls: list[int] = []
    slept: list[float] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(429, text="rate limited", headers={"retry-after": "2"})

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    chat = build(handler, sleep=fake_sleep)
    with pytest.raises(base.RateLimitedError) as excinfo:
        await chat.complete([Message(role="user", content="嗨")])
    assert len(calls) == 3
    assert slept == [2.0, 2.0]  # 尊重 Retry-After
    assert excinfo.value.to_dict()["error"]["code"] == "model.rate_limited"
    await chat.aclose()


async def test_client_error_is_not_retried() -> None:
    calls: list[int] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401, text="bad key")

    chat = build(handler)
    with pytest.raises(base.UpstreamError):
        await chat.complete([Message(role="user", content="嗨")])
    assert len(calls) == 1
    await chat.aclose()


async def test_timeout_is_retried_then_raises(sink: metrics.InMemoryMetricsSink) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ReadTimeout("too slow", request=request)

    chat = build(handler)
    with pytest.raises(base.TimeoutError_) as excinfo:
        await chat.complete([Message(role="user", content="嗨")])
    assert len(calls) == 3
    assert excinfo.value.hint
    assert sink.records[0].stage == "chat.complete"  # 失败也记指标
    await chat.aclose()


async def test_stream_retries_before_first_token() -> None:
    calls: list[int] = []

    def handler(_r: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, text=sse(delta("好")))

    chat = build(handler)
    assert [d async for d in await chat.stream([Message(role="user", content="嗨")])] == ["好"]
    assert len(calls) == 2
    await chat.aclose()


# ------------------------------------------------------------------ 密钥不外泄


async def test_key_never_appears_in_error_messages() -> None:
    def handler(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text=f"invalid api key {FAKE_KEY}")

    chat = build(handler)
    with pytest.raises(base.UpstreamError) as excinfo:
        await chat.complete([Message(role="user", content="嗨")])
    err = excinfo.value
    assert FAKE_KEY not in str(err)
    assert FAKE_KEY not in err.hint
    assert FAKE_KEY not in json.dumps(err.to_dict(), ensure_ascii=False)
    await chat.aclose()


# ------------------------------------------------------------------ 装配


def test_from_env_builds_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://proxy.example/v1")
    monkeypatch.setenv("DEEPSEEK_CHAT_MODEL", "deepseek-custom")
    chat = from_env()
    assert chat.model == "deepseek-custom"
    assert chat.base_url == "https://proxy.example/v1"
    assert chat.provider == "deepseek"


def test_from_env_without_key_raises_with_hint() -> None:
    with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
        from_env()
    assert "DEEPSEEK_API_KEY" in excinfo.value.hint


def test_registry_returns_deepseek_when_key_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    registry.reset()
    assert isinstance(registry.get("chat"), DeepSeekChat)


# ------------------------------------------------------------------ live


@pytest.mark.live
async def test_live_stream_first_token() -> None:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        pytest.skip("没有 DEEPSEEK_API_KEY")
    chat = from_env()
    try:
        first = None
        async for d in await chat.stream([Message(role="user", content="用一个字回答：好吗")]):
            first = d
            break
        assert first
    finally:
        await chat.aclose()
