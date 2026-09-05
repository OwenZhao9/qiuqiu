"""`POST /voice/session` 与 `WS /voice/stream`。

本轮 WS 只做到骨架：级联能出 `partial` / `final` / `turn_end`，端到端与能力缺失
各回一条带 hint 的 `error` 帧（AD-16：不静默降级）。
"""

from __future__ import annotations

import struct

import pytest
from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


def speech(samples: int = 800) -> bytes:
    return struct.pack(f"<{samples}h", *([1500, -1500] * (samples // 2)))


def silence(samples: int = 800) -> bytes:
    return struct.pack(f"<{samples}h", *([0] * samples))


def open_session(client: TestClient, session_id: str = "s1") -> dict:
    response = client.post("/voice/session", json={"session_id": session_id})
    assert response.status_code == 200
    return response.json()


def test_session_returns_cascade_mode(client: TestClient) -> None:
    body = open_session(client)
    assert set(body) == {"voice_session_id", "mode"}
    assert body["mode"] == "cascade"
    assert body["voice_session_id"].startswith("vs_")


def test_session_mode_follows_voice_mode_env(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AD-13：选路只看 `VOICE_MODE`，前端只认这个 `mode`。"""
    from qiuqiu_models import registry

    monkeypatch.setenv("VOICE_MODE", "realtime")
    registry.reset()
    assert open_session(client)["mode"] == "realtime"


def test_session_errors_with_hint_when_realtime_missing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from qiuqiu_models import registry

    monkeypatch.setenv("VOICE_MODE", "realtime")
    monkeypatch.delenv("MODELS_MOCK", raising=False)
    registry.reset()

    response = client.post("/voice/session", json={"session_id": "s1"})
    assert response.status_code == 503
    assert response.json()["error"]["hint"]


def test_stream_rejects_unknown_session(client: TestClient) -> None:
    with client.websocket_connect("/voice/stream?voice_session_id=vs_nope") as ws:
        frame = ws.receive_json()
    assert frame["type"] == "error"
    assert frame["code"] == "voice.unknown_session"
    assert frame["hint"]


def test_cascade_emits_partial_final_and_turn_end(client: TestClient) -> None:
    voice_session_id = open_session(client)["voice_session_id"]
    with client.websocket_connect(f"/voice/stream?voice_session_id={voice_session_id}") as ws:
        ws.send_bytes(speech())
        partial = ws.receive_json()
        assert partial["type"] == "partial"
        assert partial["role"] == "user"
        assert partial["text"]

        ws.send_text('{"type": "end"}')
        final = ws.receive_json()
        assert final["type"] == "final"
        assert final["role"] == "user"
        assert final["text"]
        assert ws.receive_json()["type"] == "turn_end"


def test_cascade_finalises_on_silence(client: TestClient) -> None:
    voice_session_id = open_session(client)["voice_session_id"]
    with client.websocket_connect(f"/voice/stream?voice_session_id={voice_session_id}") as ws:
        ws.send_bytes(speech())
        assert ws.receive_json()["type"] == "partial"
        ws.send_bytes(silence())
        assert ws.receive_json()["type"] == "final"
        assert ws.receive_json()["type"] == "turn_end"


def test_realtime_stream_says_it_is_not_implemented(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """端到端推迟到 M5：明说 + hint，不偷偷降级成级联。"""
    from qiuqiu_models import registry

    monkeypatch.setenv("VOICE_MODE", "realtime")
    registry.reset()
    voice_session_id = open_session(client)["voice_session_id"]

    with client.websocket_connect(f"/voice/stream?voice_session_id={voice_session_id}") as ws:
        frame = ws.receive_json()
    assert frame["type"] == "error"
    assert frame["code"] == "voice.realtime_not_implemented"
    assert "cascade" in frame["hint"]


def test_missing_asr_yields_error_frame(
    client: TestClient, state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    from qiuqiu_models import registry

    voice_session_id = open_session(client)["voice_session_id"]
    monkeypatch.delenv("MODELS_MOCK", raising=False)
    registry.reset()

    with client.websocket_connect(f"/voice/stream?voice_session_id={voice_session_id}") as ws:
        frame = ws.receive_json()
    assert frame["type"] == "error"
    assert frame["hint"]
