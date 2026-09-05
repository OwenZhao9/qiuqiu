"""`POST /ingest`：被动采集入口。"""

from __future__ import annotations

import json
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


def test_vad_rejection_still_leaves_a_trace_in_the_sidebar(
    client: TestClient, state: AppState
) -> None:
    """契约 v0.1.8 § 3：VAD 拦下的片段也要有 `filter` 事件。

    VAD 在后端，被它判成静音的片段根本进不到中间件，于是中间件不会发事件。
    没有这条，`ambient-noise`（99% 是废话）演示的侧栏就是空的——而它要演的正是
    这些拒绝。「记忆过程看得见」是第一质量属性。
    """
    before = state.sqlite.latest_event_id()
    blob_id = put_blob(state, silence(), "audio")
    body = client.post("/ingest", json={"source": "ambient_audio", "blob_id": blob_id}).json()
    assert body["decision"] == "reject"

    rows = state.sqlite.events_since(before, limit=10)
    assert len(rows) == 1, "VAD 拒绝必须留下一条 filter 事件"
    assert rows[0]["type"] == "filter"
    raw = rows[0]["payload_json"]  # 数据层已经反序列化过，字符串是兜底
    payload = raw if isinstance(raw, dict) else json.loads(raw)
    assert payload["decision"] == "reject"
    assert payload["source"] == "ambient_audio"
    assert payload["reason"]


def test_ambient_speech_is_not_attributed_to_the_user(
    client: TestClient, state: AppState, ingest_spy: list[dict]
) -> None:
    """契约 v0.1.8 § 5：被动采集的说话人未知，记 `ambient`。

    记成 `user` 就是把别人说的话记成用户自己说的——`multi-person` 演示里
    客厅有三个人，一个都不是用户。
    """
    blob_id = put_blob(state, speech(), "audio")
    client.post("/ingest", json={"source": "ambient_audio", "blob_id": blob_id})
    assert ingest_spy[-1]["speaker"] == "ambient"
