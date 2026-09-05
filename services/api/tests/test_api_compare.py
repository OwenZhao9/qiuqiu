"""`POST /compare`：同一 query 两条配置的 token 与延迟对照。"""

from __future__ import annotations

import datetime as dt

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
