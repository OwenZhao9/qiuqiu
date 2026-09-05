"""`azure_tts` 的单测。不出网：用 httpx 的 MockTransport 接住请求。

测两件事：发出去的请求形状对不对（Azure 的 REST 接口三个 header 都是必需的），
以及回来的 PCM 有没有被切成固定时长的块、`rms` 算得对不对。
"""

from __future__ import annotations

import array
import math

import httpx
import pytest
from qiuqiu_models import base
from qiuqiu_models.providers import _audio, azure_tts

SAMPLE_RATE = 16000


def tone(samples: int, amplitude: int = 8000) -> bytes:
    """一段正弦，用来验 rms 不是零也没溢出。"""
    data = array.array("h", (int(amplitude * math.sin(i / 8)) for i in range(samples)))
    return data.tobytes()


def client_with(handler) -> azure_tts.AzureTTS:
    tts = azure_tts.AzureTTS("k", "eastasia", voice="zh-CN-XiaoxiaoNeural")
    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    class Patched(original):  # type: ignore[misc, valid-type]
        def __init__(self, *a, **kw):
            kw["transport"] = transport
            super().__init__(*a, **kw)

    httpx.AsyncClient = Patched  # type: ignore[misc]
    tts._restore = lambda: setattr(httpx, "AsyncClient", original)  # type: ignore[attr-defined]
    return tts


class TestRequestShape:
    """Azure 的 REST 接口把 Content-Type、X-Microsoft-OutputFormat、User-Agent
    都列为必需 header，少一个就是 400 或 415。"""

    @pytest.mark.anyio
    async def test_sends_every_required_header_and_ssml_body(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["headers"] = dict(request.headers)
            seen["body"] = request.content.decode("utf-8")
            return httpx.Response(200, content=tone(320))

        tts = client_with(handler)
        try:
            async for _ in await tts.synthesize("你好"):
                pass
        finally:
            tts._restore()  # type: ignore[attr-defined]

        assert seen["url"] == "https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1"
        assert seen["headers"]["ocp-apim-subscription-key"] == "k"
        assert seen["headers"]["content-type"] == "application/ssml+xml"
        assert seen["headers"]["x-microsoft-outputformat"] == "raw-16khz-16bit-mono-pcm"
        assert seen["headers"]["user-agent"]
        assert "zh-CN-XiaoxiaoNeural" in seen["body"]
        assert "你好" in seen["body"]

    def test_ssml_escapes_user_text(self) -> None:
        """用户说的话里带 `<` 或 `&` 会把 XML 弄坏，必须转义。"""
        out = azure_tts.ssml("a < b & c", "zh-CN-XiaoxiaoNeural")
        assert "&lt;" in out and "&amp;" in out
        assert "a < b" not in out

    def test_ssml_language_follows_the_voice(self) -> None:
        assert 'xml:lang="zh-CN"' in azure_tts.ssml("你好", "zh-CN-XiaoxiaoNeural")
        assert 'xml:lang="en-US"' in azure_tts.ssml("hi", "en-US-JennyNeural")


class TestAudioChunking:
    @pytest.mark.anyio
    async def test_repacks_upstream_into_fixed_size_chunks(self) -> None:
        """上游按网络包切，大小忽大忽小；直接透传的话 rms 序列会抖得没法驱动口型。"""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=tone(1600))  # 100ms @16k

        tts = client_with(handler)
        try:
            chunks = [c async for c in await tts.synthesize("你好")]
        finally:
            tts._restore()  # type: ignore[attr-defined]

        expected = _audio.chunk_bytes(SAMPLE_RATE)
        assert len(chunks) == 5, "100ms 的音频按 20ms 切应当是 5 块"
        assert all(c.sample_rate == SAMPLE_RATE for c in chunks)
        assert all(len(c.pcm) == expected for c in chunks)

    @pytest.mark.anyio
    async def test_rms_is_normalised_and_tracks_loudness(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=tone(1600, amplitude=8000))

        tts = client_with(handler)
        try:
            chunks = [c async for c in await tts.synthesize("你好")]
        finally:
            tts._restore()  # type: ignore[attr-defined]

        assert all(0.0 <= c.rms <= 1.0 for c in chunks)
        assert max(c.rms for c in chunks) > 0.1, "有声音的段落 rms 不该接近零"

    def test_silence_is_zero_and_full_scale_is_one(self) -> None:
        assert _audio.rms_of(b"\x00\x00" * 800) == 0.0
        loud = array.array("h", [32767] * 800).tobytes()
        assert _audio.rms_of(loud) == pytest.approx(1.0, abs=0.01)

    def test_odd_trailing_byte_does_not_crash(self) -> None:
        """上游偶尔在流末尾切出半个采样。"""
        assert _audio.rms_of(b"\x00") == 0.0
        assert _audio.rms_of(tone(10) + b"\x01") >= 0.0


class TestErrors:
    @pytest.mark.anyio
    @pytest.mark.parametrize(
        ("status", "keyword"),
        [(401, "AZURE_SPEECH_KEY"), (429, "50 万"), (400, "AZURE_SPEECH_REGION")],
    )
    async def test_upstream_failures_carry_an_actionable_hint(
        self, status: int, keyword: str
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, content=b"nope")

        tts = client_with(handler)
        try:
            with pytest.raises(base.UpstreamError) as excinfo:
                async for _ in await tts.synthesize("你好"):
                    pass
        finally:
            tts._restore()  # type: ignore[attr-defined]
        assert keyword in excinfo.value.hint


class TestConfig:
    def test_missing_either_var_refuses_with_a_hint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
        monkeypatch.delenv("AZURE_SPEECH_REGION", raising=False)
        with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
            azure_tts.from_env()
        assert "F0" in excinfo.value.hint

    def test_voice_is_overridable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AZURE_SPEECH_KEY", "k")
        monkeypatch.setenv("AZURE_SPEECH_REGION", "eastasia")
        monkeypatch.setenv("AZURE_TTS_VOICE", "zh-CN-YunxiNeural")
        assert azure_tts.from_env().voice == "zh-CN-YunxiNeural"

    def test_key_never_leaks_into_the_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AZURE_SPEECH_KEY", "secret")
        monkeypatch.setenv("AZURE_SPEECH_REGION", "eastasia")
        assert "secret" not in azure_tts.from_env().endpoint
