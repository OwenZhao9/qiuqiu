"""语音两条：`POST /voice/session` 与 `WS /voice/stream`。帧格式按 CONTRACTS § 1。

**选路只在这一层读 `VOICE_MODE`**（AD-13）：前端只认 `/voice/session` 回的 `mode`，
记忆中间件完全不感知语音。

本轮范围（M2）：`/voice/session` 完整实现；`WS /voice/stream` 是骨架——

- 级联：VAD 判有人声就攒 pcm、发 `partial`，静音收尾或收到 `{"type":"end"}` 发
  `final(role=user)` 与 `turn_end`。前端拿 `final` 自行 `POST /chat`（契约写死的分工）
- 端到端：M5 才接。这里明确发一条带 hint 的 `error` 帧，**不偷偷降级成级联**（AD-16）
- VAD / ASR 缺失（M5 前的常态）：同样是一条带 hint 的 `error` 帧，不静默换 mock

真实的 SenseVoice 与 silero 接上之后，这条链路只需要把 `asr.stream()` 换进来做增量
识别，帧格式不用动。
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

from ..config import voice_mode
from ..deps import StateDep, state_from_ws
from ..errors import CapabilityUnavailable, error_payload
from ..state import AppState, new_trace_id

router = APIRouter(tags=["voice"])
log = structlog.get_logger("qiuqiu_api.voice")

#: 收到这些控制帧就把当前这段收尾成 `final`
END_CONTROLS = {"end", "commit", "flush", "stop"}


class VoiceSessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(min_length=1)


@router.post("/voice/session")
async def open_voice_session(body: VoiceSessionIn, state: StateDep) -> dict[str, Any]:
    """开一张语音票。`mode` 按 `VOICE_MODE`，端到端不可用时直接报错带 hint。"""
    mode = voice_mode()
    if mode == "realtime":
        # ARCHITECTURE § 3：端到端连不上就在这一步报错，前端提示切文字
        state.capability("realtime")
    session = state.open_voice_session(body.session_id, mode)
    log.info("voice.session", voice_session_id=session.id, mode=mode)
    return session.to_dict()


async def _send_error(websocket: WebSocket, code: str, message: str, hint: str) -> None:
    await websocket.send_json({"type": "error", **error_payload(code, message, hint)})


@router.websocket("/voice/stream")
async def voice_stream(websocket: WebSocket, voice_session_id: str | None = None) -> None:
    state = state_from_ws(websocket)
    await websocket.accept()

    session = state.voice_sessions.get(voice_session_id or "")
    if session is None:
        await _send_error(
            websocket,
            "voice.unknown_session",
            f"没有这个语音会话：{voice_session_id!r}。",
            "先 POST /voice/session 拿 voice_session_id，再带着它连 WS /voice/stream。",
        )
        await websocket.close()
        return

    if session.mode == "realtime":
        try:
            realtime = state.capability("realtime")
        except CapabilityUnavailable as exc:
            await _send_error(websocket, exc.code, exc.message, exc.hint)
            await websocket.close()
            return
        await _realtime(websocket, state, realtime, session)
        return

    try:
        vad = state.capability("vad")
        asr = state.capability("asr")
    except CapabilityUnavailable as exc:
        await _send_error(websocket, exc.code, exc.message, exc.hint)
        await websocket.close()
        return

    await _cascade(websocket, state, vad, asr)


async def _realtime(websocket: WebSocket, state: AppState, realtime: Any, session: Any) -> None:
    """端到端：上行 pcm16 单声道 16k 直送模型，下行照原样转成 JSON 帧给前端。

    两件事跟级联不同：

    * **能打断**。模型听到用户首字会发 `interrupt`，前端收到就停播已缓冲的音频。
    * **下行 24k**，级联 TTS 是 16k，所以 `audio` 帧必带 `sample_rate`（契约 v0.1.9）。

    记忆照常写：`final` 的转写按 role 各调一次 `ingest()`（AD-6），中间件不知道这一路
    和级联有什么区别（AD-13）。
    """
    import asyncio
    import base64

    from qiuqiu_memory import Source
    from qiuqiu_memory.types import utcnow
    from qiuqiu_models import voices as voice_catalogue

    from .voices import current_voice

    trace_id = new_trace_id()
    prompt = await state.off_loop(state.persona.current)
    # 界面上选的是短名，这里换成端到端链路认的供应商 ID（没有对应项时回退默认）
    speaker = voice_catalogue.realtime_id(await current_voice(state))

    try:
        await realtime.open(system_prompt=prompt, voice=speaker)
    except Exception as exc:  # noqa: BLE001 - 统一成带 hint 的 error 帧
        await _send_error(
            websocket,
            getattr(exc, "code", "voice.realtime_open_failed"),
            str(exc),
            getattr(exc, "hint", "检查豆包语音凭证与端到端实时语音的额度。"),
        )
        await websocket.close()
        return

    async def uplink() -> None:
        """前端 → 模型。"""
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return
            chunk = message.get("bytes")
            if chunk is not None:
                await realtime.send(chunk)
            elif message.get("text"):
                # 文本兜底：前端没麦克风权限时也能发起一轮
                import json as _json

                try:
                    payload = _json.loads(message["text"])
                except _json.JSONDecodeError:
                    continue
                if payload.get("type") == "text" and payload.get("content"):
                    await realtime.say(payload["content"])

    async def downlink() -> None:
        """模型 → 前端，顺带写记忆。"""
        async for event in realtime.events():
            if event.type == "audio":
                await websocket.send_json(
                    {
                        "type": "audio",
                        "pcm_b64": base64.b64encode(event.pcm or b"").decode(),
                        "sample_rate": event.sample_rate,
                        "rms": event.rms,
                    }
                )
            elif event.type == "transcript":
                await websocket.send_json(
                    {
                        "type": "final" if event.final else "partial",
                        "role": event.role,
                        "text": event.text,
                    }
                )
                if event.final and event.text:
                    # AD-6：用户那句和 AI 那句都要写进记忆
                    await state.off_loop(
                        state.facade.ingest,
                        event.text,
                        source=Source.DIALOGUE,
                        speaker=event.role,
                        ts=utcnow(),
                        trace_id=trace_id,
                    )
            elif event.type == "interrupt":
                await websocket.send_json({"type": "interrupt"})
            elif event.type == "turn_end":
                await websocket.send_json({"type": "turn_end"})

    up = asyncio.create_task(uplink())
    down = asyncio.create_task(downlink())
    try:
        done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            if task.exception() is not None:
                raise task.exception()  # type: ignore[misc]
    except Exception as exc:  # noqa: BLE001
        await _send_error(
            websocket,
            getattr(exc, "code", "voice.realtime_failed"),
            str(exc),
            getattr(exc, "hint", "重连一次；持续失败就把 VOICE_MODE 改回 cascade。"),
        )
    finally:
        await realtime.close()
        await websocket.close()


async def _cascade(websocket: WebSocket, state: AppState, vad: Any, asr: Any) -> None:
    """级联：上行 pcm16 单声道 16k，下行 `partial` / `final` / `turn_end`。"""
    buffer = bytearray()

    async def finalize() -> None:
        if buffer:
            transcript = await state.off_loop(asr.transcribe, bytes(buffer))
            text = str(getattr(transcript, "text", "") or "")
            buffer.clear()
            if text:
                await websocket.send_json({"type": "final", "role": "user", "text": text})
        await websocket.send_json({"type": "turn_end"})

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return
            chunk = message.get("bytes")
            if chunk is not None:
                verdict = await state.off_loop(vad.evaluate, chunk)
                if verdict.has_speech:
                    buffer.extend(chunk)
                    partial = await state.off_loop(asr.transcribe, bytes(buffer))
                    await websocket.send_json(
                        {
                            "type": "partial",
                            "role": "user",
                            "text": str(getattr(partial, "text", "") or ""),
                        }
                    )
                elif buffer:
                    await finalize()
                continue
            control = _control(message.get("text"))
            if control in END_CONTROLS:
                await finalize()
            elif control == "close":
                await websocket.close()
                return
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001 - 断连之外的错也要让前端看见 hint
        log.warning("voice.stream_failed", error=str(exc))
        try:
            await _send_error(
                websocket,
                "voice.stream_failed",
                f"语音链路出错：{exc}",
                "松开重说一次；持续失败就先用文字聊，并看 /health 里 asr 与 vad 这两项。",
            )
            await websocket.close()
        except Exception:  # noqa: BLE001 - 连接已经没了就算了
            pass


def _control(text: str | None) -> str:
    """文本帧 → 控制字。收 `{"type":"end"}` 也收裸的 `end`。"""
    if not text:
        return ""
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            return str(json.loads(stripped).get("type") or "")
        except ValueError:
            return ""
    return stripped
