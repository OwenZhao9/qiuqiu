"""性格沉淀：从**原始会话**里归纳相处出来的性格（AD-4）。

输入只有一处：SQLite `messages` 表最近 N 轮（默认 50）。**不读 `facts_hot` /
`facts_cold` / `visible_memory`**——压缩过的事实是「他说了什么」，而语气、称呼、话多话少
这些东西只在原话里。这条是 AD-4，有一条测试盯着不许读事实表。

四件产出，合成 `Learned`（CONTRACTS § 1）：`nickname` 称呼习惯、`humor_tolerance`
玩笑尺度、`topics` 话题偏好、`reply_length` 回应长度。

**增量合并**：新版本与 `persona_learned.latest()` 合，新值覆盖、缺失沿用。所以一次没归纳
出称呼不会把上次学到的称呼抹掉——`Learned.to_dict()` 只输出非 `None` 的键就是为了这个。

写两处：`persona_learned` 追加一版（历史永不覆盖），冷存储写一条性格档案。
之后由 `PersonaService.recompute()` 重算热存储快照（AD-2）。

触发方是后端定时任务（轮数达 `settings.consolidate_every`，默认 20），**本层不自带调度器**。
"""

from __future__ import annotations

import re
from collections import deque
from typing import Any

import structlog

from ..llm import ChatUnavailable, complete_json
from ..text import entities_of, estimate_tokens, tokenize
from ..types import Learned, iso, to_utc

__all__ = ["DEFAULT_ROUNDS", "consolidate", "recent_messages"]

log = structlog.get_logger("qiuqiu_memory.consolidate")

DEFAULT_ROUNDS = 50
"""默认读最近多少条原始消息。任务书里的 N。"""

COLD_PROFILE_ID = "persona_profile"
"""冷存储里性格档案那条的 id 前缀，形如 `persona_profile_v3`。"""

_SYSTEM = (
    "你是性格观察者。看一段用户与桌宠丘丘的原始对话，归纳出用户希望丘丘怎么跟他相处，"
    "只输出 JSON，不要解释。归纳的是**相处方式**，不是对话内容里的事实。"
)

_USER_TEMPLATE = """下面是最近 {count} 条原始对话（越靠后越新）：

{transcript}

归纳四件事：
1. nickname：用户希望被怎么称呼。对话里明确说过「叫我 X」才填，没说就填 null
2. humor_tolerance：0 到 100，玩笑尺度。用户爱开玩笑、爱接梗就高，一本正经就低
3. topics：常聊的话题，最多 6 个短词
4. reply_length：用户偏好的回复长度，short / medium / long 三选一

只输出这个 JSON，拿不准的键填 null：
{{"nickname": null, "humor_tolerance": 50, "topics": [], "reply_length": "medium"}}
"""

_NICKNAME_RE = re.compile(r"(?:叫我|喊我|管我叫|称呼我(?:为|作)?)\s*([^\s，,。！!？?、]{1,8})")
_HUMOR_RE = re.compile(r"(哈哈|hh|233|笑死|梗|逗|调侃|皮一下|开个玩笑|😂|🤣)")
_SERIOUS_RE = re.compile(r"(正经|认真点|别闹|严肃|不要开玩笑)")


PAGE = 500
"""翻 `messages` 表时的单页条数。"""


def _session_tail(runtime: Any, session_id: str, limit: int) -> list[dict[str, Any]]:
    """一个会话里**最后** `limit` 条消息。

    `qiuqiu_data.sqlite.list_messages` 只有「按 `created_at` 升序 + limit/offset」，
    直接 `limit=N` 拿到的是**最早** N 条，正好跟这里要的相反。没有 count 也没有倒序，
    只能翻页翻到尾，用一个定长窗口滚着接。桌面单机的消息表量级不大，这个代价可以接受。
    """
    window: deque[dict[str, Any]] = deque(maxlen=max(1, limit))
    offset = 0
    while True:
        rows = runtime.sqlite.list_messages(session_id, limit=PAGE, offset=offset)
        if not rows:
            break
        window.extend(rows)
        if len(rows) < PAGE:
            break
        offset += PAGE
    return list(window)


def recent_messages(runtime: Any, limit: int = DEFAULT_ROUNDS) -> list[dict[str, Any]]:
    """最近 N 条原始消息，按时间升序。**只碰 `messages` 表**（AD-4）。

    `qiuqiu_data.sqlite` 没有跨会话的「最近 N 条」，所以这里先列会话、各取尾巴再归并。
    契约缺口已在汇报里写明，等 data 补 `list_recent_messages(limit)` 之后这段可以删掉。
    """
    rows: list[dict[str, Any]] = []
    for session in runtime.sqlite.list_sessions(archived=None, limit=100):
        rows.extend(_session_tail(runtime, session["id"], limit))
    rows.sort(key=lambda r: (str(r.get("created_at") or ""), str(r.get("id") or "")))
    return rows[-limit:]


def _transcript(rows: list[dict[str, Any]]) -> str:
    label = {"user": "用户", "assistant": "丘丘"}
    return "\n".join(
        f"{label.get(str(r.get('role')), str(r.get('role')))}：{r.get('content') or ''}"
        for r in rows
    )


async def _ask(runtime: Any, rows: list[dict[str, Any]]) -> Learned | None:
    """问 Chat 归纳一版。模型不可用或答得不成形状返回 `None`，调用方走确定性兜底。"""
    try:
        parsed = await complete_json(
            runtime,
            system=_SYSTEM,
            user=_USER_TEMPLATE.format(count=len(rows), transcript=_transcript(rows)),
            stage="consolidate",
        )
    except ChatUnavailable:
        log.warning("consolidate.chat_unavailable")
        return None
    if not isinstance(parsed, dict):
        return None
    return Learned.from_dict(parsed)


def _heuristic(rows: list[dict[str, Any]]) -> Learned:
    """不调模型也能归纳个大概：称呼靠句式，玩笑尺度靠词频，长度靠平均字数。

    比不归纳强：离线跑演示时性格照样会变，只是没那么准。
    """
    user_rows = [r for r in rows if str(r.get("role")) == "user"]
    if not user_rows:
        return Learned()
    texts = [str(r.get("content") or "") for r in user_rows]

    nickname = None
    for text in reversed(texts):
        found = _NICKNAME_RE.search(text)
        if found:
            nickname = found.group(1)
            break

    playful = sum(len(_HUMOR_RE.findall(t)) for t in texts)
    serious = sum(len(_SERIOUS_RE.findall(t)) for t in texts)
    humor = max(0, min(100, 50 + playful * 8 - serious * 20))

    average = sum(estimate_tokens(t) for t in texts) / len(texts)
    reply_length = "short" if average < 12 else ("long" if average > 40 else "medium")

    counter: dict[str, int] = {}
    for text in texts:
        for entity in entities_of(text):
            if len(entity) >= 2 and not entity.isascii():
                counter[entity] = counter.get(entity, 0) + 1
    topics = [word for word, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:6]]

    return Learned(
        nickname=nickname,
        humor_tolerance=humor,
        topics=topics or None,
        reply_length=reply_length,
    )


def _write_cold_profile(runtime: Any, learned: Learned, version: int) -> str | None:
    """性格档案写冷存储。写不进去不算失败——`persona_learned` 才是权威副本。"""
    body = _profile_text(learned)
    if not body:
        return None
    moment = runtime.now()
    fact_id = f"{COLD_PROFILE_ID}_v{version}"
    try:
        runtime.lance.upsert(
            [
                {
                    "id": fact_id,
                    "text": body,
                    "vector": runtime.embedder.embed_one(body),
                    "tokens": tokenize(body),
                    "entities": ["性格档案", "用户"],
                    "speaker": "assistant",
                    # 契约的 source 取值域里没有「性格档案」这一类，先归到 journal，
                    # 建议契约补一个 `persona`，缺口已写进汇报。
                    "source": "journal",
                    "valid_from": moment,
                    "last_hit_at": moment,
                }
            ],
            "cold",
        )
    except Exception as exc:  # noqa: BLE001 - 冷表写失败不该让性格沉淀整体失败
        log.warning("consolidate.cold_profile_failed", error=str(exc))
        return None
    return fact_id


def _profile_text(learned: Learned) -> str:
    parts = []
    if learned.nickname:
        parts.append(f"用户希望被叫「{learned.nickname}」")
    if learned.humor_tolerance is not None:
        parts.append(f"玩笑尺度 {learned.humor_tolerance}")
    if learned.reply_length:
        parts.append(f"偏好{learned.reply_length}长度的回复")
    if learned.topics:
        parts.append("常聊" + "、".join(learned.topics))
    return "性格档案：" + "，".join(parts) + "。" if parts else ""


def consolidate(runtime: Any, *, rounds: int | None = None) -> Learned:
    """跑一次性格沉淀。同步函数——`PersonaService.run_consolidation()` 直接调。

    一条消息都没有时返回上一版（没有上一版就是空 `Learned`），**不写新版本**：
    空归纳写进去只会把学到的东西冲掉。
    """
    limit = rounds if rounds is not None else runtime.setting_int("consolidate_rounds")
    rows = recent_messages(runtime, limit)
    previous_row = runtime.sqlite.latest_persona_learned()
    previous = Learned.from_dict((previous_row or {}).get("learned_json"))
    if not rows:
        log.info("consolidate.skipped", reason="no_messages")
        return previous

    fresh = runtime.run(_ask(runtime, rows))
    used_llm = fresh is not None
    if fresh is None or not fresh.to_dict():
        fresh = _heuristic(rows)
    merged = previous.merge(fresh)

    saved = runtime.sqlite.append_persona_learned(merged.to_dict())
    version = int(saved.get("version") or 0)
    profile_id = _write_cold_profile(runtime, merged, version)

    log.info(
        "consolidate.done",
        rounds=len(rows),
        version=version,
        used_llm=used_llm,
        cold_profile=profile_id,
        at=iso(to_utc(runtime.now())),
    )
    return merged
