"""定时任务：轮数触发性格沉淀，每日降冷。"""

from __future__ import annotations

import datetime as dt

from qiuqiu_api.scheduler import EVERY_KEY, TURNS_KEY, Scheduler
from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


async def test_turns_accumulate_in_settings(state: AppState) -> None:
    scheduler = Scheduler(state)
    state.sqlite.set_setting(EVERY_KEY, "3")
    assert await scheduler.note_turn() is False
    assert await scheduler.note_turn() is False
    assert state.sqlite.get_setting(TURNS_KEY) == "2"


async def test_consolidation_triggers_at_threshold(state: AppState) -> None:
    """攒够 `settings.consolidate_every` 轮就后台跑一次沉淀，然后清零。"""
    state.sqlite.set_setting(EVERY_KEY, "2")
    state.sqlite.upsert_session("s1", "测试会话")
    state.sqlite.add_message("m1", "s1", "user", "叫我老赵吧")
    state.sqlite.add_message("m2", "s1", "assistant", "好的，老赵")

    scheduler = Scheduler(state)
    assert await scheduler.note_turn() is False
    assert await scheduler.note_turn() is True
    await scheduler.drain()

    assert state.sqlite.get_setting(TURNS_KEY) == "0"
    assert state.sqlite.latest_persona_learned() is not None


async def test_chat_counts_a_turn(client: TestClient, state: AppState) -> None:
    """每轮对话记一次数，计数由编排在 `done` 之后交给调度器。"""
    state.sqlite.set_setting(EVERY_KEY, "50")
    client.post("/chat", json={"session_id": "s1", "content": "数一轮"})
    assert state.sqlite.get_setting(TURNS_KEY) == "1"


async def test_nightly_runs_tiering(state: AppState) -> None:
    """降冷入口是记忆层的 `pipeline.tiering.nightly`，不是 data 的（AD-10）。"""
    from qiuqiu_memory import Source

    state.facade.ingest(
        "我喜欢喝美式",
        source=Source.DIALOGUE,
        speaker="user",
        ts=dt.datetime.now(dt.UTC),
        trace_id="trc_nightly",
    )
    summary = await Scheduler(state).run_nightly()
    assert "error" not in summary
    assert "demoted" in summary


async def test_scheduler_start_stop_is_idempotent(state: AppState) -> None:
    scheduler = Scheduler(state)
    await scheduler.start()  # 配置里 scheduler_enabled=False，不该起循环
    await scheduler.stop()
    await scheduler.stop()
