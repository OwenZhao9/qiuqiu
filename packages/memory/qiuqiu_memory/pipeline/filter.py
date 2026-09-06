"""筛选：留 / 丢 / 拿不准。**只筛被动采集**（AD-3）。

主动输入（`DIALOGUE` `JOURNAL`）压根不进这个模块——用户自己打的字、自己写的日记，
没有「这是不是噪音」的问题，跳过筛选直接压缩。

判定规则按契约 v0.1.5 的 `/config/thresholds`：

    score >= accept(默认 0.72)     → accept
    score >= uncertain(默认 0.45)  → uncertain
    否则                           → reject

阈值从 SQLite `settings` 读（`thresholds` 整块 JSON，或 `thresholds.accept` /
`thresholds.uncertain` 两个键），`PUT /config/thresholds` 改完立刻生效，不用重启。

本轮的三条启发式，全是确定性的、不调模型：

1. **静音 / 空帧**：转写为空、只有空白或只有标点 → score 0，理由 `Silence detected`。
   进到这一层的已经是文本了：环境音由后端 VAD + ASR 转写（ARCHITECTURE § 6），
   图片由后端调 Vision 生成描述（AD-15），中间件不碰音频字节也不碰像素。
2. **问句**：以「？」「吗」「呢」收尾的直接丢。压缩器本来就明写不记问句，
   在这里先拦一道，省掉一次白跑的模型调用。
3. **Jaccard 去重**：与最近若干条被动输入比 token 重合度，过线判重复。
4. **低信息量**：去掉填充词与停用词之后，按剩下的**字**数打分，
   `score = n / LOW_INFO_FULL`。数字不数二元组——二元组会让任何一句话都满分。

推迟到 M5 的部分见 `EXTRA_TRIGGERS`。
"""

from __future__ import annotations

import re
from collections import deque
from typing import Any, Protocol

import structlog

from ..text import content_units, jaccard, preview, tokenize
from ..types import FilterDecision, Source

__all__ = [
    "DEDUP_JACCARD",
    "EXTRA_TRIGGERS",
    "Filter",
    "LOW_INFO_FULL",
    "Trigger",
]

log = structlog.get_logger("qiuqiu_memory.filter")

LOW_INFO_FULL = 8
"""内容 token 数到这个量就算信息量满格（score 封顶 1.0）。"""

DEDUP_JACCARD = 0.80
"""与最近输入的 token 重合度超过它就判重复。"""

DEFAULT_WINDOW = 20

_PUNCT_ONLY_RE = re.compile(r"^[\s\W_]*$", re.UNICODE)

_SILENCE_REASON: dict[Source, str] = {
    Source.AMBIENT_AUDIO: "Silence detected",
    Source.AMBIENT_IMAGE: "Blank frame detected",
}


class Trigger(Protocol):
    """额外筛选器的形状。返回 `None` 表示「这条我不管」。

    M5 接入 SimpleMem 多模态路径的 `AudioEntropyTrigger` / `VisualEntropyTrigger`
    时，把它们包成这个形状塞进 `EXTRA_TRIGGERS` 就行，本模块其余部分不用动。
    """

    name: str

    def evaluate(
        self, text: str, *, source: Source, blob_id: str | None
    ) -> FilterDecision | None: ...


EXTRA_TRIGGERS: list[Trigger] = []
"""外挂筛选器，取所有非空结果里分数最低的那个。

**M5 再填。** 本轮为什么不接 SimpleMem 的两个 Trigger：
1. PyPI 上的 `simplemem==0.1.0` 里**没有** `multimodal/triggers/` 这个包，
   那两个类只在 GitHub 仓库里，装不到；
2. `simplemem` 依赖 `sentence-transformers` → `torch`，装进来会让本包多几百 MB，
   而且它自带的嵌入路径首次调用就下权重，跟「测试与冒烟绝不下权重」冲突；
3. 它直接吃 `openai` 客户端调模型，绕开 `qiuqiu_models.registry`，跟 AD-8 冲突。
M5 接语音链路时的做法：把那两个 Trigger 的熵计算（纯 numpy）按 MIT 许可 vendor 过来，
包成上面的 `Trigger` 形状，**不**引入 `simplemem` 整包。
"""


#: 问句的收尾。压缩器本来就明写「任何一方说的问句都不记」，在这里先拦一道，
#: 省掉一次白跑的模型调用。
_QUESTION_RE = re.compile(r"[？?]\s*$|吗[。！!.\s]*$|呢[。！!.\s]*$")


def _content_tokens(text: str) -> list[str]:
    """一句话里的信息单元。见 `text.content_units`。

    原来这里数的是二元组（`len(t) >= 2`），而停用词表全是单字——那份表对中文
    一个都拦不住，「嗯……那个……我看看啊」也能拿 0.75 分被记下来。
    """
    return content_units(text)


class Filter:
    """被动采集的筛选器。持有一个最近输入的滑动窗口用于去重。"""

    def __init__(self, runtime: Any, *, window: int | None = None) -> None:
        self.runtime = runtime
        size = window if window is not None else int(runtime.thresholds.get("dedup_window"))
        self._recent: deque[tuple[str, frozenset[str]]] = deque(maxlen=max(1, size))

    def remember(self, text: str) -> None:
        """把一条通过筛选的输入放进去重窗口。"""
        self._recent.append((text, frozenset(tokenize(text))))

    def forget_recent(self) -> None:
        """清空去重窗口。

        演示场景回放要用：同一个脚本点第二次，上一次的句子还在窗口里，
        每一句都判成「重复」，那个「99% 是废话，但那 1% 记住了」就演不出来。
        一次回放是一段独立的模拟会话，不该继承上一次的窗口。
        """
        self._recent.clear()

    def evaluate(
        self,
        text: str,
        *,
        source: Source,
        blob_id: str | None = None,
    ) -> FilterDecision:
        """给一条被动输入打分并判定。**不发事件**——发事件是门面的事。"""
        raw = text or ""

        # 1) 静音 / 空帧
        if _PUNCT_ONLY_RE.match(raw):
            return self._decide(0.0, _SILENCE_REASON.get(source, "Empty input"))

        # 2) 问句不记。压缩器那边本来就不记问句，早点拦住省一次模型调用
        if _QUESTION_RE.search(raw.strip()):
            return self._decide(0.0, "Question, not a statement")

        tokens = frozenset(tokenize(raw))

        # 3) 与最近输入去重
        best_similarity, best_text = 0.0, ""
        for previous_text, previous_tokens in self._recent:
            similarity = jaccard(tokens, previous_tokens)
            if similarity > best_similarity:
                best_similarity, best_text = similarity, previous_text
        if best_similarity >= DEDUP_JACCARD:
            reason = (
                f"Duplicate of recent input (Jaccard {best_similarity:.2f}): "
                f"{preview(best_text, 24)}"
            )
            return self._decide(round(1.0 - best_similarity, 4), reason)

        # 4) 低信息量
        count = len(set(_content_tokens(raw)))
        score = round(min(1.0, count / LOW_INFO_FULL), 4)
        reason = (
            f"Informative speech ({count} content tokens)"
            if score >= self.runtime.thresholds.accept
            else f"Low information density ({count} content tokens)"
        )
        decision = self._decide(score, reason)

        # 4) 外挂筛选器（M5 才有东西）：取最保守的那个
        for trigger in EXTRA_TRIGGERS:
            extra = trigger.evaluate(raw, source=source, blob_id=blob_id)
            if extra is not None and extra.score < decision.score:
                decision = self._decide(extra.score, f"{trigger.name}: {extra.reason}")
        return decision

    def _decide(self, score: float, reason: str) -> FilterDecision:
        return FilterDecision(
            decision=self.runtime.thresholds.decide(score),
            score=score,
            reason=reason,
        )
