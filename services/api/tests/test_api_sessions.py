"""`GET /sessions` 与 `GET /sessions/{id}/messages` 的冒烟。契约 v0.1.8 § 1。

这两条收编的理由是刷新一次界面上的历史就全丢——所以这里测的重点是「发过话之后
真的读得回来」，而不只是路由通不通。
"""

from __future__ import annotations

from starlette.testclient import TestClient

CONTRACT_SESSION_KEYS = {"id", "title", "archived", "created_at", "updated_at"}
CONTRACT_MESSAGE_KEYS = {
    "id",
    "session_id",
    "role",
    "content",
    "model",
    "favorite",
    "attachments",
    "created_at",
}


def _say(client: TestClient, text: str, session_id: str = "s1") -> None:
    """发一句话并把 SSE 读到底——不读完的话会话与消息还没落库。"""
    with client.stream("POST", "/chat", json={"session_id": session_id, "content": text}) as r:
        for _ in r.iter_lines():
            pass


def test_sessions_start_empty(client: TestClient) -> None:
    assert client.get("/sessions").json() == []


def test_a_chat_creates_a_readable_session(client: TestClient) -> None:
    _say(client, "我叫赵宁")
    rows = client.get("/sessions").json()
    assert len(rows) == 1
    assert set(rows[0]) == CONTRACT_SESSION_KEYS
    assert rows[0]["id"] == "s1"
    assert rows[0]["archived"] is False


def test_messages_come_back_in_order_with_both_roles(client: TestClient) -> None:
    """AD-6：用户那句和 AI 那句都要在，顺序按时间正序。"""
    _say(client, "我叫赵宁")
    rows = client.get("/sessions/s1/messages").json()
    assert len(rows) == 2
    assert set(rows[0]) == CONTRACT_MESSAGE_KEYS
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert rows[0]["content"] == "我叫赵宁"


def test_two_sessions_do_not_bleed_into_each_other(client: TestClient) -> None:
    _say(client, "第一个会话", session_id="a")
    _say(client, "第二个会话", session_id="b")
    a = client.get("/sessions/a/messages").json()
    assert {r["session_id"] for r in a} == {"a"}
    assert a[0]["content"] == "第一个会话"


def test_limit_caps_the_page(client: TestClient) -> None:
    _say(client, "一句话")
    rows = client.get("/sessions/s1/messages?limit=1").json()
    assert len(rows) == 1


def test_unknown_session_is_404_with_a_hint(client: TestClient) -> None:
    body = client.get("/sessions/nope/messages").json()
    assert body["error"]["code"] == "session_not_found"
    assert body["error"]["hint"]


def test_attachments_survive_a_restart(client: TestClient) -> None:
    """发过的图要跟着消息回来。

    附件原来只活在前端内存里：`hydrate` 一律填空数组，重开窗口那条消息
    只剩「带了 1 张图」几个字，图去哪了没人知道。
    """
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
    blob_id = client.post("/blobs", files={"file": ("x.png", png, "image/png")}).json()["blob_id"]
    response = client.post(
        "/chat",
        json={
            "session_id": "s-img",
            "content": "这是什么",
            "attachments": [{"type": "image", "blob_id": blob_id}],
        },
    )
    assert response.status_code == 200
    assert response.text  # 读完流才落库

    rows = client.get("/sessions/s-img/messages").json()
    assert rows[0]["role"] == "user"
    assert rows[0]["attachments"] == [blob_id]
    assert rows[1]["attachments"] == []  # 回复没带图
    assert client.get("/blobs/" + blob_id).content == png
