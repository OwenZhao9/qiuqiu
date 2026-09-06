"""模型注册表。上层拿实例的唯一入口（AD-8）。

``get(capability)`` 按环境变量返回实现，单例缓存；``list_providers()`` 供
``GET /providers`` 用，**只回 ``has_key: bool``，绝不回 key 本身**。

三条规矩：

* ``MODELS_MOCK=1`` 时全部能力返回 mock，调用不出网（AD-16 只承认这一个 mock 入口）。
* ``VOICE_MODE`` 不是 ``realtime`` 时 ``get("realtime")`` 返回 ``None``，编排走级联（AD-13）。
  这条优先于 ``MODELS_MOCK``——语音选路只看 ``VOICE_MODE``。
* 真实实现缺失且没开 mock 时抛带 ``hint`` 的 ``ProviderNotConfiguredError``，**不静默换 mock**。

环境变量直接读 ``os.environ``。把 ``.env`` 载入进程环境是应用（backend）的事，
本包不读文件、不依赖 dotenv，这样测试改 ``monkeypatch.setenv`` 就能生效。
"""

from __future__ import annotations

import os
import threading
from typing import Any

from .base import (
    CAPABILITIES,
    ProviderInfo,
    ProviderNotConfiguredError,
    UnknownCapabilityError,
)

__all__ = ["get", "list_providers", "reset", "mock_enabled", "voice_mode"]

_lock = threading.Lock()
_instances: dict[str, Any] = {}

#: 还没有真实实现、或缺配置的能力 → (供应商名, 缺什么, 怎么办)。
#: `tts` 已有真实实现（`volc_tts`），这里的条目只在缺 key 时用来报错。
_DEFERRED: dict[str, tuple[str, str, str]] = {
    "asr": (
        "sensevoice",
        "语音识别还没接上（SenseVoice 计划在 M5 接入）。",
        "先用文字聊；要离线开发就设 MODELS_MOCK=1。",
    ),
    "vad": (
        "silero",
        "人声检测还没接上（silero-vad 计划在 M5 接入）。",
        "先用文字聊；要离线开发就设 MODELS_MOCK=1。",
    ),
    "tts": (
        "volcengine",
        "语音合成没配好。",
        "在豆包语音控制台建应用，填 VOLC_SPEECH_APPID 与 VOLC_SPEECH_TOKEN。"
        "没配时回复照常显示文字，只是没有声音。",
    ),
    "realtime": (
        "doubao",
        "端到端实时语音没配好。",
        "与语音合成同一套凭证：填 VOLC_SPEECH_APPID 与 VOLC_SPEECH_TOKEN，"
        "并把 VOICE_MODE 设为 realtime。不想用就把 VOICE_MODE 改回 cascade。",
    ),
}


def mock_enabled() -> bool:
    return os.environ.get("MODELS_MOCK", "").strip() in {"1", "true", "True", "yes"}


def voice_mode() -> str:
    """``cascade``（默认）或 ``realtime``。只有编排该读它（AD-13）。"""

    return (os.environ.get("VOICE_MODE") or "cascade").strip().lower()


def reset() -> None:
    """清掉单例缓存。改了环境变量之后调用；测试每个用例都该调一次。"""

    with _lock:
        _instances.clear()


def get(capability: str) -> Any:
    """返回该能力的实现单例。

    ``capability`` ∈ ``chat`` ``vision`` ``asr`` ``vad`` ``tts`` ``realtime``。
    ``realtime`` 在级联模式下返回 ``None``；其余情况要么返回实例，要么抛带 ``hint`` 的错。
    """

    if capability not in CAPABILITIES:
        raise UnknownCapabilityError(
            f"不认识的模型能力 {capability!r}。",
            hint="能用的是：" + "、".join(CAPABILITIES) + "。",
            capability=capability,
        )

    # AD-13：语音选路只看 VOICE_MODE，先于 mock 判断。
    if capability == "realtime" and voice_mode() != "realtime":
        return None

    cached = _instances.get(capability)
    if cached is not None:
        return cached

    with _lock:
        cached = _instances.get(capability)
        if cached is not None:
            return cached
        instance = _build(capability)
        _instances[capability] = instance
        return instance


def _build(capability: str) -> Any:
    if mock_enabled():
        return _build_mock(capability)

    if capability == "chat":
        from .providers import deepseek_chat

        return deepseek_chat.from_env()

    if capability == "vision":
        from .providers import deepseek_vision

        return deepseek_vision.from_env()

    if capability == "tts":
        return _build_tts()

    if capability == "realtime":
        # 走到这里说明 VOICE_MODE=realtime（级联模式在 get() 里就返回 None 了）
        from .providers import doubao_realtime

        return doubao_realtime.from_env()

    provider, what, todo = _DEFERRED[capability]
    raise ProviderNotConfiguredError(
        what,
        hint=todo,
        capability=capability,
        provider=provider,
    )


def tts_provider() -> str:
    """只有豆包语音一家。

    原来还有一个 Azure 适配器，靠 ``TTS_PROVIDER`` 切换。Azure 只做语音合成，
    跟端到端实时通话没有任何关系，留着只是多一条没人走的路和一份要维护的凭证。
    这个函数留下来是因为 ``/health`` 与错误提示都要报「用的是哪一家」。
    """

    return "volcengine"


def _build_tts() -> Any:
    from .providers import volc_tts

    return volc_tts.from_env()


def _build_mock(capability: str) -> Any:
    from .providers import mock

    builders = {
        "chat": mock.MockChatModel,
        "vision": mock.MockVisionModel,
        "asr": mock.MockASR,
        "vad": mock.MockVAD,
        "tts": mock.MockTTS,
        "realtime": mock.MockRealtimeVoice,
    }
    return builders[capability]()


def list_providers() -> list[dict[str, Any]]:
    """每个能力当前用谁、配没配好。供 ``GET /providers``。

    ``has_key`` 只说明「环境变量里有没有这个 key」，**不回 key 内容**。
    """

    from .providers import deepseek_chat, deepseek_vision

    mock = mock_enabled()
    has_deepseek = bool(os.environ.get("DEEPSEEK_API_KEY", "").strip())
    base_url = os.environ.get("DEEPSEEK_BASE_URL") or deepseek_chat.DEFAULT_BASE_URL
    mode = voice_mode()

    infos: list[ProviderInfo] = []

    for capability, model_env, default_model in (
        ("chat", "DEEPSEEK_CHAT_MODEL", deepseek_chat.DEFAULT_MODEL),
        ("vision", "DEEPSEEK_VISION_MODEL", deepseek_vision.DEFAULT_MODEL),
    ):
        infos.append(
            ProviderInfo(
                capability=capability,
                provider="mock" if mock else "deepseek",
                model="mock" if mock else (os.environ.get(model_env) or default_model),
                base_url=None if mock else base_url,
                has_key=has_deepseek,
                available=mock or has_deepseek,
                hint=None
                if (mock or has_deepseek)
                else "在 .env 里填 DEEPSEEK_API_KEY，或设 MODELS_MOCK=1 用 mock。",
            )
        )

    for capability in ("asr", "vad", "tts", "realtime"):
        provider, _what, todo = _DEFERRED[capability]
        if capability == "realtime":
            # 与语音合成同一套凭证。先算 has_key，再据它判 available。
            has_key = bool(
                os.environ.get("VOLC_SPEECH_APPID", "").strip()
                and os.environ.get("VOLC_SPEECH_TOKEN", "").strip()
            )
            available = mode == "realtime" and (mock or has_key)
            hint = (
                None
                if available
                else (todo if mode == "realtime" else "级联模式下不使用端到端语音。")
            )
        elif capability == "tts":
            # 官方接口，key 齐了就真的能用，不只是 mock 下可用。
            has_key = bool(
                os.environ.get("VOLC_SPEECH_APPID", "").strip()
                and os.environ.get("VOLC_SPEECH_TOKEN", "").strip()
            )
            provider = "mock" if mock else tts_provider()
            available = mock or has_key
            hint = None if available else todo
        else:
            available = mock
            hint = None if available else todo
            has_key = False
        infos.append(
            ProviderInfo(
                capability=capability,
                provider="mock" if mock else provider,
                model="mock" if mock else None,
                base_url=None,
                has_key=has_key,
                available=available,
                local=capability in {"asr", "vad"},
                hint=hint,
                extra={"voice_mode": mode} if capability == "realtime" else {},
            )
        )

    return [i.to_dict() for i in infos]
