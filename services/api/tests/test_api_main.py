"""`python -m qiuqiu_api.main --check` 的自检，冒烟脚本第 3 步跑的就是它。"""

from __future__ import annotations

import pytest
from qiuqiu_api.main import check, main
from qiuqiu_api.routes import API_PATHS


def test_check_passes_offline(capsys: pytest.CaptureFixture[str]) -> None:
    assert check() == 0
    report = capsys.readouterr().out.strip().splitlines()[-1]
    assert '"ok": true' in report
    assert "v0.1.11" in report


def test_main_routes_check_flag() -> None:
    assert main(["--check"]) == 0


def test_all_contract_routes_are_registered() -> None:
    """CONTRACTS § 1 点名的路由一条都不能少。"""
    expected = {
        "/chat",
        "/events",
        "/ingest",
        "/memories",
        "/memories/{memory_id}",
        "/persona",
        "/persona/preset",
        "/persona/sliders",
        "/persona/reset-learned",
        "/config/thresholds",
        "/providers",
        "/current-model",
        "/blobs",
        "/scenario/{name}/play",
        "/compare",
        "/health",
        "/voice/session",
        "/voice/stream",
    }
    assert expected <= set(API_PATHS)
