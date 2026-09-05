"""RealtimeVoice · 豆包端到端实时语音大模型。

音频直进直出：用户的 PCM 推上去，模型的语音流下来，中间不经过「转文字 → 调对话
模型 → 再合成」三段，所以延迟是几百毫秒而不是两三秒，而且**能打断**——用户一开口，
服务端发 `ASRInfo`，客户端立刻停播。

同时下发两路转写（`ASRResponse` 是用户说的，`ChatResponse` 是模型说的），记忆中间件
照常拿文本写入，不感知这条链路和级联链路的差异（AD-13）。

配置：

- `VOLC_SPEECH_APPID` / `VOLC_SPEECH_TOKEN` —— 与 TTS 同一套凭证
- `DOUBAO_REALTIME_MODEL` —— 模型版本，缺省 `1.2.1.1`（O2.0，多模态路线）
- `DOUBAO_REALTIME_SPEAKER` —— 音色，缺省 `zh_female_vv_jupiter_bigtts`

**两个坑**：

1. 输出音频默认是 OGG 封装的 Opus，得在 `StartSession` 里显式要 `pcm_s16le`
   才拿得到 16 位裸 PCM。要成 `pcm` 会得到 32 位浮点，喂给 `AudioChunk` 是错的。
2. 上行采样率固定 16k，下行固定 24k，两头不一样。`AudioChunk.sample_rate`
   报的是下行的 24k。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import websockets

from .. import voices
from ..base import ProviderNotConfiguredError, RealtimeEvent, UpstreamError
from ..metrics import measure
from . import _volc_protocol as proto

ENDPOINT = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"
RESOURCE_ID = "volc.speech.dialog"
#: 文档写死的固定值，不是用户的 key。
APP_KEY = "PlgvMymc7f3tQnJ6"

DEFAULT_MODEL = "1.2.1.1"  # O2.0
#: 缺省音色从音色目录取，与级联链路共用同一份表。
DEFAULT_SPEAKER = voices.realtime_id(voices.DEFAULT_VOICE)
INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
MAX_FRAME_BYTES = 10 * 1024 * 1024


def is_character_route(model: str) -> bool:
    """SC（Strong Character，角色扮演）路线的版本号以 2 开头，O（Omni）路线以 1 开头。"""
    return model.strip().startswith("2")


class DoubaoRealtime:
    """`RealtimeVoice` 协议的豆包实现。一次会话一个连接。"""

    provider = "doubao"

    def __init__(
        self,
        appid: str,
        token: str,
        *,
        model: str = DEFAULT_MODEL,
        speaker: str = DEFAULT_SPEAKER,
    ) -> None:
        self.appid = appid
        self.token = token
        self.model = model
        self.speaker = speaker
        self._ws: Any = None
        self._session_id: str | None = None
        self._measure: Any = None

    # ------------------------------------------------------------------ 连接

    async def open(self, *, system_prompt: str = "", voice: str | None = None) -> None:
        headers = {
            "X-Api-App-ID": self.appid,
            "X-Api-Access-Key": self.token,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-App-Key": APP_KEY,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        try:
            self._ws = await websockets.connect(
                ENDPOINT, additional_headers=headers, max_size=MAX_FRAME_BYTES
            )
        except Exception as exc:  # noqa: BLE001 - 握手失败的形态很多，统一成带 hint 的错
            raise UpstreamError(
                f"连不上豆包实时语音：{exc}",
                hint=(
                    "确认 VOLC_SPEECH_APPID 与 VOLC_SPEECH_TOKEN 正确，"
                    "且豆包语音控制台里这个应用勾了「豆包端到端实时语音大模型」。"
                ),
                provider=self.provider,
            ) from exc

        self._measure = measure(stage="realtime.session", provider=self.provider)
        self._measure.__enter__()

        await self._send(proto.Event.START_CONNECTION, payload={})
        await self._expect(proto.Event.CONNECTION_STARTED, "建立连接")

        self._session_id = str(uuid.uuid4())
        await self._send(
            proto.Event.START_SESSION,
            payload=self._session_config(system_prompt, voice or self.speaker),
            session_id=self._session_id,
        )
        await self._expect(proto.Event.SESSION_STARTED, "启动会话")

    def _session_config(self, system_prompt: str, speaker: str) -> dict[str, Any]:
        """`StartSession` 的配置。人格与召回都从 `system_role` 进去。"""
        return {
            "asr": {
                "audio_info": {
                    "format": "pcm",
                    "sample_rate": INPUT_SAMPLE_RATE,
                    "channel": 1,
                },
                # `extra` 置空会报 42000020，必须给个对象
                "extra": {"end_smooth_window_ms": 1500},
            },
            "dialog": {
                "bot_name": "丘丘",
                # **人设字段随模型路线换**：O 路线读 `system_role`，SC（角色扮演）路线
                # 只读 `character_manifest`。写错了不会报错，模型会安静地用服务端预设的
                # 角色——实测 SC2.0 下自称「夏栀」「姜书昀」，人格层就整个丢了。
                **(
                    {"character_manifest": system_prompt}
                    if is_character_route(self.model)
                    else {"system_role": system_prompt}
                ),
                "dialog_id": "",
                "extra": {
                    "model": self.model,
                    "input_mod": "keep_alive",  # 麦克风静音时不报音频流超时
                    "strict_audit": False,
                },
            },
            "tts": {
                "speaker": speaker,
                "audio_config": {
                    "channel": 1,
                    # 要 `pcm_s16le` 不要 `pcm`：后者是 32 位浮点
                    "format": "pcm_s16le",
                    "sample_rate": OUTPUT_SAMPLE_RATE,
                },
                "extra": {},  # 同样不能为空
            },
        }

    # ------------------------------------------------------------------ 收发

    async def send(self, pcm16k: bytes) -> None:
        """推一包用户音频。文档建议 20ms 一包，16k int16 下就是 640 字节。"""
        await self._send(proto.Event.TASK_REQUEST, payload=pcm16k, session_id=self._session_id)

    async def say(self, text: str) -> None:
        """用文本发起一轮，替代音频输入。场景回放与自动化测试用得上。"""
        await self._send(
            proto.Event.CHAT_TEXT_QUERY, payload={"content": text}, session_id=self._session_id
        )

    async def interrupt(self) -> None:
        """用户开口打断。服务端在 server_vad 模式下自己会判，这里只结束当前会话轮次。"""
        if self._session_id:
            await self._send(proto.Event.FINISH_SESSION, payload={}, session_id=self._session_id)

    async def events(self) -> AsyncIterator[RealtimeEvent]:
        """把服务端事件翻成契约 § 4 的三类：`audio` / `transcript` / `turn_end`。"""
        if self._ws is None:
            raise RuntimeError("还没 open()")
        async for raw in self._ws:
            if not isinstance(raw, bytes | bytearray):
                continue
            frame = proto.decode(bytes(raw))
            for event in _translate(frame):
                yield event
            if frame.event in (proto.Event.SESSION_FINISHED, proto.Event.CONNECTION_FINISHED):
                return

    async def close(self) -> None:
        if self._ws is None:
            return
        try:
            if self._session_id:
                await self._send(
                    proto.Event.FINISH_SESSION, payload={}, session_id=self._session_id
                )
            await self._send(proto.Event.FINISH_CONNECTION, payload={})
        except Exception:  # noqa: BLE001 - 收尾尽力而为，连接可能已经断了
            pass
        finally:
            with_ws, self._ws = self._ws, None
            await with_ws.close()
            if self._measure is not None:
                self._measure.__exit__(None, None, None)
                self._measure = None

    # ------------------------------------------------------------------ 内部

    async def _send(
        self,
        event: proto.Event,
        *,
        payload: bytes | dict[str, Any],
        session_id: str | None = None,
    ) -> None:
        if self._ws is None:
            raise RuntimeError("还没 open()")
        await self._ws.send(proto.encode(event, payload=payload, session_id=session_id))

    async def _expect(self, want: proto.Event, what: str) -> proto.Frame:
        """等一个确认事件。失败或超时都抛带 hint 的错。"""
        try:
            raw = await asyncio.wait_for(self._ws.recv(), timeout=15)
        except TimeoutError as exc:
            raise UpstreamError(
                f"{what}超时：15 秒没等到 {want.name}。",
                hint="检查网络，以及控制台里端到端实时语音的额度是否用尽。",
                provider=self.provider,
            ) from exc
        frame = proto.decode(bytes(raw))
        if frame.event != want:
            detail = frame.json_payload.get("error") or frame.json_payload.get("message") or ""
            raise UpstreamError(
                f"{what}失败：收到 {getattr(frame.event, 'name', frame.event)}。{detail}",
                hint=_hint_for(frame),
                provider=self.provider,
            )
        return frame


def _translate(frame: proto.Frame) -> list[RealtimeEvent]:
    """一个服务端帧 → 零到多个契约事件。"""
    event = frame.event
    payload = frame.json_payload

    if event == proto.Event.TTS_RESPONSE and frame.payload:
        from . import _audio

        return [
            RealtimeEvent(
                type="audio",
                pcm=frame.payload,
                rms=_audio.rms_of(frame.payload),
                sample_rate=OUTPUT_SAMPLE_RATE,
            )
        ]

    if event == proto.Event.ASR_RESPONSE:
        out: list[RealtimeEvent] = []
        for item in payload.get("results") or ():
            text = (item or {}).get("text") or ""
            if text:
                out.append(
                    RealtimeEvent(
                        type="transcript",
                        role="user",
                        text=text,
                        final=not (item or {}).get("is_interim", False),
                    )
                )
        return out

    if event == proto.Event.CHAT_RESPONSE:
        text = payload.get("content") or ""
        return (
            [RealtimeEvent(type="transcript", role="assistant", text=text, final=False)]
            if text
            else []
        )

    if event == proto.Event.ASR_INFO:
        # 听到用户首字：客户端该立刻停播，这就是「打断」
        return [RealtimeEvent(type="interrupt")]

    if event == proto.Event.TTS_ENDED:
        return [RealtimeEvent(type="turn_end")]

    if event in (proto.Event.SESSION_FAILED, proto.Event.DIALOG_ERROR):
        raise UpstreamError(
            f"实时语音出错：{payload.get('message') or payload.get('error') or payload}",
            hint=_hint_for(frame),
            provider="doubao",
        )
    return []


def _hint_for(frame: proto.Frame) -> str:
    text = str(frame.json_payload)
    if "InvalidSpeaker" in text:
        return (
            "音色与模型版本不匹配。O2.0（model=1.2.1.1）配 zh_female_vv_jupiter_bigtts "
            "这类精品音色；SC2.0（model=2.2.0.0）配 saturn_ 开头的克隆音色。"
        )
    if "extra is null" in text:
        return "StartSession 里 asr.extra 与 tts.extra 都不能为空对象之外的 null。"
    if "45000003" in text or "Abnormal silence" in text:
        return "超过 10 分钟没有交互，服务端主动释放了连接，重新 open() 即可。"
    return "看豆包语音控制台的端到端实时语音额度与并发（默认 60 QPM、10 万 TPM）。"


def from_env() -> DoubaoRealtime:
    appid = os.getenv("VOLC_SPEECH_APPID", "").strip()
    token = os.getenv("VOLC_SPEECH_TOKEN", "").strip()
    if not appid or not token:
        raise ProviderNotConfiguredError(
            "豆包端到端实时语音没配好：缺少 VOLC_SPEECH_APPID 或 VOLC_SPEECH_TOKEN。",
            hint=(
                "与语音合成同一套凭证：豆包语音控制台的应用里勾上"
                "「豆包端到端实时语音大模型」，APP ID 填 VOLC_SPEECH_APPID、"
                "Access Token 填 VOLC_SPEECH_TOKEN。"
                "不想用实时语音就把 VOICE_MODE 改回 cascade 走级联链路。"
            ),
            capability="realtime",
            provider="doubao",
        )
    return DoubaoRealtime(
        appid,
        token,
        model=os.getenv("DOUBAO_REALTIME_MODEL", DEFAULT_MODEL),
        speaker=os.getenv("DOUBAO_REALTIME_SPEAKER", DEFAULT_SPEAKER),
    )
