"""`/config/thresholds`、`/providers`、`/current-model`。"""

from __future__ import annotations

from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


def test_thresholds_defaults(client: TestClient) -> None:
    body = client.get("/config/thresholds").json()
    assert body == {"accept": 0.72, "uncertain": 0.45}


def test_thresholds_put_takes_effect_immediately(client: TestClient, state: AppState) -> None:
    """热生效：改完记忆层下一次判定就按新值走，不用重启。"""
    body = client.put("/config/thresholds", json={"accept": 0.9, "uncertain": 0.3}).json()
    assert body == {"accept": 0.9, "uncertain": 0.3}
    assert state.runtime.thresholds.accept == 0.9
    assert state.runtime.thresholds.decide(0.5) == "uncertain"
    assert client.get("/config/thresholds").json() == body


def test_thresholds_inverted_is_rejected(client: TestClient) -> None:
    response = client.put("/config/thresholds", json={"accept": 0.2, "uncertain": 0.8})
    assert response.status_code == 400
    assert response.json()["error"]["hint"]


def test_thresholds_out_of_range_is_422(client: TestClient) -> None:
    assert client.put("/config/thresholds", json={"accept": 2, "uncertain": 0.5}).status_code == 422


def test_providers_never_leak_keys(client: TestClient) -> None:
    body = client.get("/providers").json()
    assert {item["capability"] for item in body} == {
        "chat",
        "vision",
        "asr",
        "vad",
        "tts",
        "realtime",
    }
    for item in body:
        assert "api_key" not in item
        assert isinstance(item["has_key"], bool)
    assert "key" not in str(body).lower().replace("has_key", "")


def test_providers_report_hint_when_unavailable(client: TestClient) -> None:
    realtime = next(p for p in client.get("/providers").json() if p["capability"] == "realtime")
    assert realtime["available"] is False
    assert realtime["hint"]
    assert realtime["voice_mode"] == "cascade"


def test_current_model_switches_and_persists(client: TestClient, state: AppState) -> None:
    body = client.post("/current-model", json={"capability": "chat", "model": "deepseek-x"}).json()
    assert body["capability"] == "chat"
    assert body["model"] == "deepseek-x"
    assert state.sqlite.get_setting("model.chat") == "deepseek-x"


def test_current_model_rejects_unknown_capability(client: TestClient) -> None:
    response = client.post("/current-model", json={"capability": "asr", "model": "x"})
    assert response.status_code == 422
    assert response.json()["error"]["hint"]
