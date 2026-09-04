"""丘丘 · 模型能力适配层。

上层只用两样东西：``base`` 里的 Protocol 与数据类，
``registry`` 里的 ``get()`` 与 ``list_providers()``。
``providers/`` 是实现细节，只被 ``registry`` import，**不在公开导出里**（AD-8）。

    from qiuqiu_models import Message, registry

    chat = registry.get("chat")
    async for delta in await chat.stream([Message(role="user", content="你好")]):
        ...
"""

from __future__ import annotations

from . import base, metrics, registry
from .base import (
    ASR,
    CAPABILITIES,
    TTS,
    VAD,
    AudioChunk,
    Capability,
    ChatModel,
    Message,
    ModelError,
    PartialTranscript,
    ProviderInfo,
    ProviderNotConfiguredError,
    RateLimitedError,
    RealtimeEvent,
    RealtimeVoice,
    TimeoutError_,
    Transcript,
    UnknownCapabilityError,
    UpstreamError,
    VadResult,
    VisionModel,
)
from .registry import get, list_providers

__version__ = "0.1.0"

__all__ = [
    "ASR",
    "CAPABILITIES",
    "TTS",
    "VAD",
    "AudioChunk",
    "Capability",
    "ChatModel",
    "Message",
    "ModelError",
    "PartialTranscript",
    "ProviderInfo",
    "ProviderNotConfiguredError",
    "RateLimitedError",
    "RealtimeEvent",
    "RealtimeVoice",
    "TimeoutError_",
    "Transcript",
    "UnknownCapabilityError",
    "UpstreamError",
    "VadResult",
    "VisionModel",
    "__version__",
    "base",
    "get",
    "list_providers",
    "metrics",
    "registry",
]
