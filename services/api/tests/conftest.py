"""后端测试的公共夹具。三条硬规矩，跟记忆层那份保持一致：

1. **不出网**：`MODELS_MOCK=1`，注册表全返回 mock；嵌入走默认的离线哈希
2. **不写仓库**：`DATA_DIR` 指到 pytest 的 `tmp_path`，每个用例一套干净的库
3. **不留真实 key**：环境里跟 key 沾边的一律清掉

`state` 与 `client` 分开：有些用例（事件总线、定时任务）要在没有 HTTP 请求的时候
直接动 `facade`，那时候只需要 `state`。
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from qiuqiu_api.app import create_app
from qiuqiu_api.config import Config
from qiuqiu_api.state import AppState
from starlette.testclient import TestClient

_DIRTY_ENV = (
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_CHAT_MODEL",
    "DEEPSEEK_VISION_MODEL",
    "VOLC_ARK_API_KEY",
    "VOLC_TTS_TOKEN",
    "EMBEDDING_PROVIDER",
    "HF_ENDPOINT",
    "VOICE_MODE",
)


@pytest.fixture(autouse=True)
def offline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    from qiuqiu_memory import embed
    from qiuqiu_models import registry

    for name in _DIRTY_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("MODELS_MOCK", "1")
    monkeypatch.setenv("SCHEDULER_ENABLED", "0")
    registry.reset()
    embed.reset_embedder()
    yield
    registry.reset()
    embed.reset_embedder()


@pytest.fixture
def scenarios_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "scenarios"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@pytest.fixture
def config(scenarios_dir: Path) -> Config:
    """测试配置：不等重试、心跳快一点，场景目录指到临时目录。"""
    return dataclasses.replace(
        Config.from_env(),
        scenarios_dir=scenarios_dir,
        retry_delays=(),
        events_heartbeat_s=0.2,
        scheduler_enabled=False,
    )


@pytest.fixture
def state(config: Config) -> Iterator[AppState]:
    built = AppState.create(config=config)
    try:
        yield built
    finally:
        built.close()


@pytest.fixture
def client(state: AppState) -> Iterator[TestClient]:
    app = create_app(state=state, start_scheduler=False)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def ingest_spy(state: AppState, monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """记下每一次 `MemoryFacade.ingest()` 的参数。验收要数「被调两次」。"""
    calls: list[dict[str, Any]] = []
    original = state.facade.ingest

    def spy(text: str, **kwargs: Any) -> Any:
        calls.append({"text": text, **kwargs})
        return original(text, **kwargs)

    monkeypatch.setattr(state.facade, "ingest", spy)
    return calls


@pytest.fixture
def app(state: AppState) -> Any:
    """不跑 lifespan 的应用，给 `SSEProbe` 直接驱动用。"""
    application = create_app(state=state, start_scheduler=False)
    application.state.qiuqiu = state
    return application
