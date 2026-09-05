"""中文优先的轻量文本工具：切 token、算重合度、抽实体、代词消解、时间绝对化。

为什么不上分词器：jieba / 结巴之类会让 `packages/memory` 多一个几十 MB 的依赖，
而这一层要的只是「字面路的检索单元」和「去重用的重合度」，字 + 二元组已经够。
真正的语义判断交给 Chat（`pipeline/compress.py`），这里只做 Chat 不可用时的兜底
和所有确定性的预处理。

token 约定（对齐 `qiuqiu_data.lance` 的 FTS 配置：`base_tokenizer="simple"`，
不做词干还原、不去停用词）：
- 中日韩字符：单字 + 相邻二元组
- 拉丁字母与数字：整词小写
- 标点与空白：切分点，不进 token

因此 `query_fts` 的查询串要用 `" ".join(tokenize(q))` 传进去——simple 分词器按空白切，
两边用的是同一套 token，字面匹配才对得上。
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Iterable, Sequence

__all__ = [
    "STOPWORDS",
    "absolutize_time",
    "clauses",
    "entities_of",
    "estimate_tokens",
    "jaccard",
    "normalize_query_person",
    "preview",
    "resolve_pronouns",
    "speaker_label",
    "tokenize",
]

_CJK = r"一-鿿㐀-䶿぀-ヿ가-힯"
_WORD_RE = re.compile(rf"[{_CJK}]|[A-Za-z][A-Za-z0-9'_-]*|\d+(?:\.\d+)?")
_CJK_CHAR_RE = re.compile(rf"^[{_CJK}]$")

STOPWORDS: frozenset[str] = frozenset(
    {
        "的",
        "了",
        "着",
        "是",
        "在",
        "和",
        "与",
        "就",
        "都",
        "也",
        "很",
        "还",
        "个",
        "吧",
        "啊",
        "呢",
        "吗",
        "嗯",
        "哦",
        "呀",
        "a",
        "an",
        "the",
        "is",
        "are",
        "of",
        "to",
        "and",
    }
)
"""只用于实体抽取与低信息量判断，**不用于** token 化（FTS 那边关了停用词）。"""


def tokenize(text: str) -> list[str]:
    """切成字面路的检索单元。顺序稳定、去重后返回。"""
    units = _WORD_RE.findall(text or "")
    tokens: list[str] = []
    for i, unit in enumerate(units):
        tokens.append(unit.lower())
        if _CJK_CHAR_RE.match(unit) and i + 1 < len(units) and _CJK_CHAR_RE.match(units[i + 1]):
            tokens.append(unit + units[i + 1])
    return list(dict.fromkeys(tokens))


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    """两组 token 的 Jaccard 重合度。任一为空返回 0。"""
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def estimate_tokens(text: str) -> int:
    """粗略 token 数。与 `qiuqiu_models.providers.mock` 一样按字符算，只为给预算一个尺子。"""
    return len(text or "")


def preview(text: str, limit: int = 80) -> str:
    """事件里的 `input_preview` / `Rejection.preview`：单行、截断、带省略号。"""
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


_CLAUSE_SPLIT_RE = re.compile(r"[。！？!?；;\n]+|[，,、](?=\S)")


def clauses(text: str) -> list[str]:
    """按句读切成小句。压缩兜底与 `dropped_spans` 都以小句为单位。"""
    parts = [p.strip(" \t\r\n，,。！？!?；;、") for p in _CLAUSE_SPLIT_RE.split(text or "")]
    return [p for p in parts if p]


# ---------- 代词消解 ----------

_SPEAKER_LABELS = {"user": "用户", "assistant": "丘丘", "ambient": "某人"}


def speaker_label(speaker: str) -> str:
    """`user` / `assistant` 转成事实文本里用的第三人称标签。"""
    return _SPEAKER_LABELS.get(speaker, speaker or "用户")


def resolve_pronouns(text: str, *, speaker: str = "user") -> str:
    """把第一 / 第二人称换成确定的第三人称，让事实自包含（SimpleMem 的 Φ_coref）。

    `speaker` 是这句话的说话人：说话人的「我」是他自己，「你」是对面那个。
    第三人称的「他 / 她 / 它」在没有上下文时无从判断，原样保留——宁可不改，
    不能改错。
    """
    if speaker == "ambient":
        # 说话人未知，「我」是谁就无从判断。把它解析成「用户」会把别人说的话
        # 记成用户自己说的——multi-person 演示里客厅有三个人，正是这个场景。
        # 宁可留着代词不自包含，也不能记错归属。
        return text or ""
    me = speaker_label(speaker)
    you = _SPEAKER_LABELS["assistant"] if speaker == "user" else _SPEAKER_LABELS["user"]
    out = text or ""
    for pronoun, target in (
        ("我们", f"{me}和{you}"),
        ("咱们", f"{me}和{you}"),
        ("我", me),
        ("你们", you),
        ("你", you),
        ("您", you),
    ):
        out = out.replace(pronoun, target)
    return out


_QUERY_PRONOUN_RE = re.compile(r"^(他|她|它|我|你|您)(?=[的了们]?)")


def normalize_query_person(query: str) -> str:
    """检索改写用：查询里开头的人称统一成「用户」。

    「他喜欢喝什么」问的是这台机器认识的那个人——单机单用户，那就是用户本人。
    只动开头一处，句中的「他」可能真指第三方。
    """
    return _QUERY_PRONOUN_RE.sub("用户", query or "", count=1)


# ---------- 时间绝对化 ----------

_RELATIVE_DAYS: tuple[tuple[str, int], ...] = (
    ("前天", -2),
    ("昨天", -1),
    ("昨儿", -1),
    ("今天", 0),
    ("今儿", 0),
    ("明天", 1),
    ("明儿", 1),
    ("后天", 2),
)
_RELATIVE_WEEKS: tuple[tuple[str, int], ...] = (
    ("上上周", -14),
    ("上周", -7),
    ("上个星期", -7),
    ("这周", 0),
    ("本周", 0),
    ("下周", 7),
    ("下个星期", 7),
)


def absolutize_time(text: str, now: dt.datetime) -> str:
    """相对时间词换成绝对日期（SimpleMem 的 Φ_time）。

    只处理确定能算出来的那几个词；「以后」「过阵子」这种模糊表达不动。
    """
    out = text or ""
    for word, delta in (*_RELATIVE_DAYS, *_RELATIVE_WEEKS):
        if word in out:
            out = out.replace(word, (now + dt.timedelta(days=delta)).strftime("%Y-%m-%d"))
    return out


# ---------- 实体抽取 ----------

_ENTITY_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        rf"(?:叫做|叫)([{_CJK}A-Za-z0-9]{{2,6}})",
        rf"(?:搬到|搬去|去了|去过|到了)([{_CJK}]{{2,6}})",
        rf"(?:住在|住)([{_CJK}]{{2,6}})",
        rf"(?:喜欢|讨厌|想喝|想吃|爱吃|爱喝)([{_CJK}A-Za-z0-9]{{2,8}})",
        rf"(?:在)([{_CJK}]{{2,6}})(?:工作|上班|上学)",
    )
)
_LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9'_-]{1,}")
_LEADING_NOISE_RE = re.compile(r"^(?:喝|吃|看|听|玩|买|做|我|你|您|他|她|它)+")
"""抽出来的候选实体开头常粘着的动词或人称，剥掉——「叫我小赵」要的是「小赵」。"""

_TRAILING_NOISE_RE = re.compile(r"[了的吧呢啊呀吗]+$")
"""结尾的语气词同理——「搬到深圳了」要的是「深圳」。"""


def entities_of(text: str, *, extra: Sequence[str] = ()) -> list[str]:
    """标签路用的实体。规则抽取 + 调用方补充，去重、限量。

    抽不准是可以接受的：标签路只是三路之一，抽漏了还有语义路和字面路兜。
    抽错的代价更大，所以宁缺毋滥——只认几个明确的句式。
    """
    found: list[str] = [e for e in extra if e]
    for pattern in _ENTITY_PATTERNS:
        for match in pattern.findall(text or ""):
            candidate = _TRAILING_NOISE_RE.sub("", _LEADING_NOISE_RE.sub("", match)).strip()
            if len(candidate) >= 2 and candidate not in STOPWORDS:
                found.append(candidate)
    found.extend(w.lower() for w in _LATIN_RE.findall(text or ""))
    return list(dict.fromkeys(found))[:8]
