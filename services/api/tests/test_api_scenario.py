"""`POST /scenario/{name}/play`：按时间轴回放，时间偏移不改系统时钟。"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any

from qiuqiu_api.state import AppState
from starlette.testclient import TestClient

SCRIPT: dict[str, Any] = {
    "name": "time-jump",
    "title": "过了三个月",
    "clock_offset_days": 92,
    "steps": [
        {"at_ms": 0, "source": "dialogue", "speaker": "user", "text": "我在北京"},
        {"at_ms": 10, "source": "dialogue", "speaker": "user", "text": "我上周搬到深圳了"},
        {"at_ms": 20, "query": "我住哪儿"},
    ],
}


def write_script(directory: Path, name: str, payload: dict[str, Any]) -> None:
    (directory / f"{name}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def test_play_runs_every_step(
    client: TestClient, scenarios_dir: Path, ingest_spy: list[dict]
) -> None:
    write_script(scenarios_dir, "time-jump", SCRIPT)
    body = client.post("/scenario/time-jump/play", json={"speed": 0}).json()

    assert body["name"] == "time-jump"
    assert body["clock_offset_days"] == 92
    assert [step["kind"] for step in body["steps"]] == ["ingest", "ingest", "recall"]
    assert len(ingest_spy) == 2


def test_writes_happen_now_not_in_the_future(
    client: TestClient, scenarios_dir: Path, ingest_spy: list[dict]
) -> None:
    """写入按**此刻**记，偏移只作用在提问那一边。

    原来两边都加偏移，等于「三个月后说、三个月后问」——中间没有时间差，
    事实还热着，「过了三个月」演出来就只是一次普通召回。
    """
    write_script(scenarios_dir, "time-jump", SCRIPT)
    before = dt.datetime.now(dt.UTC)
    client.post("/scenario/time-jump/play", json={"speed": 0})
    after = dt.datetime.now(dt.UTC)

    assert all(abs(call["ts"] - before) < dt.timedelta(seconds=30) for call in ingest_spy)
    assert after - before < dt.timedelta(seconds=30)  # 真实时钟没被改


def test_recall_step_uses_shifted_now(
    client: TestClient, scenarios_dir: Path, state: AppState, monkeypatch: Any
) -> None:
    write_script(scenarios_dir, "time-jump", SCRIPT)
    seen: list[dt.datetime] = []
    original = state.facade.recall

    def spy(query: str, **kwargs: Any) -> Any:
        seen.append(kwargs["now"])
        return original(query, **kwargs)

    monkeypatch.setattr(state.facade, "recall", spy)
    client.post("/scenario/time-jump/play", json={"speed": 0})
    assert seen
    assert seen[0] - dt.datetime.now(dt.UTC) > dt.timedelta(days=91)


def test_unknown_scenario_is_404_with_hint(client: TestClient, scenarios_dir: Path) -> None:
    write_script(scenarios_dir, "ambient-noise", SCRIPT | {"name": "ambient-noise"})
    response = client.post("/scenario/nope/play", json={"speed": 0})
    assert response.status_code == 404
    hint = response.json()["error"]["hint"]
    assert "ambient-noise" in hint


def test_path_traversal_is_rejected(client: TestClient) -> None:
    response = client.post("/scenario/..%2F..%2Fetc%2Fpasswd/play", json={"speed": 0})
    assert response.status_code in {400, 404}
    assert response.json()["error"]["hint"]


def test_bad_step_has_hint(client: TestClient, scenarios_dir: Path) -> None:
    write_script(scenarios_dir, "broken", {"steps": [{"at_ms": 0, "source": "telepathy"}]})
    response = client.post("/scenario/broken/play", json={"speed": 0})
    assert response.status_code == 400
    assert response.json()["error"]["hint"]


def test_speed_controls_pacing(client: TestClient, scenarios_dir: Path) -> None:
    """`speed=1` 按脚本原速，前端才能在 /events 上看到事件一条条冒出来。"""
    write_script(
        scenarios_dir,
        "paced",
        {
            "name": "paced",
            "steps": [
                {"at_ms": 0, "source": "dialogue", "speaker": "user", "text": "第一"},
                {"at_ms": 300, "source": "dialogue", "speaker": "user", "text": "第二"},
            ],
        },
    )
    import time

    started = time.perf_counter()
    client.post("/scenario/paced/play", json={"speed": 1})
    assert time.perf_counter() - started >= 0.28


def test_scenarios_listing_exists(client: TestClient) -> None:
    """契约 v0.1.8 § 1 收编 `GET /scenarios`。原先只在 README 里，
    前端只能把四个场景名写死在代码里。"""
    rows = client.get("/scenarios").json()
    assert isinstance(rows, list)
    for row in rows:
        assert set(row) == {"name", "title"}
        assert row["name"] and row["title"]


def test_time_jump_ages_the_store_before_asking(
    client: TestClient, scenarios_dir: Path, state: AppState, monkeypatch: Any
) -> None:
    """提问之前跑一遍降冷，站在偏移那一天的时钟上。

    少了这一步，「过了三个月」演的只是普通召回：写和问是同一时刻，事实还热着，
    看不到「热表没有 → 下探冷表 → 命中回热」这条链路。
    """
    write_script(scenarios_dir, "time-jump", SCRIPT)
    seen: list[Any] = []
    original = state.facade.demote_stale

    def spy(**kwargs: Any) -> Any:
        seen.append(kwargs.get("at"))
        return original(**kwargs)

    monkeypatch.setattr(state.facade, "demote_stale", spy)
    body = client.post("/scenario/time-jump/play", json={"speed": 0}).json()

    assert len(seen) == 1, "只跑一次，不是每个提问都跑一遍"
    assert seen[0] - dt.datetime.now(dt.UTC) > dt.timedelta(days=91)
    assert "demoted" in body
    assert body["asked_from"] > body["played_from"], "问的时刻要在说的时刻之后"


def test_no_offset_means_no_aging(
    client: TestClient, scenarios_dir: Path, state: AppState, monkeypatch: Any
) -> None:
    """没有偏移的场景不该动冷热表——它们演的不是这件事。"""
    write_script(scenarios_dir, "plain", SCRIPT | {"name": "plain", "clock_offset_days": 0})
    calls: list[Any] = []
    monkeypatch.setattr(
        state.facade, "demote_stale", lambda **kw: calls.append(kw) or {"demoted": 0}
    )
    client.post("/scenario/plain/play", json={"speed": 0})
    assert calls == []
