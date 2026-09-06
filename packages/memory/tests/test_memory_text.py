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

    def test_weekday_anchors_to_the_week_not_plus_seven_days(self) -> None:
        """「下周五」要算成下周的那个周五，不是「今天 + 7 天」再把「五」剩下。

        这条是从真实记忆库里翻出来的：2026-09-06（周日）说「我下周五要去上海
        出差」，存进去的是「用户2026-09-13五要去上海出差」——09-13 是周日，
        而且末尾多个「五」。正确答案是 09-11。
        """
        sunday = dt.datetime(2026, 9, 6, 10, 0, tzinfo=dt.UTC)
        assert absolutize_time("我下周五要去上海出差", sunday) == "我2026-09-11要去上海出差"
        assert "五要去" not in absolutize_time("我下周五要去上海出差", sunday)

    def test_bare_weekday_takes_the_coming_one(self) -> None:
        """不带前缀的「周五」按口语取下一个周五；今天就是周五时取今天。"""
        sunday = dt.datetime(2026, 9, 6, 10, 0, tzinfo=dt.UTC)
        assert absolutize_time("周五去上海", sunday) == "2026-09-11去上海"
        friday = dt.datetime(2026, 9, 11, 10, 0, tzinfo=dt.UTC)
        assert absolutize_time("周五去上海", friday) == "2026-09-11去上海"

    def test_this_and_last_week_weekdays(self) -> None:
        """以周一为一周之始：周日说「本周五」指的是刚过去的那个 09-04。"""
        sunday = dt.datetime(2026, 9, 6, 10, 0, tzinfo=dt.UTC)
        assert absolutize_time("本周五", sunday) == "2026-09-04"
        assert absolutize_time("上周五", sunday) == "2026-08-28"
        assert absolutize_time("下下周三", sunday) == "2026-09-16"
        assert absolutize_time("这周日", sunday) == "2026-09-06"

    def test_weekend_is_not_a_weekday(self) -> None:
        """「周末」不是星期几，换成日期会得到「2026-09-13末」。"""
        sunday = dt.datetime(2026, 9, 6, 10, 0, tzinfo=dt.UTC)
        assert absolutize_time("下周末再说", sunday) == "下周末再说"
        assert absolutize_time("周末去爬山", sunday) == "周末去爬山"

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


class TestAmbientSpeaker:
    """契约 v0.1.8 § 5：被动采集的说话人未知，代词不解析。"""

    def test_unknown_speaker_leaves_pronouns_alone(self) -> None:
        """把环境音里的「我」解析成「用户」，就是把别人的话记成用户自己说的。

        `multi-person`（客厅里有三个人）正是这个场景：三个人的「我」指三个不同的人，
        一个都不该被认成用户。宁可留着代词不自包含，也不能记错归属。
        """
        from qiuqiu_memory.text import resolve_pronouns

        said = "我明天要去医院"
        assert resolve_pronouns(said, speaker="ambient") == said
        assert resolve_pronouns(said, speaker="user") != said  # 主动输入照常解析

    def test_ambient_has_a_third_person_label(self) -> None:
        from qiuqiu_memory.text import speaker_label

        assert speaker_label("ambient") == "某人"
