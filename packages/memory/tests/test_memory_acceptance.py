"""任务书 `docs/agents/05-memory.md` 的五条验收，逐条走一遍完整链路。

跟别的用例的分工：那边分模块测，这边只按验收条从门面进、从事件出，谁改坏了哪一条
一眼能对上。全部走 mock 模型与离线哈希嵌入，不出网。
"""

from __future__ import annotations

import datetime as dt

from memory_helpers import BASE_TIME, FakeChat, absorb_all, make_runtime, seed_messages
from qiuqiu_memory import Budget, MemoryFacade, PersonaService, Source


def facts_of(runtime, tier: str = "hot") -> dict[str, dict]:
    return {r["id"]: r for r in runtime.lance.query_scalar(tier, limit=100)}


class TestAcceptanceOne:
    """「我叫赵宁，我喜欢喝美式咖啡。用一句话介绍你自己。」"""

    SENTENCE = "我叫赵宁，我喜欢喝美式咖啡。用一句话介绍你自己。"

    def test_two_facts_and_a_complete_write_event(self, facade: MemoryFacade) -> None:
        result = facade.ingest(self.SENTENCE, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)

        assert len(result.accepted) == 2, "名字一条、偏好一条"

        event = next(e for e in facade.runtime.bus.history if e.type == "write")
        payload = event.payload
        assert payload["raw"] == self.SENTENCE
        assert payload["speaker"] == "user"
        assert payload["dropped_spans"] == ["用一句话介绍你自己"], "指令那截要进 dropped_spans"

        texts = [f["text"] for f in payload["facts"]]
        assert texts == ["用户叫赵宁", "用户喜欢喝美式咖啡"]
        assert all("我" not in t for t in texts), "事实必须自包含，不留代词"
        for fact in payload["facts"]:
            assert set(fact) == {"id", "text", "entities", "valid_from"}
            assert fact["entities"]
            assert fact["valid_from"].endswith("Z")


class TestAcceptanceTwo:
    """三条碎片「想喝咖啡」「喜欢燕麦奶」「喜欢热的」合成一条。"""

    def test_merged_into_one_with_old_ones_invalidated(self, clock: dict[str, dt.datetime]) -> None:
        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            for text in ("想喝咖啡", "喜欢燕麦奶", "喜欢热的"):
                facade.ingest(text, source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)

            rows = facts_of(rt)
            alive = [r for r in rows.values() if r["valid_to"] is None]
            dead = [r for r in rows.values() if r["valid_to"] is not None]
            assert len(alive) == 1
            assert len(dead) == 2
            assert all(r["superseded_by"] for r in dead), "作废要写 superseded_by"

            merges = [e for e in rt.bus.history if e.type == "merge"]
            assert len(merges) == 2
            for event in merges:
                assert event.payload["result_text"]
                assert all(a["text"] for a in event.payload["absorbed"])
                assert all(i["valid_to"] for i in event.payload["invalidated"])

            assert len(facade.list_visible()) == 1, "记忆库里也只剩一条"
        finally:
            facade.close()


class TestAcceptanceThree:
    """「我搬到深圳了」推翻「住北京」。"""

    def test_old_fact_superseded_and_recall_only_returns_shenzhen(
        self, clock: dict[str, dt.datetime]
    ) -> None:
        rt = make_runtime(clock, FakeChat([("记忆合成器", absorb_all)]))
        facade = MemoryFacade(rt)
        try:
            old = facade.ingest("我住在北京", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
            new = facade.ingest(
                "我搬到深圳了", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME
            )

            rows = facts_of(rt)
            assert rows[old.accepted[0]]["superseded_by"] == new.accepted[0]
            assert rows[old.accepted[0]]["valid_to"] is not None

            result = facade.recall("周末去哪", budget=Budget())
            texts = " ".join(h.text for h in result.items)
            assert "深圳" in texts and "北京" not in texts
        finally:
            facade.close()


class TestAcceptanceFour:
    """10 段环境音里 8 段静音 → 8 个 `filter.reject`，理由 `Silence detected`。"""

    SEGMENTS = (
        "",
        "   ",
        "...",
        "",
        "  ",
        "。。",
        "",
        "\t\n",
        "今天下午三点要去医院复查牙齿",
        "记得买点牛奶和鸡蛋回家",
    )

    def test_eight_rejects_with_silence_reason(self, facade: MemoryFacade) -> None:
        for segment in self.SEGMENTS:
            facade.ingest(segment, source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)

        events = [e for e in facade.runtime.bus.history if e.type == "filter"]
        assert len(events) == 10, "每次判断都要发事件，留下的那两条也算"

        rejects = [e for e in events if e.payload["decision"] == "reject"]
        assert len(rejects) == 8
        assert all(e.payload["reason"] == "Silence detected" for e in rejects)
        assert all(e.payload["source"] == "ambient_audio" for e in rejects)
        assert all(e.payload["score"] == 0.0 for e in rejects)

        accepted = [e for e in events if e.payload["decision"] == "accept"]
        assert len(accepted) == 2
        assert facade.runtime.lance.count("hot") > 0, "留下的两段确实写进去了"


class TestAcceptanceFive:
    """50 轮对话后 `run_consolidation()` 产出 `Learned`，快照重算。"""

    TURNS = [
        ("user", "叫我小赵"),
        ("assistant", "好的"),
        ("user", "哈哈哈 233 笑死"),
        ("assistant", "嗯"),
        ("user", "今天又喝了美式咖啡"),
    ]

    def test_learned_produced_and_snapshot_changes(self, persona: PersonaService) -> None:
        before = persona.current()
        seed_messages(persona.runtime, self.TURNS * 10)  # 50 条

        learned = persona.run_consolidation()

        assert learned.to_dict(), "至少归纳出点东西"
        assert learned.nickname == "小赵"
        after = persona.current()
        assert after != before
        assert "小赵" in after

        saved = persona.runtime.sqlite.latest_persona_learned()
        assert saved is not None and saved["version"] == 1
        assert saved["learned_json"] == learned.to_dict()

    def test_second_round_merges_incrementally(self, persona: PersonaService) -> None:
        seed_messages(persona.runtime, self.TURNS * 10)
        persona.run_consolidation()
        seed_messages(
            persona.runtime,
            [("user", "认真点，别开玩笑")] * 5,
            session_id="s2",
            start=BASE_TIME + dt.timedelta(hours=1),
        )
        second = persona.run_consolidation()
        assert second.nickname == "小赵", "这一轮没提称呼，沿用上一版"
        assert persona.runtime.sqlite.latest_persona_learned()["version"] == 2
