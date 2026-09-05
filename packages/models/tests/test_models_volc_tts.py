"""`volc_tts` 的单测。不出网：用 httpx 的 MockTransport 接住请求。

重点钉两件事：**接口版本**和**鉴权头**。踩过的坑是 1.0 的 `/api/v1/tts` 加 `cluster`
在 2.0 上一律 403，而方舟的 ark key 在语音接口上不认——两套凭证各管各的。
"""

from __future__ import annotations

import array
import base64
import json
import math

import httpx
import pytest
from qiuqiu_models import base
from qiuqiu_models.providers import _audio, volc_tts

SAMPLE_RATE = 16000


def tone(samples: int, amplitude: int = 8000) -> bytes:
    data = array.array("h", (int(amplitude * math.sin(i / 8)) for i in range(samples)))
    return data.tobytes()


def stream_body(*pcm_parts: bytes) -> bytes:
    """按真实响应造：一行一个 JSON，`data` 是 base64 PCM，最后一行是无 data 的事件行。"""
    lines = [
        json.dumps({"code": 0, "message": "", "data": base64.b64encode(p).decode()})
        for p in pcm_parts
    ]
    lines.append(json.dumps({"code": 0, "message": ""}))
    return "\n".join(lines).encode()


def client_with(handler) -> volc_tts.VolcTTS:
    tts = volc_tts.VolcTTS("2040315767", "tok", speaker="zh_female_gaolengyujie_uranus_bigtts")
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
    @pytest.mark.anyio
    async def test_hits_v3_unidirectional_with_the_2_0_resource_id(self) -> None:
        """2.0 只认 v3 加 `X-Api-Resource-Id: seed-tts-2.0`；发去 v1 是 403。"""
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["headers"] = dict(request.headers)
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, content=stream_body(tone(320)))

        tts = client_with(handler)
        try:
            async for _ in await tts.synthesize("你好"):
                pass
        finally:
            tts._restore()  # type: ignore[attr-defined]

        assert seen["url"] == "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
        assert "/api/v1/" not in seen["url"]
        assert seen["headers"]["x-api-resource-id"] == "seed-tts-2.0"

    @pytest.mark.anyio
    async def test_uses_appid_and_access_key_not_a_bearer_token(self) -> None:
        """方舟的 ark key 在这个接口上返回 401，凭证只能来自豆包语音控制台。"""
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["headers"] = dict(request.headers)
            return httpx.Response(200, content=stream_body(tone(320)))

        tts = client_with(handler)
        try:
            async for _ in await tts.synthesize("你好"):
                pass
        finally:
            tts._restore()  # type: ignore[attr-defined]

        assert seen["headers"]["x-api-app-key"] == "2040315767"
        assert seen["headers"]["x-api-access-key"] == "tok"
        assert "authorization" not in seen["headers"]

    @pytest.mark.anyio
    async def test_asks_for_raw_pcm_at_the_contract_sample_rate(self) -> None:
        """要 pcm 不要 mp3：`AudioChunk` 直接就是裸 PCM，不引解码器。"""
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, content=stream_body(tone(320)))

        tts = client_with(handler)
        try:
            async for _ in await tts.synthesize("你好"):
                pass
        finally:
            tts._restore()  # type: ignore[attr-defined]

        audio = seen["body"]["req_params"]["audio_params"]
        assert audio == {"format": "pcm", "sample_rate": SAMPLE_RATE}

    @pytest.mark.anyio
    async def test_voice_argument_overrides_the_default_speaker(self) -> None:
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, content=stream_body(tone(320)))

        tts = client_with(handler)
        try:
            async for _ in await tts.synthesize("你好", voice="zh_male_test"):
                pass
        finally:
            tts._restore()  # type: ignore[attr-defined]

        assert seen["body"]["req_params"]["speaker"] == "zh_male_test"


class TestStreamDecoding:
    @pytest.mark.anyio
    async def test_joins_multiple_lines_into_one_continuous_stream(self) -> None:
        """响应是一行一个 JSON，音频要拼起来再按 20ms 重切。"""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=stream_body(tone(800), tone(800)))

        tts = client_with(handler)
        try:
            chunks = [c async for c in await tts.synthesize("你好")]
        finally:
            tts._restore()  # type: ignore[attr-defined]

        size = _audio.chunk_bytes(SAMPLE_RATE)
        assert sum(len(c.pcm) for c in chunks) == 1600 * 2
        assert all(len(c.pcm) == size for c in chunks)
        assert all(0.0 <= c.rms <= 1.0 for c in chunks)
        assert max(c.rms for c in chunks) > 0.1

    @pytest.mark.anyio
    async def test_event_lines_without_audio_are_skipped(self) -> None:
        """最后一行是无 `data` 的事件行，不能把它当音频。"""

        def handler(request: httpx.Request) -> httpx.Response:
            body = (
                json.dumps({"code": 0, "message": ""})
                + "\n"
                + json.dumps({"code": 0, "data": base64.b64encode(tone(320)).decode()})
                + "\n"
                + json.dumps({"code": 0, "message": ""})
            ).encode()
            return httpx.Response(200, content=body)

        tts = client_with(handler)
        try:
            chunks = [c async for c in await tts.synthesize("你好")]
        finally:
            tts._restore()  # type: ignore[attr-defined]

        assert sum(len(c.pcm) for c in chunks) == 320 * 2

    @pytest.mark.anyio
    @pytest.mark.parametrize("code", [0, 20000000])
    async def test_both_success_codes_are_accepted(self, code: int) -> None:
        """`20000000`（message 是 "OK"）也是成功码。

        只认 0 的话正常响应会被当成错误——实测十个音色全报「错误码 20000000：OK」。
        """
        import base64 as _b64

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.dumps(
                {"code": code, "message": "OK", "data": _b64.b64encode(tone(320)).decode()}
            ).encode()
            return httpx.Response(200, content=body)

        tts = client_with(handler)
        try:
            chunks = [c async for c in await tts.synthesize("你好")]
        finally:
            tts._restore()  # type: ignore[attr-defined]
        assert sum(len(c.pcm) for c in chunks) == 320 * 2

    @pytest.mark.anyio
    async def test_a_nonzero_code_mid_stream_raises_with_a_hint(self) -> None:
        """额度用完是在流中间报的，不是 HTTP 错误码。"""

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.dumps({"code": 3001, "message": "quota exceeded"}).encode()
            return httpx.Response(200, content=body)

        tts = client_with(handler)
        try:
            with pytest.raises(base.UpstreamError) as excinfo:
                async for _ in await tts.synthesize("你好"):
                    pass
        finally:
            tts._restore()  # type: ignore[attr-defined]
        assert "额度" in excinfo.value.hint


class TestErrors:
    @pytest.mark.anyio
    @pytest.mark.parametrize(
        ("status", "keyword"),
        [(403, "ark key"), (401, "VOLC_SPEECH_APPID"), (429, "并发"), (500, "v3")],
    )
    async def test_http_failures_carry_an_actionable_hint(self, status: int, keyword: str) -> None:
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
    def test_missing_either_var_refuses_and_names_both_paths(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("VOLC_SPEECH_APPID", raising=False)
        monkeypatch.delenv("VOLC_SPEECH_TOKEN", raising=False)
        with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
            volc_tts.from_env()
        hint = excinfo.value.hint
        assert "VOLC_SPEECH_APPID" in hint
        assert "TTS_PROVIDER=azure" in hint

    def test_speaker_is_overridable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("VOLC_SPEECH_APPID", "1")
        monkeypatch.setenv("VOLC_SPEECH_TOKEN", "t")
        monkeypatch.setenv("VOLC_TTS_SPEAKER", "zh_male_custom")
        assert volc_tts.from_env().speaker == "zh_male_custom"
