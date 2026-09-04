"""注册表：mock 全量返回、语音选路、缺配置抛带 hint 的错、/providers 不漏 key。"""

from __future__ import annotations

import pytest
from qiuqiu_models import base, registry
from qiuqiu_models.providers import mock as mock_mod

ALL_BUT_REALTIME = ["chat", "vision", "asr", "vad", "tts"]

EXPECTED_MOCK_TYPES = {
    "chat": mock_mod.MockChatModel,
    "vision": mock_mod.MockVisionModel,
    "asr": mock_mod.MockASR,
    "vad": mock_mod.MockVAD,
    "tts": mock_mod.MockTTS,
    "realtime": mock_mod.MockRealtimeVoice,
}


@pytest.mark.parametrize("capability", ALL_BUT_REALTIME)
def test_mock_mode_returns_mock_for_every_capability(capability: str, mock_env: None) -> None:
    impl = registry.get(capability)
    assert isinstance(impl, EXPECTED_MOCK_TYPES[capability])
    assert impl.provider == "mock"


@pytest.mark.parametrize("capability", ALL_BUT_REALTIME)
def test_mock_impls_satisfy_the_protocols(capability: str, mock_env: None) -> None:
    protocol = {
        "chat": base.ChatModel,
        "vision": base.VisionModel,
        "asr": base.ASR,
        "vad": base.VAD,
        "tts": base.TTS,
    }[capability]
    assert isinstance(registry.get(capability), protocol)


def test_mock_impls_never_touch_the_network(
    mock_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """把 socket 与 httpx 都掐掉，mock 仍然能造出来。"""

    import socket

    import httpx

    def boom(*_a: object, **_k: object) -> None:
        raise AssertionError("mock 实现不许出网")

    monkeypatch.setattr(socket.socket, "connect", boom)
    monkeypatch.setattr(httpx.AsyncClient, "send", boom)

    for capability in ALL_BUT_REALTIME:
        assert registry.get(capability) is not None


@pytest.mark.parametrize("capability", ALL_BUT_REALTIME)
def test_get_is_singleton(capability: str, mock_env: None) -> None:
    assert registry.get(capability) is registry.get(capability)


def test_reset_drops_the_singletons(mock_env: None) -> None:
    first = registry.get("chat")
    registry.reset()
    assert registry.get("chat") is not first


def test_unknown_capability_raises_with_hint() -> None:
    with pytest.raises(base.UnknownCapabilityError) as excinfo:
        registry.get("telepathy")
    assert excinfo.value.hint
    assert "chat" in excinfo.value.hint


# ------------------------------------------------------------------ 语音选路（AD-13）


def test_realtime_is_none_in_cascade_mode(mock_env: None) -> None:
    assert registry.voice_mode() == "cascade"
    assert registry.get("realtime") is None


def test_realtime_is_none_in_cascade_even_without_mock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOICE_MODE", "cascade")
    registry.reset()
    assert registry.get("realtime") is None


def test_realtime_returns_mock_when_mode_is_realtime(
    mock_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VOICE_MODE", "realtime")
    registry.reset()
    impl = registry.get("realtime")
    assert isinstance(impl, mock_mod.MockRealtimeVoice)


# ------------------------------------------------------------------ 缺配置（AD-16）


@pytest.mark.parametrize("capability", ["chat", "vision"])
def test_missing_key_raises_instead_of_falling_back_to_mock(capability: str) -> None:
    with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
        registry.get(capability)
    err = excinfo.value
    assert err.hint
    assert "DEEPSEEK_API_KEY" in err.hint
    assert err.to_dict()["error"]["code"] == "model.provider_not_configured"


@pytest.mark.parametrize("capability", ["asr", "vad", "tts"])
def test_deferred_capabilities_raise_with_hint(capability: str) -> None:
    with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
        registry.get(capability)
    assert "MODELS_MOCK=1" in excinfo.value.hint


def test_realtime_without_mock_in_realtime_mode_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOICE_MODE", "realtime")
    registry.reset()
    with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
        registry.get("realtime")
    assert "cascade" in excinfo.value.hint


# ------------------------------------------------------------------ /providers


def test_list_providers_covers_every_capability() -> None:
    infos = registry.list_providers()
    assert [i["capability"] for i in infos] == list(base.CAPABILITIES)


def test_list_providers_never_leaks_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "sk-not-a-real-key-0123456789"
    monkeypatch.setenv("DEEPSEEK_API_KEY", secret)
    registry.reset()
    infos = registry.list_providers()
    blob = repr(infos)
    assert secret not in blob
    chat = next(i for i in infos if i["capability"] == "chat")
    assert chat["has_key"] is True
    assert chat["available"] is True
    assert "api_key" not in chat


def test_list_providers_reports_missing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    registry.reset()
    chat = next(i for i in registry.list_providers() if i["capability"] == "chat")
    assert chat["has_key"] is False
    assert chat["available"] is False
    assert chat["hint"]


def test_list_providers_in_mock_mode(mock_env: None) -> None:
    infos = {i["capability"]: i for i in registry.list_providers()}
    for capability in ALL_BUT_REALTIME:
        assert infos[capability]["provider"] == "mock"
        assert infos[capability]["available"] is True
    assert infos["realtime"]["voice_mode"] == "cascade"


def test_list_providers_honours_model_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "x")
    monkeypatch.setenv("DEEPSEEK_CHAT_MODEL", "deepseek-custom")
    monkeypatch.setenv("DEEPSEEK_VISION_MODEL", "deepseek-custom-vision")
    registry.reset()
    infos = {i["capability"]: i for i in registry.list_providers()}
    assert infos["chat"]["model"] == "deepseek-custom"
    assert infos["vision"]["model"] == "deepseek-custom-vision"
