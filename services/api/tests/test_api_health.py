"""`/health` 冒烟。"""

from __future__ import annotations

import re
from pathlib import Path

from starlette.testclient import TestClient

CONTRACTS = Path(__file__).resolve().parents[3] / "docs" / "CONTRACTS.md"


def declared_contract_version() -> str:
    """文档顶部声明的当前契约版本。抄一份到测试里只测得出「文档改了代码没跟」。"""
    found = re.search(r"当前：\*\*(v[\d.]+)\*\*", CONTRACTS.read_text(encoding="utf-8"))
    assert found, "CONTRACTS.md 里找不到「当前：**vX.Y.Z**」"
    return found.group(1)


def test_health_reports_contract_and_models(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["contract"] == declared_contract_version()
    assert body["voice_mode"] == "cascade"
    capabilities = {m["capability"] for m in body["models"]}
    assert capabilities == {"chat", "vision", "asr", "vad", "tts", "realtime"}


def test_health_lists_missing_capabilities(client: TestClient) -> None:
    """级联模式下端到端语音本来就不用，报在 `missing` 里但服务照样 ok。"""
    body = client.get("/health").json()
    assert "realtime" in body["missing"]
    assert body["status"] == "ok"


def test_unknown_route_still_has_hint(client: TestClient) -> None:
    body = client.get("/nope").json()
    assert body["error"]["hint"]
