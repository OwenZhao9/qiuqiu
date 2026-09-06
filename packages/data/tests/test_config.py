"""DATA_DIR 的解析：环境变量优先、.env 兜底、不存在就建。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import qiuqiu_data
from qiuqiu_data import config


def test_data_dir_reads_env_var_and_creates_dir(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "nested" / "data"
    monkeypatch.setenv("DATA_DIR", str(target))

    resolved = qiuqiu_data.data_dir()

    assert resolved == target.resolve()
    assert resolved.is_dir()


def test_data_dir_reads_dotenv_when_env_var_absent(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "from-dotenv"
    (tmp_path / ".env").write_text(f"DATA_DIR={target}\n", encoding="utf-8")
    monkeypatch.delenv("DATA_DIR", raising=False)
    # 这一条测的就是「会去读 .env」，所以那个关掉 dotenv 的开关必须先摘掉——
    # 别的测试与 CI 都开着它，不摘的话这条永远测不到自己要测的东西
    monkeypatch.delenv("QIUQIU_NO_DOTENV", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config, "_env_loaded", False)

    resolved = qiuqiu_data.data_dir()

    assert resolved == target.resolve()
    assert resolved.is_dir()


def test_data_dir_falls_back_to_default(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("DATA_DIR", raising=False)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config, "_env_loaded", True)  # 别去读仓库里真实的 .env

    resolved = qiuqiu_data.data_dir()

    assert resolved == (tmp_path / config.DEFAULT_DATA_DIR).resolve()
    assert resolved.is_dir()


def test_explicit_override_beats_env(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "ignored"))
    explicit = tmp_path / "explicit"

    assert qiuqiu_data.data_dir(explicit) == explicit.resolve()


def test_paths_layout(tmp_path: Path) -> None:
    p = qiuqiu_data.paths(tmp_path / "data")

    assert p.lance == p.root / "lance"
    assert p.sqlite == p.root / "qiuqiu.db"
    assert p.blobs == p.root / "blobs"
    assert p.lance.is_dir()
    assert p.blobs.is_dir()


def test_import_does_not_pull_lancedb() -> None:
    # `import qiuqiu_data` 要保持轻量：lancedb 只在 init() 里才 import
    import subprocess
    import sys

    code = "import sys, qiuqiu_data; print('lancedb' in sys.modules)"
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "PYTHONPATH": ""},
    )
    assert out.stdout.strip() == "False"


@pytest.mark.parametrize("kind", list(config.BLOB_KINDS))
def test_blob_kinds(kind: str) -> None:
    assert kind in ("image", "text", "audio")
