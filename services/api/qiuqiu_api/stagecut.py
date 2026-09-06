"""把回复里括号形式的动作描写（旁白）滤掉，边流边滤。

丘丘有表情引擎，那句话的情绪会被渲染到脸上；回复里再写一遍
「（愣了一下，随即叉腰，脸鼓成一团）」，聊天窗口读起来像剧本不像说话。
人格里已经硬性禁止（`persona.py::OUTPUT`），但用户一句「要有动作」就压不住，
实测照写不误，所以得有一道兜底。

**为什么放在后端、放在流上。** 这条规则原来只在前端显示层做了一遍，结果是：
屏幕上干净，语音合成用的却是原文——**丘丘念出来的比屏幕上写的多**，
存进库里的历史也带着旁白。同一条规则有两份实现，早晚对不上。
放在这里，delta、TTS、落库、下一轮喂给模型的历史，拿到的是同一份文本。

**滤哪些**：只滤开头、独占一行、以及结尾的全角括号组。句子中间的不碰——
那多半是真的补充说明（「我明天去（也可能后天）看看」），靠词表猜哪个是
动作描写迟早误伤。

**流式怎么判「在结尾」**：先扣住不发，后面又来了正文就把它放出来（说明它在中间），
一直到流结束都没有正文，才确认它在结尾、丢掉。所以扣住的那点延迟只发生在
真有括号的时候，正常说话一个字都不耽误。
"""

from __future__ import annotations

OPEN = "（"
CLOSE = "）"


class StageCut:
    """一段一段喂进来，吐出该显示的部分。用完要 `flush()`。"""

    def __init__(self) -> None:
        #: 还没定下来的一段（正在写的括号组，或者已经闭合但可能落在结尾的那组）
        self._held = ""
        #: 括号已经开了还没闭
        self._open = False
        #: 已经吐出去的正文里，最后一个字符是不是换行（或者还什么都没吐过）
        self._at_line_start = True
        #: 到目前为止吐过正文没有
        self._emitted_any = False
        #: 刚丢掉一个开头 / 独占一行的括号组，紧跟其后的空白要一起吃掉，
        #: 不然「好的。\n（转身走开）\n明天见。」会留下一个空行
        self._eat_space = False

    def feed(self, chunk: str) -> str:
        out: list[str] = []
        for ch in chunk:
            out.append(self._one(ch))
        return "".join(out)

    def _one(self, ch: str) -> str:
        if self._open:
            self._held += ch
            if ch == CLOSE:
                self._open = False
                # 开头或独占一行的，当场丢掉，不用等到流结束
                if self._held_is_leading:
                    self._held = ""
                    self._eat_space = True
            return ""

        if self._eat_space:
            if ch.isspace():
                return ""
            self._eat_space = False

        if self._held:
            # 手里扣着一个已经闭合的括号组，正在等它到底在中间还是在结尾
            if ch.isspace():
                self._held += ch
                return ""
            # 后面还有正文 → 它在中间，是真的补充说明，放出来
            text = self._held + ch
            self._held = ""
            self._remember(text)
            return text

        if ch == OPEN:
            self._open = True
            self._held = ch
            self._held_is_leading = not self._emitted_any or self._at_line_start
            return ""

        self._remember(ch)
        return ch

    def _remember(self, text: str) -> None:
        for ch in text:
            if not ch.isspace():
                self._emitted_any = True
            self._at_line_start = ch == "\n"

    #: `_one` 里赋值，放在这儿只是给个默认值
    _held_is_leading = False

    def flush(self) -> str:
        """流结束。扣住的那部分要么是结尾的旁白（丢），要么是没写完的括号（放）。"""
        held, self._held = self._held, ""
        if self._open:
            # 括号开了没闭，多半是被截断了。宁可多显示，也别把正文吞掉
            self._open = False
            return held
        # 闭合的、后面再没有正文 → 它在结尾，是旁白
        return ""


def strip_stage_directions(text: str) -> str:
    """一次性版本，给非流式的地方用。"""

    cut = StageCut()
    return (cut.feed(text) + cut.flush()).strip()
