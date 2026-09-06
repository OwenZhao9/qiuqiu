"""`POST /compare`：同一 query 两条配置的 token 与延迟对照。"""

from __future__ import annotations

import datetime as dt

import pytest
from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


def test_default_two_configs(client: TestClient) -> None:
    body = client.post("/compare", json={"query": "我住哪儿"}).json()
    assert [r["name"] for r in body["results"]] == ["with-memory", "no-memory"]
    for result in body["results"]:
        assert set(result) >= {
            "trace_id",
            "model",
            "reply",
            "memory_used",
            "recall_ids",
            "tokens_in",
            "tokens_out",
            "latency_ms",
        }
        assert result["reply"]
    assert set(body["delta"]) == {"tokens_in", "tokens_out", "latency_ms", "against"}


def test_memory_config_costs_more_prompt_tokens(client: TestClient, state: AppState) -> None:
    """带人格与召回的那条 prompt 更长，`tokens_in` 应当更大——成本对照演的就是这个。"""
    from qiuqiu_memory import Source

    state.facade.ingest(
        "我住在深圳南山",
        source=Source.DIALOGUE,
        speaker="user",
        ts=dt.datetime.now(dt.UTC),
        trace_id="trc_compare_seed",
    )
    body = client.post("/compare", json={"query": "我住哪儿"}).json()
    with_memory, without = body["results"]
    assert with_memory["tokens_in"] > without["tokens_in"]
    assert body["delta"]["tokens_in"] > 0


def test_compare_does_not_write_memory(
    client: TestClient, state: AppState, ingest_spy: list[dict]
) -> None:
    client.post("/compare", json={"query": "跑一遍别记住"})
    assert ingest_spy == []
    assert state.sqlite.list_messages("s1") == []


def test_custom_configs(client: TestClient) -> None:
    body = client.post(
        "/compare",
        json={
            "query": "两条自定义",
            "configs": [{"name": "a", "memory": True}, {"name": "b", "memory": True}],
        },
    ).json()
    assert [r["name"] for r in body["results"]] == ["a", "b"]


def test_empty_query_is_422(client: TestClient) -> None:
    assert client.post("/compare", json={"query": ""}).status_code == 422


def test_persona_survives_use_memory_false(
    state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`use_memory=False` 关掉的是「记得住」，不是「它是谁」。

    人格跟着一起丢有两个后果：一是安全边界（不模拟恋爱关系、不诱导依赖、
    不替代专业建议）在这条路上没了；二是成本对照那个演示不公平——无记忆那一侧
    连身份都不一样，量出来的差距里混进了「换了个助手」，不再只是记忆的功劳。
    """
    import anyio
    from qiuqiu_api import orchestrator

    seen: list[str] = []
    original = orchestrator.build_messages

    def spy(state_: AppState, *, persona_text: str, **kwargs: object) -> object:
        seen.append(persona_text)
        return original(state_, persona_text=persona_text, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(orchestrator, "build_messages", spy)

    async def run() -> None:
        await orchestrator.run_once(
            state,
            name="no-memory",
            query="你叫什么",
            session_id=None,
            use_memory=False,
            trace_id="trc_test",
        )

    anyio.run(run)

    assert seen, "build_messages 没被调到"
    assert "【身份】" in seen[0], "身份段丢了，模型不知道自己叫丘丘"
    assert "【边界】" in seen[0], "安全边界丢了——这条路上三条硬约束全没了"
