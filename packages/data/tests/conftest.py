"""所有测试都跑在 pytest 的临时目录里，绝不写进仓库。"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import pytest
from qiuqiu_data.lance import VECTOR_DIM

BASE_TIME = dt.datetime(2026, 9, 1, 12, 0, 0)


@pytest.fixture
def data_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把 DATA_DIR 指到临时目录，顺带确认默认路径解析也走这条路。"""
    root = tmp_path / "data"
    monkeypatch.setenv("DATA_DIR", str(root))
    return root


@pytest.fixture
def rng() -> np.random.Generator:
    return np.random.default_rng(20260901)


def make_vector(rng: np.random.Generator) -> list[float]:
    return rng.random(VECTOR_DIM, dtype=np.float32).tolist()


def make_fact(
    fact_id: str,
    rng: np.random.Generator,
    *,
    text: str | None = None,
    tokens: list[str] | None = None,
    entities: list[str] | None = None,
    speaker: str = "user",
    source: str = "chat",
    valid_from: dt.datetime | None = None,
    last_hit_at: dt.datetime | None = None,
    blob_id: str | None = None,
    vector: list[float] | None = None,
) -> dict:
    return {
        "id": fact_id,
        "text": text or f"事实 {fact_id}",
        "vector": vector if vector is not None else make_vector(rng),
        "tokens": tokens if tokens is not None else ["喜欢", "咖啡", fact_id],
        "entities": entities if entities is not None else ["用户", fact_id],
        "speaker": speaker,
        "source": source,
        "valid_from": valid_from or BASE_TIME,
        "valid_to": None,
        "superseded_by": None,
        "last_hit_at": last_hit_at or BASE_TIME,
        "blob_id": blob_id,
    }
