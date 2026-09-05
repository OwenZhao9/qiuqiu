"""`GET /voices` 与 `GET/PUT /config/voice`。契约 v0.1.10 § 1。"""

from __future__ import annotations

from starlette.testclient import TestClient


def test_listing_is_female_only_and_hides_vendor_ids(client: TestClient) -> None:
    """丘丘是女声。前端只认稳定短名，供应商音色 ID 不外泄——
    同一个音色在两条链路上 ID 不一样，泄出去前端就得自己做映射。"""
    rows = client.get("/voices").json()
    assert rows
    for row in rows:
        assert set(row) == {"id", "label", "blurb", "realtime_supported"}
        assert row["label"] and row["blurb"]
        assert "uranus" not in str(row)
        assert "jupiter" not in str(row)
        assert "male" not in row["id"]


def test_default_is_returned_before_anything_is_chosen(client: TestClient) -> None:
    body = client.get("/config/voice").json()
    assert body["voice"]
    assert body["voice"] in {r["id"] for r in client.get("/voices").json()}


def test_choice_round_trips(client: TestClient) -> None:
    options = [r["id"] for r in client.get("/voices").json()]
    target = options[-1]
    assert client.put("/config/voice", json={"voice": target}).json() == {"voice": target}
    assert client.get("/config/voice").json() == {"voice": target}


def test_unknown_voice_is_refused_with_a_hint(client: TestClient) -> None:
    response = client.put("/config/voice", json={"voice": "zh_male_nope"})
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "voice.unknown"
    assert body["error"]["hint"]


def test_a_retired_voice_falls_back_instead_of_breaking(client: TestClient, state: object) -> None:
    """存过的音色下架后要能继续开口，不能整条语音链路挂掉。"""
    state.sqlite.set_setting("voice", "some-voice-that-no-longer-exists")  # type: ignore[attr-defined]
    body = client.get("/config/voice").json()
    assert body["voice"] in {r["id"] for r in client.get("/voices").json()}


def test_every_listed_voice_is_selectable(client: TestClient) -> None:
    for row in client.get("/voices").json():
        assert client.put("/config/voice", json={"voice": row["id"]}).status_code == 200
