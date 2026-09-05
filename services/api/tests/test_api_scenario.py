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


def test_clock_offset_reaches_ingest_ts(
    client: TestClient, scenarios_dir: Path, ingest_spy: list[dict]
) -> None:
    """偏移经 `ingest()` 的 `ts` 传进去，系统时钟不动。"""
    write_script(scenarios_dir, "time-jump", SCRIPT)
    before = dt.datetime.now(dt.UTC)
    client.post("/scenario/time-jump/play", json={"speed": 0})
    after = dt.datetime.now(dt.UTC)

    assert all(call["ts"] - before > dt.timedelta(days=91) for call in ingest_spy)
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
