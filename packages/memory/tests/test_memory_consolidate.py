"""性格沉淀。只读 `messages` 表（AD-4），增量合并，写新版本，重算快照。"""

from __future__ import annotations

import datetime as dt
import json

import pytest
from memory_helpers import BASE_TIME, FakeChat, make_runtime, seed_messages
from qiuqiu_memory.facade import MemoryFacade
from qiuqiu_memory.persona import LEARNED_MARKER, PersonaService
from qiuqiu_memory.pipeline.consolidate import (
    COLD_PROFILE_ID,
    DEFAULT_ROUNDS,
    consolidate,
    recent_messages,
)
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import Learned, Source

CHATTY = [
    ("user", "叫我小赵"),
    ("assistant", "好的，小赵"),
    ("user", "哈哈哈笑死我了 233"),
    ("assistant", "很高兴逗到你"),
    ("user", "今天又去喝了美式咖啡"),
    ("assistant", "听起来不错"),
    ("user", "皮一下很开心"),
    ("assistant", "确实"),
]


def test_default_rounds_matches_task_spec() -> None:
    assert DEFAULT_ROUNDS == 50


class TestInputSource:
    def test_only_reads_messages_table(self, runtime: MemoryRuntime) -> None:
        """AD-4 的硬约束：碰一下事实表就算违规。"""
        seed_messages(runtime, CHATTY)

        def explode(*_a: object, **_k: object) -> None:
            raise AssertionError("性格沉淀不许读记忆库")

        for name in ("query_vector", "query_fts", "get_many"):
            setattr(runtime.lance, name, explode)
        runtime.sqlite.list_visible_memory = explode  # type: ignore[method-assign]

        assert consolidate(runtime).to_dict()

    def test_recent_messages_sorted_and_capped(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, [("user", str(i)) for i in range(10)])
        rows = recent_messages(runtime, 3)
        assert [r["content"] for r in rows] == ["7", "8", "9"]

    def test_messages_merged_across_sessions(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, [("user", "早")], session_id="s1", start=BASE_TIME)
        seed_messages(
            runtime,
            [("user", "晚")],
            session_id="s2",
            start=BASE_TIME + dt.timedelta(hours=1),
        )
        assert [r["content"] for r in recent_messages(runtime, 10)] == ["早", "晚"]

    def test_no_messages_keeps_previous_version(self, runtime: MemoryRuntime) -> None:
        """空归纳写进去只会把学到的冲掉，所以一条消息都没有时什么都不写。"""
        runtime.sqlite.append_persona_learned({"nickname": "小赵"})
        assert consolidate(runtime).nickname == "小赵"
        assert len(runtime.sqlite.list_persona_learned()) == 1


class TestHeuristicPath:
    def test_nickname_humor_and_length_inferred(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, CHATTY)
        learned = consolidate(runtime)
        assert learned.nickname == "小赵"
        assert learned.humor_tolerance is not None and learned.humor_tolerance > 50
        assert learned.reply_length in {"short", "medium", "long"}

    def test_serious_user_scores_low_humor(self, runtime: MemoryRuntime) -> None:
        seed_messages(
            runtime,
            [("user", "认真点，别闹"), ("user", "严肃一些，不要开玩笑"), ("user", "正经回答")],
        )
        learned = consolidate(runtime)
        assert learned.humor_tolerance is not None and learned.humor_tolerance < 50

    def test_long_messages_yield_long_preference(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, [("user", "今" * 80)] * 3)
        assert consolidate(runtime).reply_length == "long"

    def test_assistant_only_transcript_learns_nothing(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, [("assistant", "我先说点什么")])
        assert consolidate(runtime).to_dict() == {}


class TestModelPath:
    def test_model_json_used(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps(
            {
                "nickname": "宁哥",
                "humor_tolerance": 88,
                "topics": ["咖啡", "跑步"],
                "reply_length": "short",
            },
            ensure_ascii=False,
        )
        rt = make_runtime(clock, FakeChat([("性格观察者", reply)]))
        try:
            seed_messages(rt, CHATTY)
            learned = consolidate(rt)
            assert learned.nickname == "宁哥"
            assert learned.topics == ["咖啡", "跑步"]
        finally:
            rt.close()

    def test_all_null_answer_falls_back_to_heuristic(self, clock: dict[str, dt.datetime]) -> None:
        reply = json.dumps(
            {"nickname": None, "humor_tolerance": None, "topics": None, "reply_length": None}
        )
        rt = make_runtime(clock, FakeChat([("性格观察者", reply)]))
        try:
            seed_messages(rt, CHATTY)
            assert consolidate(rt).nickname == "小赵"
        finally:
            rt.close()

    def test_chat_failure_falls_back_to_heuristic(self, clock: dict[str, dt.datetime]) -> None:
        class Broken:
            provider = "broken"

            async def complete(self, messages: list[object]) -> str:
                raise RuntimeError("断网")

        rt = make_runtime(clock, Broken())
        try:
            seed_messages(rt, CHATTY)
            assert consolidate(rt).nickname == "小赵"
        finally:
            rt.close()


class TestIncrementalMerge:
    def test_new_values_override_missing_values_persist(self, runtime: MemoryRuntime) -> None:
        runtime.sqlite.append_persona_learned(Learned(nickname="老赵", topics=["读书"]).to_dict())
        seed_messages(runtime, [("user", "哈哈哈 233 笑死")] * 3)
        merged = consolidate(runtime)
        assert merged.nickname == "老赵", "这一轮没归纳出称呼，沿用上一版"
        assert merged.topics == ["读书"]
        assert merged.humor_tolerance is not None

    def test_version_increments_and_history_kept(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, CHATTY)
        consolidate(runtime)
        consolidate(runtime)
        versions = [r["version"] for r in runtime.sqlite.list_persona_learned()]
        assert versions == [2, 1]


class TestColdProfile:
    def test_profile_written_to_cold_tier(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, CHATTY)
        consolidate(runtime)
        rows = runtime.lance.query_scalar("cold", limit=10)
        assert len(rows) == 1
        assert rows[0]["id"].startswith(COLD_PROFILE_ID)
        assert "性格档案" in rows[0]["text"]

    def test_cold_write_failure_does_not_break_consolidation(self, runtime: MemoryRuntime) -> None:
        """冷表写失败不算失败——`persona_learned` 才是权威副本。"""
        original = runtime.lance.upsert

        def flaky(records, tier="hot"):  # type: ignore[no-untyped-def]
            if tier == "cold":
                raise RuntimeError("冷表挂了")
            return original(records, tier)

        runtime.lance.upsert = flaky  # type: ignore[method-assign]
        seed_messages(runtime, CHATTY)
        assert consolidate(runtime).nickname == "小赵"


class TestPersonaIntegration:
    def test_run_consolidation_changes_current(self, persona: PersonaService) -> None:
        """任务书验收条五：沉淀完 `current()` 输出变化。"""
        before = persona.current()
        seed_messages(persona.runtime, CHATTY * 7)  # 50 轮量级
        learned = persona.run_consolidation()
        after = persona.current()
        assert learned.to_dict()
        assert after != before
        assert LEARNED_MARKER in after
        assert "小赵" in after

    def test_no_scheduler_inside_this_layer(self) -> None:
        """触发方是后端定时任务，本层不自带调度器。"""
        import qiuqiu_memory.pipeline.consolidate as module

        source = module.__doc__ or ""
        assert "不自带调度器" in source
        assert not hasattr(module, "start_scheduler")

    def test_rounds_setting_respected(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, [("user", f"叫我小赵{i}") for i in range(6)])
        runtime.sqlite.set_setting("consolidate_rounds", "1")
        assert consolidate(runtime).nickname == "小赵5"

    def test_explicit_rounds_wins_over_setting(self, runtime: MemoryRuntime) -> None:
        seed_messages(runtime, [("user", f"叫我小赵{i}") for i in range(6)])
        runtime.sqlite.set_setting("consolidate_rounds", "6")
        assert consolidate(runtime, rounds=1).nickname == "小赵5"


@pytest.mark.parametrize("bad", ["", "很多"])
def test_setting_int_falls_back_to_default(runtime: MemoryRuntime, bad: str) -> None:
    runtime.sqlite.set_setting("consolidate_rounds", bad)
    assert runtime.setting_int("consolidate_rounds") == DEFAULT_ROUNDS


def test_facade_and_persona_share_one_runtime(facade: MemoryFacade) -> None:
    """backend 该复用同一个 runtime，两边看到的是同一套库。"""
    persona = PersonaService(facade.runtime)
    facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
    seed_messages(facade.runtime, CHATTY)
    persona.run_consolidation()
    assert persona.runtime is facade.runtime
