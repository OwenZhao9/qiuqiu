"""模型层测试的公共夹具。

每个用例都跑在干净的环境里：清掉注册表单例、清掉模型相关环境变量、
把指标 sink 换成一个只属于本用例的内存实现。
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from qiuqiu_models import metrics, registry

_MODEL_ENV = ("MODELS_MOCK", "VOICE_MODE", "TTS_PROVIDER")
"""没有共同前缀、要逐个点名的那几个。"""

_MODEL_ENV_PREFIXES = ("DEEPSEEK_", "VOLC_", "AZURE_", "DOUBAO_", "SEEDREAM_")
"""按前缀扫，新增供应商不用回来改这份清单。

**为什么按前缀**：原先是一份手写名单，加 `AZURE_*` 与 `VOLC_SPEECH_*` 时忘了补，
结果单独跑本包通过、全量跑挂——后端的测试会载入开发机上的 `.env`，把真实凭证漏进
进程环境，「没配凭证」这类用例就失效了。本地有 `.env`、CI 没有，两边结果不一致。
"""


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """每个用例都从「什么都没配」开始，与开发机上有没有 `.env` 无关。"""
    for name in _MODEL_ENV:
        monkeypatch.delenv(name, raising=False)
    for name in [n for n in os.environ if n.startswith(_MODEL_ENV_PREFIXES)]:
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
