"""`/health` 冒烟。"""

from __future__ import annotations

from starlette.testclient import TestClient


def test_health_reports_contract_and_models(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["contract"] == "v0.1.8"
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
