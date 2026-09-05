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
    "你是记忆压缩器。把对话拆成若干条自包含的原子事实，只输出 JSON，不要任何解释。"
    "硬性要求：事实里不许出现代词（我、你、他、这、那），"
    "不许出现相对时间（今天、昨天、上周），一律换成具体的人称与日期。"
)

_USER_TEMPLATE = """把下面这句话拆成原子事实。

说话人：{who}
说话时间：{when}
来源：{source}
原文：{raw}

要求：
1. 每条事实单独拿出来也读得懂：主语、宾语、时间、地点都补全
2. 一句话里有几件事就拆几条，不要合并；没有任何可记的事实就给空数组
3. entities 填人名、地名、机构、产品、具体事物，没有就空数组
4. dropped_spans 填原文里**没有**变成事实的片段，例如指令、寒暄、语气词
5. summary 只在来源是 journal 时填一段不超过 80 字的摘要，其余情况填 null

只输出这个 JSON：
{{"facts": [{{"text": "...", "entities": ["..."]}}], "dropped_spans": ["..."], "summary": null}}
"""


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
