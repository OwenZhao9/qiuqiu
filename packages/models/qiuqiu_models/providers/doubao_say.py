"""把「端到端实时语音」当语音合成用。

**为什么不是 `volc_tts`。** 豆包这两个语音服务的配额是分开的：

- 语音合成（`seed-tts-2.0`，`volc_tts.py` 走的那条）有一个 **`text_words_lifetime`
  终身免费字数**。用完就报 45000292，**给账户充值解不开**——额度绑在资源上不是绑在
  余额上；换 `volc.service_type.10029` 等别的资源 ID 一律 403 未授权（要另外开通）。
- 端到端实时语音（`volc.speech.dialog`）是另一套配额，凭证相同，而且协议里
  `SayHello` 事件的作用正好是「把这段文本念出来」。

所以合成走不动的时候，这条还走得动，念出来还是同一个音色家族。实测语音合成
额度耗尽后，这条依然正常出音频。

**代价**：一句话一个 WebSocket 会话，比 HTTP 流式多一次握手（实测多半秒上下），
下行 24k（比 `seed-tts-2.0` 的 16k 还高一档）。对话是一轮一句，这点开销可以接受。

**它不负责对话**。虽然底层是对话接口，这里只发 `SayHello` 拿音频，
不建立对话上下文、不读人格、不收 ASR。真正的实时通话仍然走 `doubao_realtime.py`。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

from ..base import AudioChunk, ProviderNotConfiguredError, UpstreamError
from ..metrics import measure
from . import _audio
from . import _volc_protocol as proto
from .doubao_realtime import APP_KEY, ENDPOINT, MAX_FRAME_BYTES, OUTPUT_SAMPLE_RATE, RESOURCE_ID

#: 等一句话念完最多等多久。一句回复通常十几秒，留足余量。
TIMEOUT_S = 90.0

DEFAULT_SPEAKER = "zh_female_vv_jupiter_bigtts"


class DoubaoSay:
    """`SayHello` 版的 TTS。签名与 `volc_tts.VolcTTS.synthesize` 一致。"""

    def __init__(self, *, appid: str, token: str, speaker: str = DEFAULT_SPEAKER) -> None:
        self._appid = appid
        self._token = token
        self.speaker = speaker

    @property
    def provider(self) -> str:
        return "volcengine"

    async def synthesize(self, text: str, *, voice: str | None = None) -> AsyncIterator[AudioChunk]:
        """念一段话。返回异步迭代器（不是 async generator），与契约 § 4 一致。"""
        speaker = voice or self.speaker

        async def _gen() -> AsyncIterator[AudioChunk]:
            with measure(stage="tts.synthesize", provider=self.provider) as m:
                m.usage(len(text), None)
                async for pcm, rms in _audio.chunks_from(
                    self._frames(text, speaker), sample_rate=OUTPUT_SAMPLE_RATE
                ):
                    yield AudioChunk(pcm=pcm, rms=rms, sample_rate=OUTPUT_SAMPLE_RATE)

        return _gen()

    async def _frames(self, text: str, speaker: str) -> AsyncIterator[bytes]:
        import websockets

        headers = {
            "X-Api-App-ID": self._appid,
            "X-Api-Access-Key": self._token,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-App-Key": APP_KEY,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        try:
            ws = await websockets.connect(
                ENDPOINT, additional_headers=headers, max_size=MAX_FRAME_BYTES
            )
        except Exception as exc:  # noqa: BLE001 - 握手失败形态多，统一成带 hint 的错
            raise UpstreamError(
                f"连不上豆包实时语音（当合成用）：{exc}",
                hint=(
                    "确认 VOLC_SPEECH_APPID / VOLC_SPEECH_TOKEN 正确，"
                    "且这个应用勾了「豆包端到端实时语音大模型」。"
                ),
                provider=self.provider,
            ) from exc

        async with ws:

            async def send(event: proto.Event, payload: Any, session_id: str | None = None) -> None:
                await ws.send(proto.encode(event, payload=payload, session_id=session_id))

            async def recv() -> Any:
                return proto.decode(await asyncio.wait_for(ws.recv(), timeout=TIMEOUT_S))

            await send(proto.Event.START_CONNECTION, {})
            await recv()

            session_id = str(uuid.uuid4())
            await send(proto.Event.START_SESSION, _session_config(speaker), session_id)
            await recv()

            await send(proto.Event.SAY_HELLO, {"content": text}, session_id)
            while True:
                frame = await recv()
                if frame.event == proto.Event.TTS_RESPONSE and isinstance(frame.payload, bytes):
                    yield frame.payload
                elif frame.event == proto.Event.TTS_ENDED:
                    break
                elif frame.event in (proto.Event.SESSION_FAILED, proto.Event.DIALOG_ERROR):
                    raise UpstreamError(
                        f"豆包实时语音合成失败：{frame.payload!r}",
                        hint="换个音色试试；持续失败就看控制台里这个应用的实时语音额度。",
                        provider=self.provider,
                    )
            await send(proto.Event.FINISH_SESSION, {}, session_id)


def _session_config(speaker: str) -> dict[str, Any]:
    """只为拿音频，所以 ASR 与人格都给最小可用值——服务端要求这些字段存在。"""
    return {
        "asr": {
            "audio_info": {"format": "pcm", "sample_rate": 16000, "channel": 1},
            # `extra` 为空会报 42000020，必须给个对象
            "extra": {"end_smooth_window_ms": 1500},
        },
        "dialog": {
            "bot_name": "丘丘",
            "system_role": "",
            "dialog_id": "",
            "extra": {"input_mod": "keep_alive", "strict_audit": False},
        },
        "tts": {
            "speaker": speaker,
            # 要 `pcm_s16le` 不要 `pcm`：后者是 32 位浮点
            "audio_config": {
                "channel": 1,
                "format": "pcm_s16le",
                "sample_rate": OUTPUT_SAMPLE_RATE,
            },
            "extra": {},
        },
    }


def from_env() -> DoubaoSay:
    appid = os.environ.get("VOLC_SPEECH_APPID", "").strip()
    token = os.environ.get("VOLC_SPEECH_TOKEN", "").strip()
    if not appid or not token:
        raise ProviderNotConfiguredError(
            "豆包语音没配好：缺少 VOLC_SPEECH_APPID 或 VOLC_SPEECH_TOKEN。",
            hint=(
                "去豆包语音控制台拿 VOLC_SPEECH_APPID 与 VOLC_SPEECH_TOKEN 填进 .env。"
                "注意与方舟的 ark key 不是一套凭证。"
            ),
            capability="tts",
            provider="volcengine",
        )
    speaker = os.environ.get("DOUBAO_REALTIME_SPEAKER", "").strip() or DEFAULT_SPEAKER
    return DoubaoSay(appid=appid, token=token, speaker=speaker)
