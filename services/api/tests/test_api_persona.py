"""`/persona` 四条。"""

from __future__ import annotations

from starlette.testclient import TestClient


def test_get_shape(client: TestClient) -> None:
    body = client.get("/persona").json()
    assert set(body) == {"preset", "sliders", "learned", "current"}
    assert set(body["sliders"]) == {"initiative", "verbosity", "emotion", "humor"}
    assert body["current"].startswith("【边界】")


def test_preset_none_is_a_vacuum(client: TestClient) -> None:
    """AD-11：`preset` 为 null 时 prompt 里一行滑块描述都没有。"""
    warmed = client.put("/persona/preset", json={"preset": "warm"}).json()
    assert warmed["preset"] == "warm"
    assert "【预设】" in warmed["current"]

    empty = client.put("/persona/preset", json={"preset": None}).json()
    assert empty["preset"] is None
    assert "【预设】" not in empty["current"]


def test_unknown_preset_is_422(client: TestClient) -> None:
    response = client.put("/persona/preset", json={"preset": "凶巴巴"})
    assert response.status_code == 422
    assert response.json()["error"]["hint"]


def test_sliders_roundtrip(client: TestClient) -> None:
    client.put("/persona/preset", json={"preset": "quiet"})
    body = client.put(
        "/persona/sliders",
        json={"initiative": 10, "verbosity": 90, "emotion": 20, "humor": 30},
    ).json()
    assert body["sliders"] == {
        "initiative": 10,
        "verbosity": 90,
        "emotion": 20,
        "humor": 30,
    }
    assert "话量多" in body["current"]


def test_sliders_out_of_range_is_422(client: TestClient) -> None:
    response = client.put(
        "/persona/sliders",
        json={"initiative": 500, "verbosity": 0, "emotion": 0, "humor": 0},
    )
    assert response.status_code == 422


def test_reset_learned_writes_a_new_empty_version(client: TestClient, state) -> None:
    """AD-9：重置是往前写一版空的，历史不删。"""
    state.sqlite.append_persona_learned({"nickname": "老赵"})
    assert client.get("/persona").json()["learned"]["nickname"] == "老赵"

    body = client.post("/persona/reset-learned").json()
    assert body["learned"] == {}
    assert len(state.sqlite.list_persona_learned()) == 2
