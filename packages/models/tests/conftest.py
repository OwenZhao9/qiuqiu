"""模型层测试的公共夹具。

每个用例都跑在干净的环境里：清掉注册表单例、清掉模型相关环境变量、
把指标 sink 换成一个只属于本用例的内存实现。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from qiuqiu_models import metrics, registry

_MODEL_ENV = (
    "MODELS_MOCK",
    "VOICE_MODE",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_CHAT_MODEL",
    "DEEPSEEK_VISION_MODEL",
    "VOLC_ARK_API_KEY",
    "VOLC_TTS_TOKEN",
    "TTS_PROVIDER",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for name in _MODEL_ENV:
        monkeypatch.delenv(name, raising=False)
    registry.reset()
    yield
    registry.reset()


@pytest.fixture(autouse=True)
def sink() -> Iterator[metrics.InMemoryMetricsSink]:
    fresh = metrics.InMemoryMetricsSink()
    old = metrics.set_sink(fresh)
    try:
        yield fresh
    finally:
        metrics.set_sink(old)


@pytest.fixture
def mock_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODELS_MOCK", "1")
    registry.reset()
