"""模型能力的抽象接口与数据类。

上层（backend、memory）只 import 本模块的 Protocol 与数据类，实例一律经
``qiuqiu_models.registry.get(capability)`` 获取，不 import ``providers/``（AD-8）。

Protocol 签名逐字照抄 ``docs/CONTRACTS.md`` § 4（契约版本 v0.1.2），不得改动。

两点签名上的实现约定（契约文本本身没写死，这里定死，全仓库统一）：

* ``ChatModel.stream`` 与 ``TTS.synthesize`` 声明为 ``async def ... -> AsyncIterator[...]``，
  即**协程返回异步迭代器**，调用方写 ``async for x in await model.stream(msgs)``。
  它们不是 async generator function。
* ``RealtimeVoice.events`` 是普通 ``def``，直接返回异步迭代器，调用方写
  ``async for ev in rv.events()``。
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

__all__ = [
    "AudioChunk",
    "Capability",
    "CAPABILITIES",
    "ASR",
    "ChatModel",
    "Message",
    "ModelError",
    "PartialTranscript",
    "ProviderInfo",
    "ProviderNotConfiguredError",
    "RateLimitedError",
    "RealtimeEvent",
    "RealtimeVoice",
    "TTS",
    "Transcript",
    "TimeoutError_",
    "UnknownCapabilityError",
    "UpstreamError",
    "VAD",
    "VadResult",
    "VisionModel",
]

Capability = Literal["chat", "vision", "asr", "vad", "tts", "realtime"]

#: 注册表认识的全部能力，顺序即 ``list_providers()`` 的输出顺序。
CAPABILITIES: tuple[Capability, ...] = ("chat", "vision", "asr", "vad", "tts", "realtime")

Role = Literal["system", "user", "assistant"]


# --------------------------------------------------------------------------- 数据类


@dataclass(slots=True)
class Message:
    """一条对话消息。``role`` 用 OpenAI 兼容的三种。"""

    role: Role
    content: str

    def to_dict(self) -> dict[str, Any]:
        return {"role": self.role, "content": self.content}


@dataclass(slots=True)
class Transcript:
    """整段识别结果。字段按 CONTRACTS § 4 的 ``{ text, lang, confidence }``。"""

    text: str
    lang: str
    confidence: float


@dataclass(slots=True)
class PartialTranscript:
    """流式识别的中间结果。``final=True`` 表示这一段已定稿。"""

    text: str
    final: bool = False
    lang: str = "zh"
    confidence: float = 0.0


@dataclass(slots=True)
class VadResult:
    """一段音频的人声判断。字段按 CONTRACTS § 4 的 ``{ has_speech, energy, confidence }``。"""

    has_speech: bool
    energy: float
    confidence: float


@dataclass(slots=True)
class AudioChunk:
    """一段合成音频。``rms`` 归一到 0–1，前端拿它驱动口型。"""

    pcm: bytes
    rms: float
    sample_rate: int = 16000


@dataclass(slots=True)
class RealtimeEvent:
    """端到端语音的输出事件，四类：``audio`` / ``transcript`` / ``interrupt`` / ``turn_end``。

    ``to_dict()`` 产出的字典与 CONTRACTS § 4 注释里的三种形状逐字一致（``None`` 字段不出现）。
    """

    type: Literal["audio", "transcript", "interrupt", "turn_end"]
    pcm: bytes | None = None
    rms: float | None = None
    sample_rate: int | None = None
    role: Literal["user", "assistant"] | None = None
    text: str | None = None
    final: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        if self.type == "audio":
            return {
                "type": "audio",
                "pcm": self.pcm,
                "rms": self.rms,
                "sample_rate": self.sample_rate,
            }
        if self.type == "transcript":
            return {
                "type": "transcript",
                "role": self.role,
                "text": self.text,
                "final": self.final,
            }
        return {"type": self.type}  # interrupt / turn_end 都只有 type


# --------------------------------------------------------------------------- 错误


class ModelError(Exception):
    """模型层错误的基类。

    按 AD-16，凡是用户可能看到的失败都必须带 ``hint``（下一步能做什么），
    不能只说「失败了」，也不能静默降级到 mock。

    ``to_dict()`` 的形状与 CONTRACTS § 1 的错误信封 ``{"error": {code, message, hint}}`` 一致，
    backend 可以直接透传。**message 与 hint 里绝不放 key**。
    """

    code = "model.error"

    def __init__(
        self,
        message: str,
        *,
        hint: str,
        code: str | None = None,
        capability: str | None = None,
        provider: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        if code is not None:
            self.code = code
        self.capability = capability
        self.provider = provider

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "hint": self.hint,
            }
        }


class UnknownCapabilityError(ModelError):
    """``registry.get()`` 收到了不认识的能力名。"""

    code = "model.unknown_capability"


class ProviderNotConfiguredError(ModelError):
    """缺 key、缺权重，或该能力这一轮还没接真实实现。

    注意：这是**抛错**，不是换 mock。mock 只在 ``MODELS_MOCK=1`` 时由注册表全量返回（AD-16）。
    """

    code = "model.provider_not_configured"


class UpstreamError(ModelError):
    """出网调用失败（非 2xx、连接断开、响应无法解析）。"""

    code = "model.upstream_error"


class RateLimitedError(UpstreamError):
    """上游 429，重试退避后仍失败。"""

    code = "model.rate_limited"


class TimeoutError_(UpstreamError):
    """出网调用超时。类名带下划线是为了不遮蔽内建 ``TimeoutError``。"""

    code = "model.timeout"


# --------------------------------------------------------------------------- Protocol


@runtime_checkable
class ChatModel(Protocol):
    async def stream(
        self, messages: list[Message], *, temperature: float = 0.7
    ) -> AsyncIterator[str]: ...

    async def complete(self, messages: list[Message]) -> str: ...


@runtime_checkable
class VisionModel(Protocol):
    async def describe(self, image: bytes | str, prompt: str) -> str: ...  # bytes 或 URL


@runtime_checkable
class ASR(Protocol):
    def transcribe(self, pcm16k: bytes) -> Transcript: ...  # { text, lang, confidence }

    def stream(self, chunks: Iterator[bytes]) -> Iterator[PartialTranscript]: ...


@runtime_checkable
class VAD(Protocol):
    def evaluate(self, pcm16k: bytes) -> VadResult: ...  # { has_speech, energy, confidence }


@runtime_checkable
class TTS(Protocol):
    async def synthesize(
        self, text: str, *, voice: str
    ) -> AsyncIterator[AudioChunk]: ...  # chunk 含 pcm 与 rms


@runtime_checkable
class RealtimeVoice(Protocol):
    """端到端语音对话。一次会话一个连接；send 推用户音频，events 收模型输出。"""

    async def open(self, *, system_prompt: str, voice: str) -> None: ...

    async def send(self, pcm16k: bytes) -> None: ...

    async def interrupt(self) -> None: ...  # 用户开口打断

    def events(self) -> AsyncIterator[RealtimeEvent]: ...

    async def close(self) -> None: ...


# --------------------------------------------------------------------------- 供应商描述


@dataclass(slots=True)
class ProviderInfo:
    """``registry.list_providers()`` 的一项，直接喂给 ``GET /providers``。

    **只回 ``has_key: bool``，绝不回 key 本身。**
    """

    capability: str
    provider: str
    model: str | None = None
    base_url: str | None = None
    has_key: bool = False
    available: bool = False
    local: bool = False
    hint: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "capability": self.capability,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "has_key": self.has_key,
            "available": self.available,
            "local": self.local,
        }
        if self.hint:
            d["hint"] = self.hint
        d.update(self.extra)
        return d
