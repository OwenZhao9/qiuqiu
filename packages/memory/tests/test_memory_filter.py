"""筛选。只筛被动采集（AD-3），判定按契约 v0.1.5 的 `/config/thresholds`。"""

from __future__ import annotations

import json

from qiuqiu_memory.pipeline.filter import DEDUP_JACCARD, EXTRA_TRIGGERS, Filter
from qiuqiu_memory.runtime import DEFAULTS, MemoryRuntime, Thresholds
from qiuqiu_memory.types import FilterDecision, Source

SPEECH = "今天下午三点要去医院复查牙齿"


class TestThresholds:
    def test_defaults_match_contract(self, runtime: MemoryRuntime) -> None:
        assert (DEFAULTS["accept"], DEFAULTS["uncertain"]) == (0.72, 0.45)
        assert runtime.thresholds.accept == 0.72
        assert runtime.thresholds.uncertain == 0.45

    def test_decide_boundaries(self, runtime: MemoryRuntime) -> None:
        decide = runtime.thresholds.decide
        assert decide(0.72) == "accept"
        assert decide(0.9) == "accept"
        assert decide(0.71) == "uncertain"
        assert decide(0.45) == "uncertain"
        assert decide(0.44) == "reject"
        assert decide(0.0) == "reject"

    def test_settings_blob_takes_effect_without_restart(self, runtime: MemoryRuntime) -> None:
        """`PUT /config/thresholds` 落 SQLite `settings`，下一次判定就该变。"""
        runtime.sqlite.set_setting("thresholds", json.dumps({"accept": 0.2, "uncertain": 0.1}))
        assert runtime.thresholds.accept == 0.2
        assert runtime.thresholds.decide(0.3) == "accept"

    def test_per_key_setting_also_read(self, runtime: MemoryRuntime) -> None:
        runtime.sqlite.set_setting("thresholds.accept", "0.9")
        assert runtime.thresholds.accept == 0.9

    def test_garbage_setting_falls_back_to_default(self, runtime: MemoryRuntime) -> None:
        runtime.sqlite.set_setting("thresholds", "{ 不是 JSON")
        assert runtime.thresholds.accept == 0.72

    def test_non_numeric_value_falls_back(self, runtime: MemoryRuntime) -> None:
        runtime.sqlite.set_setting("thresholds", json.dumps({"accept": "很高"}))
        assert Thresholds(runtime.sqlite).accept == 0.72


class TestSilence:
    def test_eight_of_ten_ambient_segments_rejected_with_silence_reason(
        self, runtime: MemoryRuntime
    ) -> None:
        """任务书的验收条：10 段环境音里 8 段静音，全部 `reject` 且理由是 Silence detected。"""
        screen = Filter(runtime)
        segments = [
            "",
            "   ",
            "...",
            "",
            "  ",
            "。。",
            "",
            "\t\n",
            SPEECH,
            "记得买点牛奶和鸡蛋回家",
        ]
        decisions = [screen.evaluate(s, source=Source.AMBIENT_AUDIO) for s in segments]

        rejected = [d for d in decisions if d.decision == "reject"]
        assert len(rejected) == 8
        assert all(d.reason == "Silence detected" for d in rejected)
        assert all(d.score == 0.0 for d in rejected)
        assert [d.decision for d in decisions[-2:]] == ["accept", "accept"]

    def test_blank_frame_reason_for_images(self, runtime: MemoryRuntime) -> None:
        decision = Filter(runtime).evaluate("   ", source=Source.AMBIENT_IMAGE)
        assert decision.reason == "Blank frame detected"

    def test_unknown_source_gets_generic_reason(self, runtime: MemoryRuntime) -> None:
        decision = Filter(runtime).evaluate("", source=Source.DIALOGUE)
        assert decision.reason == "Empty input"


class TestLowInformation:
    def test_short_utterance_scores_low(self, runtime: MemoryRuntime) -> None:
        decision = Filter(runtime).evaluate("嗯嗯", source=Source.AMBIENT_AUDIO)
        assert decision.decision != "accept"
        assert "Low information density" in decision.reason

    def test_informative_utterance_accepted(self, runtime: MemoryRuntime) -> None:
        decision = Filter(runtime).evaluate(SPEECH, source=Source.AMBIENT_AUDIO)
        assert decision.decision == "accept"
        assert "Informative speech" in decision.reason

    def test_score_is_clamped_to_one(self, runtime: MemoryRuntime) -> None:
        decision = Filter(runtime).evaluate("一" * 200, source=Source.AMBIENT_AUDIO)
        assert 0.0 <= decision.score <= 1.0


class TestDedup:
    def test_repeat_of_remembered_input_rejected(self, runtime: MemoryRuntime) -> None:
        screen = Filter(runtime)
        assert screen.evaluate(SPEECH, source=Source.AMBIENT_AUDIO).decision == "accept"
        screen.remember(SPEECH)
        again = screen.evaluate(SPEECH, source=Source.AMBIENT_AUDIO)
        assert again.decision == "reject"
        assert "Duplicate of recent input" in again.reason
        assert again.score <= 1.0 - DEDUP_JACCARD

    def test_window_forgets_old_inputs(self, runtime: MemoryRuntime) -> None:
        screen = Filter(runtime, window=1)
        screen.remember(SPEECH)
        screen.remember("完全不同的另外一句话内容在这里")
        assert screen.evaluate(SPEECH, source=Source.AMBIENT_AUDIO).decision == "accept"

    def test_different_content_not_deduped(self, runtime: MemoryRuntime) -> None:
        screen = Filter(runtime)
        screen.remember(SPEECH)
        other = screen.evaluate("周末要去南山公园跑步锻炼", source=Source.AMBIENT_AUDIO)
        assert other.decision == "accept"


class TestExtraTriggers:
    def test_extra_trigger_can_only_lower_the_score(self, runtime: MemoryRuntime) -> None:
        """外挂筛选器取最保守的那个——M5 接熵触发器时就靠这条语义。"""

        class Paranoid:
            name = "AudioEntropyTrigger"

            def evaluate(self, text: str, *, source: Source, blob_id: str | None):
                return FilterDecision(decision="reject", score=0.01, reason="Low entropy")

        EXTRA_TRIGGERS.append(Paranoid())
        try:
            decision = Filter(runtime).evaluate(SPEECH, source=Source.AMBIENT_AUDIO)
        finally:
            EXTRA_TRIGGERS.clear()
        assert decision.decision == "reject"
        assert decision.reason == "AudioEntropyTrigger: Low entropy"

    def test_extra_trigger_returning_none_is_ignored(self, runtime: MemoryRuntime) -> None:
        class Abstains:
            name = "VisualEntropyTrigger"

            def evaluate(self, text: str, *, source: Source, blob_id: str | None):
                return None

        EXTRA_TRIGGERS.append(Abstains())
        try:
            decision = Filter(runtime).evaluate(SPEECH, source=Source.AMBIENT_AUDIO)
        finally:
            EXTRA_TRIGGERS.clear()
        assert decision.decision == "accept"

    def test_extra_triggers_empty_this_round(self) -> None:
        """本轮不接 SimpleMem 的两个 Trigger，推迟到 M5，见模块文档。"""
        assert EXTRA_TRIGGERS == []


class TestDecisionShape:
    def test_to_dict_matches_contract_fields(self, runtime: MemoryRuntime) -> None:
        body = Filter(runtime).evaluate(SPEECH, source=Source.AMBIENT_AUDIO).to_dict()
        assert set(body) == {"decision", "score", "reason"}


class TestFillersAndQuestions:
    """低信息量那条规则原来形同虚设。

    它数的是二元组（`len(t) >= 2`），而停用词表全是单字——那份表对中文一个都拦不住。
    实测「99% 是废话」那个演示场景里，八句废话记了五句：
    「嗯……那个……我看看啊」拿到 0.75 分，直接 accept。
    """

    def test_pure_filler_scores_zero(self, runtime: MemoryRuntime) -> None:
        for noise in ["嗯嗯嗯，好的好的", "唉，行吧", "呃……那个……"]:
            d = Filter(runtime).evaluate(noise, source=Source.AMBIENT_AUDIO)
            assert d.decision == "reject", noise

    def test_filler_wrapped_utterance_is_not_informative(self, runtime: MemoryRuntime) -> None:
        d = Filter(runtime).evaluate("嗯……那个……我看看啊", source=Source.AMBIENT_AUDIO)
        assert d.decision == "reject"

    def test_a_real_commitment_still_gets_through(self, runtime: MemoryRuntime) -> None:
        d = Filter(runtime).evaluate("下周三下午三点体检，别忘了空腹", source=Source.AMBIENT_AUDIO)
        assert d.decision == "accept"

    def test_questions_are_dropped_before_the_model_is_called(self, runtime: MemoryRuntime) -> None:
        """压缩器本来就不记问句，在筛选这一层拦住能省一次模型调用。"""
        for q in ["外卖到了吗？", "外卖到了吗", "你在干嘛呢", "现在几点？"]:
            d = Filter(runtime).evaluate(q, source=Source.AMBIENT_AUDIO)
            assert d.decision == "reject", q
            assert d.reason == "Question, not a statement"

    def test_a_statement_with_a_question_mark_inside_still_counts(
        self, runtime: MemoryRuntime
    ) -> None:
        """只看句尾：中间带问号的陈述句不该被误伤。"""
        d = Filter(runtime).evaluate(
            "他问我周三体检的事，我说定在下午三点", source=Source.AMBIENT_AUDIO
        )
        assert d.decision == "accept"
