"""括号旁白过滤器。

前端曾经只在显示层做过一遍，结果语音合成用的是原文——念出来的比屏幕上写的多。
这一份是唯一实现：delta、TTS、落库、下一轮的历史，拿到的是同一份文本。
"""

from __future__ import annotations

import pytest
from qiuqiu_api.stagecut import StageCut, strip_stage_directions


def stream(pieces: list[str]) -> str:
    cut = StageCut()
    return "".join(cut.feed(p) for p in pieces) + cut.flush()


class TestWhatGetsCut:
    def test_leading_stage_direction(self) -> None:
        assert (
            strip_stage_directions("（愣了一下，随即板起脸）哼！我现在很生气") == "哼！我现在很生气"
        )

    def test_trailing_stage_direction(self) -> None:
        assert strip_stage_directions("那就这么定了。（歪头笑）") == "那就这么定了。"

    def test_two_in_a_row(self) -> None:
        assert strip_stage_directions("（顿了顿）（叉腰）好啦。") == "好啦。"

    def test_on_its_own_line(self) -> None:
        assert strip_stage_directions("好的。\n（转身走开）\n明天见。") == "好的。\n明天见。"

    def test_nothing_to_cut(self) -> None:
        assert strip_stage_directions("哼，我不理你了。") == "哼，我不理你了。"


class TestWhatSurvives:
    """句中的括号多半是真的补充说明，按词表猜哪个是动作描写迟早误伤。"""

    def test_mid_sentence_parenthetical_stays(self) -> None:
        assert (
            strip_stage_directions("我明天去（也可能后天）看看。") == "我明天去（也可能后天）看看。"
        )

    def test_unclosed_paren_is_not_swallowed(self) -> None:
        """括号开了没闭多半是被截断了。宁可多显示，也别把正文吞掉。"""
        assert strip_stage_directions("说到一半（还没写完") == "说到一半（还没写完"


class TestStreaming:
    """一个字一个字喂，结果要和一次性喂完全一致。"""

    @pytest.mark.parametrize(
        "text",
        [
            "（愣了一下）哼！",
            "那就这么定了。（歪头笑）",
            "我明天去（也可能后天）看看。",
            "好的。\n（转身走开）\n明天见。",
            "（顿了顿）（叉腰）好啦。",
            "没有括号的一句话。",
        ],
    )
    def test_char_by_char_matches_one_shot(self, text: str) -> None:
        assert stream(list(text)) == strip_stage_directions(text)

    def test_chunk_boundary_inside_a_paren(self) -> None:
        """模型的分片会把括号劈成两半，不能因此漏掉。"""
        assert stream(["（愣了一", "下，随即叉腰）", "哼！"]) == "哼！"

    def test_正文一个字都不耽误(self) -> None:
        """没有括号时，喂进去多少当场吐出多少——不许攒着。"""
        cut = StageCut()
        assert cut.feed("今天") == "今天"
        assert cut.feed("天气不错") == "天气不错"
        assert cut.flush() == ""

    def test_中间的括号最终会放出来(self) -> None:
        cut = StageCut()
        out = cut.feed("我明天去（也可能后天）")
        assert out == "我明天去"  # 扣住，还不知道它在中间还是结尾
        out += cut.feed("看看。")
        assert out == "我明天去（也可能后天）看看。"
        assert cut.flush() == ""
