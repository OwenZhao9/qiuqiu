"""`POST /ingest`：被动采集入口。"""

from __future__ import annotations

import struct

import pytest
from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


def put_blob(state: AppState, data: bytes, kind: str) -> str:
    return state.blobs.put(data, kind)


def silence(samples: int = 1600) -> bytes:
    return struct.pack(f"<{samples}h", *([0] * samples))


def speech(samples: int = 1600) -> bytes:
    return struct.pack(f"<{samples}h", *([1200, -1200] * (samples // 2)))


def test_ambient_image_goes_through_vision(client: TestClient, state: AppState) -> None:
    blob_id = put_blob(state, b"\x89PNG fake bytes", "image")
    body = client.post("/ingest", json={"source": "ambient_image", "blob_id": blob_id}).json()
    assert set(body) == {"trace_id", "decision"}
    assert body["trace_id"].startswith("trc_")
    assert body["decision"] in {"accept", "reject", "uncertain"}


def test_ambient_audio_without_speech_is_rejected(client: TestClient, state: AppState) -> None:
    """VAD 判无人声就到此为止，不进 `ingest`（ARCHITECTURE § 6 第三条链路）。"""
    blob_id = put_blob(state, silence(), "audio")
    body = client.post("/ingest", json={"source": "ambient_audio", "blob_id": blob_id}).json()
    assert body["decision"] == "reject"
    assert body["reason"]


def test_ambient_audio_with_speech_reaches_the_facade(
    client: TestClient, state: AppState, ingest_spy: list[dict]
) -> None:
    blob_id = put_blob(state, speech(), "audio")
    body = client.post("/ingest", json={"source": "ambient_audio", "blob_id": blob_id}).json()
    assert body["decision"] in {"accept", "reject", "uncertain"}
    assert len(ingest_spy) == 1
    assert ingest_spy[0]["source"].value == "ambient_audio"
    assert ingest_spy[0]["blob_id"] == blob_id


def test_unknown_blob_is_404_with_hint(client: TestClient) -> None:
    response = client.post(
        "/ingest",
        json={
            "source": "ambient_image",
            "blob_id": "image/" + "0" * 64,
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["hint"]


def test_missing_asr_reports_hint_not_mock(
    client: TestClient, state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AD-16：能力缺失返回带 hint 的错误，绝不静默换 mock。"""
    from qiuqiu_models import registry

    blob_id = put_blob(state, speech(), "audio")
    monkeypatch.delenv("MODELS_MOCK", raising=False)
    registry.reset()

    response = client.post("/ingest", json={"source": "ambient_audio", "blob_id": blob_id})
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["hint"]
    assert "MODELS_MOCK" in error["hint"] or "mock" in error["hint"]


def test_bad_source_is_422(client: TestClient) -> None:
    response = client.post("/ingest", json={"source": "dialogue", "blob_id": "x"})
    assert response.status_code == 422
    assert response.json()["error"]["hint"]
