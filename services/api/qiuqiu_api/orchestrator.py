"""对话编排。**全仓库唯一调 `ChatModel.stream()` 生成回复的地方。**

一次 `/chat` 的顺序照 ARCHITECTURE § 6「一次文本对话」：

1. 附件先过 Vision 拿描述（AD-15：描述由后端生成，中间件不 import Vision）
2. `MemoryFacade.recall()` 召回，发 `recall` 事件的是中间件，不是这里
3. `PersonaService.current()` 读人格快照（AD-2：只读快照，不在请求路径合成）
4. 人格 + 召回 + 本会话最近 N 条 + 这一句 → `list[Message]`
5. `meta` → `delta`* → 有 TTS 时 `audio`* → `done`
6. `done` 之后 `ingest()` **两次**：用户这句与 AI 这句，都是 `Source.DIALOGUE`（AD-6）

失败处理照 ARCHITECTURE § 3：Chat 出网失败重试 2 次（间隔 1s、4s），仍失败发 `error`
事件带 hint；**只在还没吐出任何 delta 时重试**，吐了一半再重来会让用户看见两遍开头。
Vision 失败不算失败——不生成描述，原话照常进 prompt 与 `ingest`，`blob_id` 保留。
TTS 失败就没声音，文字照常，本次不重试。

编排把事件产出成 `(名字, 数据)` 二元组，SSE 编码在 `routes/chat.py`。这样
`/compare` 能复用同一条链路而不必假装自己是个 HTTP 流。
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import structlog

from .errors import from_exception
from .state import AppState, new_id

__all__ = [
    "Attachment",
    "ChatRequest",
    "RunResult",
    "describe_image",
    "run_once",
    "stream_chat",
]

log = structlog.get_logger("qiuqiu_api.orchestrator")

MEMORY_HEADER = "【记忆】下面是你记得的、和这次对话相关的事实。当作已知信息用，不要复述这段话本身。"
IMAGE_HEADER = "【图片】"
VISION_PROMPT = "用一到三句中文描述这张图里有什么，说清楚人、物、地点和正在发生的事。"


@dataclass(slots=True)
class Attachment:
    """`POST /chat` 的附件项。`type` 取 `image` 或 `audio`（CONTRACTS § 1）。"""

    type: str
    blob_id: str


@dataclass(slots=True)
class ChatRequest:
    session_id: str
    content: str
    attachments: list[Attachment] = field(default_factory=list)


@dataclass(slots=True)
class RunResult:
    """跑完一轮不流式的结果。`/compare` 用它做对照，`/chat` 不走这条。"""

    name: str
    trace_id: str
    model: str
    reply: str
    memory_used: bool
    recall_ids: list[str]
    tokens_in: int
    tokens_out: int
    latency_ms: int
    first_delta_ms: int
    recall_ms: int
    recall_paths: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "trace_id": self.trace_id,
            "model": self.model,
            "reply": self.reply,
            "memory_used": self.memory_used,
            "recall_ids": list(self.recall_ids),
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "latency_ms": self.latency_ms,
            "first_delta_ms": self.first_delta_ms,
            "recall_ms": self.recall_ms,
            "recall_paths": list(self.recall_paths),
        }


# --------------------------------------------------------------------- 小工具


def model_name(chat: Any) -> str:
    """`meta.model` 用的名字。真实供应商有 `.model`，mock 只有 `.provider`。"""
    return str(getattr(chat, "model", None) or getattr(chat, "provider", "unknown"))


def _memory_block(hits: list[Any]) -> str:
    lines = [MEMORY_HEADER]
    lines.extend(f"- {hit.text}" for hit in hits if getattr(hit, "text", ""))
    return "\n".join(lines)


def token_totals(state: AppState, trace_id: str) -> tuple[int, int]:
    """这条 trace 上模型层记的 token 合计。`done` 事件的两个数就是它。

    只数 `chat.*` 阶段：记忆中间件那几次调用跑在它自己的线程里，拿的是另一条 trace，
    不会混进来；后端自己那条 `orchestrate` 是在这之后才写的，也不会自己数自己。
    """
    rows = state.sqlite.list_metrics(trace_id=trace_id, limit=500)
    tokens_in = sum(int(r.get("tokens_in") or 0) for r in rows if _is_chat(r))
    tokens_out = sum(int(r.get("tokens_out") or 0) for r in rows if _is_chat(r))
    return tokens_in, tokens_out


def _is_chat(row: dict[str, Any]) -> bool:
    return str(row.get("stage") or "").startswith("chat.")


async def describe_image(state: AppState, blob_id: str) -> str | None:
    """读 blob → `VisionModel.describe()`。失败返回 `None`，调用方照常往下走。

    AD-15：主动附件与被动图片的描述都由后端生成，`ingest()` 只收文本与 `blob_id`。
    """
    try:
        raw = await state.off_loop(state.blobs.get, blob_id)
    except FileNotFoundError:
        log.warning("vision.blob_missing", blob_id=blob_id)
        return None
    vision = state.capability("vision")
    return str(await vision.describe(raw, VISION_PROMPT))


async def _transcribe(state: AppState, blob_id: str) -> str | None:
    """音频附件走 ASR。ASR 没接上时返回 `None`，这一轮当没有附件处理。"""
    try:
        raw = await state.off_loop(state.blobs.get, blob_id)
    except FileNotFoundError:
        log.warning("asr.blob_missing", blob_id=blob_id)
        return None
    asr = state.optional_capability("asr")
    if asr is None:
        return None
    transcript = await state.off_loop(asr.transcribe, raw)
    return str(getattr(transcript, "text", "") or "") or None


async def compose_user_text(state: AppState, req: ChatRequest) -> str:
    """原话 + 附件描述。描述与原话一起进 prompt 和 `ingest`（AD-15）。"""
    parts = [req.content.strip()] if req.content.strip() else []
    for attachment in req.attachments:
        try:
            if attachment.type == "image":
                described = await describe_image(state, attachment.blob_id)
                if described:
                    parts.append(f"{IMAGE_HEADER}{described}")
            elif attachment.type == "audio":
                text = await _transcribe(state, attachment.blob_id)
                if text:
                    parts.append(f"【语音】{text}")
        except Exception as exc:  # noqa: BLE001 - 附件失败不该拖垮整轮对话
            log.warning(
                "attachment.failed",
                kind=attachment.type,
                blob_id=attachment.blob_id,
                error=str(exc),
            )
    return "\n\n".join(parts)


def build_messages(
    state: AppState,
    *,
    persona_text: str,
    hits: list[Any],
    history: list[dict[str, Any]],
    user_text: str,
) -> list[Any]:
    """人格快照 + 召回 + 本会话历史 + 这一句。顺序不能换：人格永远在最前（AD-12）。"""
    from qiuqiu_models import Message

    system_parts = [persona_text.strip()] if persona_text.strip() else []
    if hits:
        system_parts.append(_memory_block(hits))
    messages: list[Any] = []
    if system_parts:
        messages.append(Message(role="system", content="\n\n".join(system_parts)))
    for row in history:
        role = str(row.get("role") or "")
        if role in {"user", "assistant"} and row.get("content"):
            messages.append(Message(role=role, content=str(row["content"])))
    messages.append(Message(role="user", content=user_text))
    return messages


async def _recall(
    state: AppState, query: str, *, trace_id: str, now: dt.datetime | None
) -> tuple[list[Any], list[str], int]:
    """召回。失败不中止对话——没记忆也能聊，只是 `memory_used` 为假。"""
    from qiuqiu_memory import Budget

    if not query.strip():
        return [], [], 0
    budget = Budget(
        max_items=state.config.recall_max_items,
        max_tokens=state.config.recall_max_tokens,
    )
    started = time.perf_counter()
    try:
        result = await state.off_loop(
            state.facade.recall, query, budget=budget, now=now, trace_id=trace_id
        )
    except Exception as exc:  # noqa: BLE001 - 召回炸了也要把回复发出去
        log.warning("recall.failed", trace_id=trace_id, error=str(exc))
        return [], [], int((time.perf_counter() - started) * 1000)
    return (
        list(result.items),
        list(result.paths_used),
        int((time.perf_counter() - started) * 1000),
    )


async def _stream_deltas(state: AppState, chat: Any, messages: list[Any]) -> AsyncIterator[str]:
    """调 `ChatModel.stream()`，出网失败按 ARCHITECTURE § 3 重试 2 次。

    已经吐过 delta 就不重试了——用户屏幕上不能出现两遍开头。
    """
    delays = state.config.retry_delays
    attempt = 0
    while True:
        emitted = False
        try:
            iterator = await chat.stream(messages, temperature=state.config.temperature)
            async for piece in iterator:
                emitted = True
                yield piece
            return
        except Exception as exc:  # noqa: BLE001 - 供应商可能抛任何东西
            if emitted or attempt >= len(delays):
                raise
            log.warning("chat.retry", attempt=attempt + 1, error=str(exc))
            await asyncio.sleep(delays[attempt])
            attempt += 1


# --------------------------------------------------------------------- 主链路


async def stream_chat(
    state: AppState,
    req: ChatRequest,
    *,
    trace_id: str,
    now: dt.datetime | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """一次对话，产出 `(事件名, 数据)`。事件名与字段严格按 CONTRACTS § 1。"""
    from qiuqiu_models import metrics

    started = time.perf_counter()
    moment = now or dt.datetime.now(dt.UTC)

    with metrics.use_trace_id(trace_id):
        try:
            user_text = await compose_user_text(state, req)
            if not user_text:
                raise ValueError("这一轮没有可发送的内容")
            _touch_session(state, req.session_id, user_text, moment)
            history = state.sqlite.list_messages(req.session_id, limit=state.config.history_limit)
            hits, _paths, _ms = await _recall(
                state, req.content or user_text, trace_id=trace_id, now=now
            )
            persona_text = await state.off_loop(state.persona.current)
            messages = build_messages(
                state,
                persona_text=persona_text,
                hits=hits,
                history=history,
                user_text=user_text,
            )
            chat = state.capability("chat")
        except Exception as exc:  # noqa: BLE001 - 准备阶段失败，一条 error 事件收场
            _status, payload = from_exception(exc)
            log.warning("chat.prepare_failed", trace_id=trace_id, **payload)
            yield "error", payload
            return

        # 用户这句先落库：模型挂了原话也不能丢（ARCHITECTURE § 3）
        user_message_id = new_id("msg")
        state.sqlite.add_message(
            user_message_id, req.session_id, "user", user_text, created_at=moment
        )

        yield (
            "meta",
            {
                "model": model_name(chat),
                "memory_used": bool(hits),
                "recall_ids": [h.id for h in hits],
            },
        )

        reply_parts: list[str] = []
        try:
            async for piece in _stream_deltas(state, chat, messages):
                if not piece:
                    continue
                reply_parts.append(piece)
                yield "delta", {"text": piece}
        except Exception as exc:  # noqa: BLE001 - 出网失败统一成带 hint 的 error 事件
            _status, payload = from_exception(exc)
            log.warning("chat.stream_failed", trace_id=trace_id, **payload)
            _record_orchestrate(state, trace_id, chat, started)
            yield "error", payload
            return

        reply = "".join(reply_parts)

        async for audio in _stream_audio(state, reply):
            yield "audio", audio

        assistant_message_id = new_id("msg")
        tokens_in, tokens_out = token_totals(state, trace_id)
        latency_ms = int((time.perf_counter() - started) * 1000)
        yield (
            "done",
            {
                "message_id": assistant_message_id,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "latency_ms": latency_ms,
            },
        )

        _record_orchestrate(state, trace_id, chat, started, tokens_in, tokens_out)
        await _after_turn(
            state,
            req=req,
            trace_id=trace_id,
            moment=moment,
            latency_ms=latency_ms,
            user_text=user_text,
            reply=reply,
            assistant_message_id=assistant_message_id,
        )


async def _stream_audio(state: AppState, reply: str) -> AsyncIterator[dict[str, Any]]:
    """有 TTS 就合成，没有就跳过（本轮 registry 拿不到 TTS，不当错误处理）。"""
    if not reply:
        return
    tts = state.optional_capability("tts")
    if tts is None:
        return
    from qiuqiu_models import voices as voice_catalogue

    from .routes.voices import current_voice

    # 界面上选的短名 → 级联链路认的供应商音色 ID。两条链路共用一份选择，
    # 用户切了音色，文字对话和语音对话的声音才是同一个人。
    speaker = voice_catalogue.tts_id(await current_voice(state))
    try:
        chunks = await tts.synthesize(reply, voice=speaker)
        async for chunk in chunks:
            yield {
                "pcm_b64": base64.b64encode(chunk.pcm).decode("ascii"),
                "sample_rate": int(getattr(chunk, "sample_rate", 16000)),
                "rms": round(float(chunk.rms), 3),
            }
    except Exception as exc:  # noqa: BLE001 - 没声音，文字照常，本次不重试
        log.warning("tts.failed", error=str(exc))


def _touch_session(state: AppState, session_id: str, user_text: str, moment: dt.datetime) -> None:
    """会话不存在就建，存在就只推 `updated_at`，别把用户改过的标题冲掉。"""
    existing = state.sqlite.get_session(session_id)
    title = (existing or {}).get("title") or user_text.strip().splitlines()[0][:24]
    state.sqlite.upsert_session(
        session_id,
        title,
        archived=bool((existing or {}).get("archived", False)),
        created_at=None,
        updated_at=moment,
    )


def _record_orchestrate(
    state: AppState,
    trace_id: str,
    chat: Any,
    started: float,
    tokens_in: int = 0,
    tokens_out: int = 0,
) -> None:
    """编排自己也记一条 `run_metrics`（阶段 `orchestrate`），失败也记（AD-16）。"""
    state.sqlite.record_metric(
        trace_id,
        "orchestrate",
        str(getattr(chat, "provider", "unknown")),
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        latency_ms=int((time.perf_counter() - started) * 1000),
    )


async def _after_turn(
    state: AppState,
    *,
    req: ChatRequest,
    trace_id: str,
    moment: dt.datetime,
    latency_ms: int,
    user_text: str,
    reply: str,
    assistant_message_id: str,
) -> None:
    """`done` 之后的收尾：AI 这句落库、`ingest()` 两次、给定时任务记一轮。

    两次 `ingest` 都是 `Source.DIALOGUE`，`speaker` 分别是 `user` 与 `assistant`（AD-6）。
    回复的时刻是「问的时刻 + 这一轮实际耗时」，不是同一个时刻——`messages` 按
    `created_at` 排序，两条同一毫秒的话，一问一答的先后就只能靠 id 碰运气了。
    失败只记日志：回复已经发出去了，这时候再补一条 `error` 事件会让丘丘无端切出错表情。
    """
    from qiuqiu_memory import Source

    answered = moment + dt.timedelta(milliseconds=max(1, latency_ms))
    if reply:
        state.sqlite.add_message(
            assistant_message_id,
            req.session_id,
            "assistant",
            reply,
            model=None,
            created_at=answered,
        )

    blob_id = req.attachments[0].blob_id if req.attachments else None
    for text, speaker, blob, when in (
        (user_text, "user", blob_id, moment),
        (reply, "assistant", None, answered),
    ):
        if not text:
            continue
        try:
            await state.off_loop(
                state.facade.ingest,
                text,
                source=Source.DIALOGUE,
                speaker=speaker,
                ts=when,
                blob_id=blob,
                trace_id=trace_id,
            )
        except Exception as exc:  # noqa: BLE001 - 原话已在 messages 表里，不重试
            log.warning("ingest.failed", trace_id=trace_id, speaker=speaker, error=str(exc))

    if state.scheduler is not None:
        await state.scheduler.note_turn()


# --------------------------------------------------------------------- /compare


async def run_once(
    state: AppState,
    *,
    name: str,
    query: str,
    session_id: str | None = None,
    use_memory: bool = True,
    trace_id: str,
    now: dt.datetime | None = None,
) -> RunResult:
    """跑一轮但不写记忆。`/compare` 用它做同一 query 的两条配置对照。

    **不 `ingest`、不落 `messages`**：对照跑两遍，写进去就等于把同一句记了两次。
    """
    from qiuqiu_models import metrics

    started = time.perf_counter()
    first_delta = 0.0
    with metrics.use_trace_id(trace_id):
        hits: list[Any] = []
        paths: list[str] = []
        recall_ms = 0
        if use_memory:
            hits, paths, recall_ms = await _recall(state, query, trace_id=trace_id, now=now)
        persona_text = await state.off_loop(state.persona.current) if use_memory else ""
        history = (
            state.sqlite.list_messages(session_id, limit=state.config.history_limit)
            if (session_id and use_memory)
            else []
        )
        messages = build_messages(
            state,
            persona_text=persona_text,
            hits=hits,
            history=history,
            user_text=query,
        )
        chat = state.capability("chat")
        parts: list[str] = []
        async for piece in _stream_deltas(state, chat, messages):
            if not parts:
                first_delta = time.perf_counter() - started
            parts.append(piece)
        tokens_in, tokens_out = token_totals(state, trace_id)
        latency_ms = int((time.perf_counter() - started) * 1000)
        _record_orchestrate(state, trace_id, chat, started, tokens_in, tokens_out)

    return RunResult(
        name=name,
        trace_id=trace_id,
        model=model_name(chat),
        reply="".join(parts),
        memory_used=bool(hits),
        recall_ids=[h.id for h in hits],
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        latency_ms=latency_ms,
        first_delta_ms=int(first_delta * 1000),
        recall_ms=recall_ms,
        recall_paths=paths,
    )
