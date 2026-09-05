"""压缩：把一段话拆成若干条**自包含**的原子事实。

三件事，对应 SimpleMem 的 F_θ = Φ_time ∘ Φ_coref ∘ Φ_extract：

- **代词消解**：事实里不留「我 / 你 / 他」这种离开上下文就看不懂的词
- **时间绝对化**：「明天」换成具体日期，用的是 `ingest(ts=...)` 传进来的那个时间
  （场景回放靠这个偏移，不动系统时钟）
- **拆原子事实**：一句话里几件事就拆几条，每条单独拿出来也读得懂

`JOURNAL` 额外出一段摘要。压缩完写热表，发 `write` 事件。

**两条路径。** 首选调 Chat 出 JSON；模型没吐合法 JSON 时（`MODELS_MOCK=1` 的固定回复
就是这种情况）走确定性兜底：按句读切小句、规则消解、规则抽实体。兜底比不做强得多，
离线链路因此完整可跑。Chat **调用失败**是另一回事——那会抛 `ChatUnavailable`，
由门面按 ARCHITECTURE § 3 处理（返回空 accepted、记指标、不重试）。

`blob_id` 原样挂到每条事实上（CONTRACTS § 5 的 `blob_id` 列「指向原图 / 原文 / 音频」）。
被动采集的原始音频与图片处理完就能删，事实这边只留指针，界面点开一条被动记忆时靠它回溯原件。

`dropped_spans` 记的是「读进来了但没变成事实的部分」，例如指令、寒暄、纯语气词。
它是「记忆过程看得见」的一部分：侧栏要能显示丘丘**没记**什么。
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog

from ..llm import complete_json
from ..text import (
    absolutize_time,
    clauses,
    entities_of,
    resolve_pronouns,
    speaker_label,
    tokenize,
)
from ..types import Source, iso, to_utc

__all__ = ["CompressResult", "Fact", "compress", "new_fact_id"]

log = structlog.get_logger("qiuqiu_memory.compress")

#: 这些小句是说给丘丘听的指令或纯寒暄，不构成事实
_INSTRUCTION_RE = re.compile(
    r"(用一句话|介绍你自己|帮我|帮忙|请你|请问|告诉我|给我讲|再说一遍|翻译|"
    r"总结一下|写一[篇段句]|生成一|画一|怎么办|怎么样|好不好|能不能|可不可以|"
    r"[吗呢]$|[?？]$)"
)
_SMALLTALK = frozenset(
    {"你好", "您好", "谢谢", "多谢", "再见", "拜拜", "好的", "行", "嗯", "哦", "哈哈", "在吗"}
)


def new_fact_id() -> str:
    return "fact_" + uuid.uuid4().hex[:12]


@dataclass(slots=True)
class Fact:
    """一条原子事实。字段名对齐 LanceDB `facts` 表（CONTRACTS § 5）。"""

    id: str
    text: str
    entities: list[str]
    tokens: list[str]
    speaker: str
    source: str
    valid_from: dt.datetime
    blob_id: str | None = None
    vector: list[float] = field(default_factory=list)

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "vector": self.vector,
            "tokens": self.tokens,
            "entities": self.entities,
            "speaker": self.speaker,
            "source": self.source,
            "valid_from": self.valid_from,
            "last_hit_at": self.valid_from,
            "blob_id": self.blob_id,
        }

    def to_event_fact(self) -> dict[str, Any]:
        """`write` 事件里的 fact 形状（CONTRACTS § 1）。"""
        return {
            "id": self.id,
            "text": self.text,
            "entities": list(self.entities),
            "valid_from": iso(self.valid_from),
        }


@dataclass(slots=True)
class CompressResult:
    facts: list[Fact] = field(default_factory=list)
    summary: str | None = None
    dropped_spans: list[str] = field(default_factory=list)
    used_llm: bool = False


_SYSTEM = (
    "你是长期记忆的压缩器，为一个陪伴用户的桌宠服务。"
    "你的唯一判据是：**这条信息以后再见到用户时还用得上吗**。"
    "用得上的才记，其余一概丢掉，宁可一条不记也不要记废话。"
    "只输出 JSON，不要任何解释。"
)

#: 提示词里的稳定标记。测试靠它认出「这是压缩请求」，
#: 措辞可以随便改，别改这个词。
COMPRESS_MARKER = "记忆压缩"

_USER_TEMPLATE = (
    COMPRESS_MARKER
    + """任务。把下面这句话拆成原子事实。

说话人：{who}
说话时间：{when}
来源：{source}
原文：{raw}

**先判断该不该记**。只记跟这个用户本人有关、以后还用得上的：

- 记：身份（名字、住处、职业）、稳定偏好、正在做的事、约定与待办、
  关系（家人朋友宠物）、重要经历、明确的喜恶
- **不记**：世界常识与科普（「编码是获取信息并转化为大脑能处理的形式」这类，
  模型自己就知道，存了纯属占地方）、任何一方说的问句、寒暄与客套、
  对当下这轮对话的复述（「丘丘做了自我介绍」「丘丘询问用户想聊什么」）、
  临时的天气与心情闲聊

**这一句没有任何值得长期记住的东西，就给空数组**——这是常态，不是失败。

写法：
1. 每条单独拿出来也读得懂：主语补成具体的人名，别用代词
2. 一条只讲一件事；但别把一件事拆成好几条
3. **不要在正文里写时间戳**。日期只在事情本身跟日期有关时才写（「三月要搬家」），
   写成「2026-03」这种人能读的样子。绝不要出现 `2026-09-05T09:27:22.192Z`
4. 提到用户就用他的名字；还不知道名字才写「用户」。不要写「听话人」「对话对象」
5. entities 填人名、地名、机构、产品、具体事物，没有就空数组
6. dropped_spans 填原文里没变成事实的片段：问句、寒暄、常识、语气词
7. summary 只在来源是 journal 时填一段不超过 80 字的摘要，其余填 null

只输出这个 JSON：
{{"facts": [{{"text": "...", "entities": ["..."]}}], "dropped_spans": ["..."], "summary": null}}
"""
)


async def compress(
    runtime: Any,
    text: str,
    *,
    source: Source,
    speaker: str,
    ts: dt.datetime,
    trace_id: str,
    blob_id: str | None = None,
) -> CompressResult:
    """压缩一段话，写热表，发 `write` 事件。返回写进去的事实。"""
    moment = to_utc(ts)
    parsed = await complete_json(
        runtime,
        system=_SYSTEM,
        user=_USER_TEMPLATE.format(
            who=speaker_label(speaker),
            when=iso(moment),
            source=source.value,
            raw=text,
        ),
        stage="compress",
    )

    result = _from_llm(
        parsed, text=text, speaker=speaker, source=source, moment=moment, blob_id=blob_id
    )
    if result is None:
        result = _fallback(text, speaker=speaker, source=source, moment=moment, blob_id=blob_id)

    if source is Source.JOURNAL and not result.summary:
        result.summary = _naive_summary(text)

    _embed_and_store(runtime, result.facts)

    runtime.bus.emit(
        "write",
        {
            "raw": text,
            "speaker": speaker,
            "facts": [f.to_event_fact() for f in result.facts],
            "dropped_spans": list(result.dropped_spans),
        },
        trace_id=trace_id,
    )
    log.info(
        "compress.done",
        trace_id=trace_id,
        facts=len(result.facts),
        dropped=len(result.dropped_spans),
        used_llm=result.used_llm,
    )
    return result


# ---------- 模型路径 ----------


def _from_llm(
    parsed: Any,
    *,
    text: str,
    speaker: str,
    source: Source,
    moment: dt.datetime,
    blob_id: str | None = None,
) -> CompressResult | None:
    """把模型的 JSON 转成事实。形状不对就返回 `None`，让调用方走兜底。"""
    if not isinstance(parsed, dict) or not isinstance(parsed.get("facts"), list):
        return None
    facts: list[Fact] = []
    for item in parsed["facts"]:
        if not isinstance(item, dict):
            continue
        body = str(item.get("text") or "").strip()
        if not body:
            continue
        extra = item.get("entities")
        facts.append(
            _make_fact(
                body,
                speaker=speaker,
                source=source,
                moment=moment,
                extra_entities=[str(e) for e in extra] if isinstance(extra, list) else [],
                blob_id=blob_id,
            )
        )
    dropped = parsed.get("dropped_spans")
    summary = parsed.get("summary")
    return CompressResult(
        facts=facts,
        summary=str(summary) if isinstance(summary, str) and summary.strip() else None,
        dropped_spans=[str(d) for d in dropped] if isinstance(dropped, list) else [],
        used_llm=True,
    )


# ---------- 确定性兜底 ----------


def _fallback(
    text: str,
    *,
    speaker: str,
    source: Source,
    moment: dt.datetime,
    blob_id: str | None = None,
) -> CompressResult:
    """不调模型也能拆：按句读切小句，规则消解、规则抽实体。"""
    facts: list[Fact] = []
    dropped: list[str] = []
    for clause in clauses(text):
        if _INSTRUCTION_RE.search(clause) or clause in _SMALLTALK:
            dropped.append(clause)
            continue
        body = absolutize_time(resolve_pronouns(clause, speaker=speaker), moment)
        if not [t for t in tokenize(body) if len(t) >= 2]:
            dropped.append(clause)
            continue
        facts.append(
            _make_fact(body, speaker=speaker, source=source, moment=moment, blob_id=blob_id)
        )
    return CompressResult(facts=facts, dropped_spans=dropped, used_llm=False)


def _naive_summary(text: str, limit: int = 80) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _make_fact(
    body: str,
    *,
    speaker: str,
    source: Source,
    moment: dt.datetime,
    extra_entities: list[str] | None = None,
    blob_id: str | None = None,
) -> Fact:
    return Fact(
        id=new_fact_id(),
        text=body,
        entities=entities_of(body, extra=[speaker_label(speaker), *(extra_entities or [])]),
        tokens=tokenize(body),
        speaker=speaker,
        source=source.value,
        valid_from=moment,
        blob_id=blob_id,
    )


def _embed_and_store(runtime: Any, facts: list[Fact]) -> None:
    """一批算向量、一次写热表。空批直接返回，不去碰嵌入器（省得触发加载）。"""
    if not facts:
        return
    vectors = runtime.embedder.embed([f.text for f in facts])
    for fact, vector in zip(facts, vectors, strict=True):
        fact.vector = vector
    runtime.lance.upsert([f.to_row() for f in facts], "hot")
