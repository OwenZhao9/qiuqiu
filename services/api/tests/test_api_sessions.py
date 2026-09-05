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
