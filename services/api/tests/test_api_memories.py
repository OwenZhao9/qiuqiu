"""`/memories` 三条。"""

from __future__ import annotations

import datetime as dt
from typing import Any

from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


def seed(state: AppState, text: str = "我叫赵宁，住在深圳") -> Any:
    from qiuqiu_memory import Source

    return state.facade.ingest(
        text,
        source=Source.DIALOGUE,
        speaker="user",
        ts=dt.datetime.now(dt.UTC),
        trace_id="trc_memories_test",
    )


def test_list_and_filter_by_layer(client: TestClient, state: AppState) -> None:
    seed(state)
    items = client.get("/memories").json()
    assert items
    assert set(items[0]) == {
        "id",
        "layer",
        "content",
        "source",
        "enabled",
        "fact_ids",
        "updated_at",
    }
    layer = items[0]["layer"]
    filtered = client.get(f"/memories?layer={layer}").json()
    assert all(item["layer"] == layer for item in filtered)


def test_patch_updates_content(client: TestClient, state: AppState) -> None:
    seed(state)
    target = client.get("/memories").json()[0]
    updated = client.patch(f"/memories/{target['id']}", json={"content": "改过的内容"}).json()
    assert updated["content"] == "改过的内容"
    assert updated["id"] == target["id"]


def test_patch_rejects_unknown_field(client: TestClient, state: AppState) -> None:
    seed(state)
    target = client.get("/memories").json()[0]
    response = client.patch(f"/memories/{target['id']}", json={"nope": 1})
    assert response.status_code == 422
    assert response.json()["error"]["hint"]


def test_patch_empty_body_has_hint(client: TestClient, state: AppState) -> None:
    seed(state)
    target = client.get("/memories").json()[0]
    response = client.patch(f"/memories/{target['id']}", json={})
    assert response.status_code == 400
    assert response.json()["error"]["hint"]


def test_delete_disables_without_removing_the_row(client: TestClient, state: AppState) -> None:
    """AD-9：删除是级联作废，不删行。"""
    seed(state)
    target = client.get("/memories").json()[0]
    deleted = client.delete(f"/memories/{target['id']}").json()
    assert deleted["enabled"] is False
    assert state.sqlite.get_visible_memory(target["id"]) is not None


def test_unknown_memory_is_404_with_hint(client: TestClient) -> None:
    response = client.patch("/memories/vm_nope", json={"content": "x"})
    assert response.status_code == 404
    assert response.json()["error"]["hint"]
