"""`text.py` 的确定性工具。压缩兜底、去重、字面路全靠它，所以单独钉住。"""

from __future__ import annotations

import datetime as dt

from qiuqiu_memory.text import (
    absolutize_time,
    clauses,
    entities_of,
    estimate_tokens,
    jaccard,
    normalize_query_person,
    preview,
    resolve_pronouns,
    speaker_label,
    tokenize,
)

NOW = dt.datetime(2026, 9, 5, 10, 0, tzinfo=dt.UTC)


class TestTokenize:
    def test_cjk_splits_into_chars_and_bigrams(self) -> None:
        tokens = tokenize("咖啡")
        assert "咖" in tokens and "啡" in tokens and "咖啡" in tokens

    def test_latin_and_digits_stay_whole_and_lowercase(self) -> None:
        assert set(tokenize("Latte 3.5 元")) >= {"latte", "3.5"}

    def test_punctuation_never_becomes_a_token(self) -> None:
        assert tokenize("。，！？…") == []

    def test_order_stable_and_deduplicated(self) -> None:
        tokens = tokenize("咖啡咖啡")
        assert len(tokens) == len(set(tokens))

    def test_empty_input(self) -> None:
        assert tokenize("") == []


class TestJaccard:
    def test_identical_sets(self) -> None:
        assert jaccard(["a", "b"], ["b", "a"]) == 1.0

    def test_disjoint_sets(self) -> None:
        assert jaccard(["a"], ["b"]) == 0.0

    def test_empty_side_is_zero_not_error(self) -> None:
        assert jaccard([], ["a"]) == 0.0


class TestPronouns:
    def test_user_speaking(self) -> None:
        assert resolve_pronouns("我喜欢你", speaker="user") == "用户喜欢丘丘"

    def test_assistant_speaking_flips_sides(self) -> None:
        assert resolve_pronouns("我记住你说的", speaker="assistant").startswith("丘丘记住用户")

    def test_third_person_left_alone(self) -> None:
        """没上下文时改不准，宁可不改。"""
        assert "他" in resolve_pronouns("他昨天来过", speaker="user")

    def test_speaker_label_falls_back_to_raw(self) -> None:
        assert speaker_label("user") == "用户"
        assert speaker_label("") == "用户"

    def test_query_person_normalized_only_at_head(self) -> None:
        assert normalize_query_person("他喜欢喝什么") == "用户喜欢喝什么"
        assert normalize_query_person("周末和他去哪") == "周末和他去哪"


class TestAbsolutizeTime:
    def test_yesterday_becomes_a_date(self) -> None:
        assert "2026-09-04" in absolutize_time("昨天喝了咖啡", NOW)

    def test_next_week_offsets_seven_days(self) -> None:
        assert "2026-09-12" in absolutize_time("下周去深圳", NOW)

    def test_vague_words_untouched(self) -> None:
        assert absolutize_time("过阵子再说", NOW) == "过阵子再说"


class TestEntities:
    def test_name_pattern(self) -> None:
        assert "赵宁" in entities_of("用户叫赵宁")

    def test_leading_pronoun_stripped(self) -> None:
        """「叫我小赵」抽出来的该是「小赵」，不是「我小赵」。"""
        assert "小赵" in entities_of("叫我小赵")

    def test_moved_to_pattern(self) -> None:
        assert "深圳" in entities_of("用户搬到深圳了")

    def test_latin_words_included_lowercase(self) -> None:
        assert "latte" in entities_of("用户喜欢 Latte")

    def test_extra_merged_and_capped(self) -> None:
        found = entities_of("用户喜欢咖啡", extra=[f"e{i}" for i in range(12)])
        assert len(found) <= 8


class TestMisc:
    def test_clauses_split_on_punctuation(self) -> None:
        assert clauses("我叫赵宁，我喜欢咖啡。介绍一下自己") == [
            "我叫赵宁",
            "我喜欢咖啡",
            "介绍一下自己",
        ]

    def test_preview_is_single_line_and_capped(self) -> None:
        out = preview("一" * 200, 20)
        assert len(out) == 20 and out.endswith("…")

    def test_preview_keeps_short_text(self) -> None:
        assert preview("短句") == "短句"

    def test_estimate_tokens_counts_characters(self) -> None:
        assert estimate_tokens("abc") == 3
        assert estimate_tokens("") == 0
