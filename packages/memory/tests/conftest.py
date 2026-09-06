"""记忆层测试的公共夹具。

三条硬规矩，每条都对应任务书里的一句话：

1. **不出网**：`MODELS_MOCK=1` + 默认的哈希嵌入。没有任何测试会下权重或调真实供应商。
2. **不写仓库**：`DATA_DIR` 指向 pytest 的 `tmp_path`，每个用例一套干净的库。
3. **不写真实 key**：环境变量里跟 key 沾边的一律清掉，并且 `QIUQIU_NO_DOTENV=1`
   关掉 `.env` 读取——只删环境变量不管用，dotenv 会照 `.env` 把缺的那些再填回来。

`FakeChat` 之类的构件在 `memory_helpers.py`——那边有为什么不放这里的说明。
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from pathlib import Path

import pytest
from memory_helpers import BASE_TIME
from qiuqiu_memory import embed
from qiuqiu_memory.facade import MemoryFacade
from qiuqiu_memory.persona import PersonaService
from qiuqiu_memory.runtime import MemoryRuntime

_DIRTY_ENV = (
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "VOLC_ARK_API_KEY",
    "VOLC_TTS_TOKEN",
    "EMBEDDING_PROVIDER",
    "QIUQIU_EMBED_MODEL",
    "HF_ENDPOINT",
)


@pytest.fixture(autouse=True)
def offline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """每个用例：临时 DATA_DIR、mock 模型、离线嵌入、没有任何 key。

    `registry.reset()` 必须清一次：注册表按能力缓存单例，不清的话上一个用例（或者别的
    包的测试）建出来的实例会跟着 `MODELS_MOCK` 的新取值一起漂过来。
    """
    from qiuqiu_models import registry

    monkeypatch.setenv("QIUQIU_NO_DOTENV", "1")
    for name in _DIRTY_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("MODELS_MOCK", "1")
    registry.reset()
    embed.reset_embedder()
    yield
    registry.reset()
    embed.reset_embedder()


@pytest.fixture
def clock() -> dict[str, dt.datetime]:
    """可推动的假时钟。`clock["now"] = ...` 就把时间推到那一刻。"""
    return {"now": BASE_TIME}


@pytest.fixture
def runtime(clock: dict[str, dt.datetime]) -> Iterator[MemoryRuntime]:
    """一套完整的运行时：临时库 + mock chat（固定回复，不是 JSON）+ 假时钟。"""
    rt = MemoryRuntime(clock=lambda: clock["now"])
    try:
        yield rt
    finally:
        rt.close()


@pytest.fixture
def facade(runtime: MemoryRuntime) -> MemoryFacade:
    return MemoryFacade(runtime)


@pytest.fixture
def persona(runtime: MemoryRuntime) -> PersonaService:
    return PersonaService(runtime)
