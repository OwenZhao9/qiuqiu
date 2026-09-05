"""调 Chat 的统一入口。压缩、合成、检索规划、性格归纳四处都走这里。

三条规矩：

1. **只经 registry**（AD-8）。实例由 `MemoryRuntime.chat` 提供，本模块不认供应商。
2. **不重试**（ARCHITECTURE § 3）。中间件这一路的失败处理是「本次 ingest 返回空
   accepted，记 `run_metrics`，原始消息由 backend 留在 `messages` 表」，重试只会
   把用户的等待拉长。抛 `ChatUnavailable`，门面接住。
3. **输出解析失败不算失败**。模型没吐出合法 JSON（`MODELS_MOCK=1` 的固定回复就是
   这种情况）时返回 `None`，调用方走自己的确定性兜底，链路照常跑通。这跟「调用炸了」
   是两回事，前者降级、后者中止。
"""

from __future__ import annotations

import json
import re
from typing import Any

import structlog

from .errors import MemoryError_

__all__ = ["ChatUnavailable", "complete_json", "extract_json"]

log = structlog.get_logger("qiuqiu_memory.llm")

_FENCE_RE = re.compile(r"```(?:json)?\s*(.+?)\s*```", re.DOTALL)


class ChatUnavailable(MemoryError_):
    """Chat 调用本身失败了（网络、鉴权、限流）。不重试，往上冒。"""

    code = "chat_unavailable"


def extract_json(text: str) -> Any | None:
    """从模型回复里抠出 JSON。支持裸 JSON、```json 围栏、以及前后有闲话的情况。

    抠不出来返回 `None`——调用方据此走兜底，不当成异常。
    """
    if not text:
        return None
    candidates: list[str] = []
    fenced = _FENCE_RE.search(text)
    if fenced:
        candidates.append(fenced.group(1))
    candidates.append(text.strip())
    for opener, closer in (("[", "]"), ("{", "}")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (TypeError, ValueError):
            continue
    return None


async def complete_json(
    runtime: Any,
    *,
    system: str,
    user: str,
    stage: str,
) -> Any | None:
    """调一次 `chat.complete()` 并把回复解析成 JSON。

    返回 `None` 表示「模型答了，但不是 JSON」——降级，不是错误。
    调用失败抛 `ChatUnavailable`，并记一条 `run_metrics`（AD-16：失败也记）。
    """
    from qiuqiu_models import Message, metrics

    messages = [Message(role="system", content=system), Message(role="user", content=user)]
    try:
        reply = await runtime.chat.complete(messages)
    except Exception as exc:  # noqa: BLE001 - 供应商可能抛任何东西，统一成带 hint 的错
        metrics.record(
            stage=f"memory.{stage}",
            provider=runtime.chat_provider,
            tokens_in=sum(len(m.content) for m in messages),
        )
        raise ChatUnavailable(
            f"记忆层调 Chat 失败（{stage}）：{exc}",
            hint="这次不重试，原话已经由后端留在 messages 表里；"
            "检查 DEEPSEEK_API_KEY 与网络，或设 MODELS_MOCK=1 离线跑。",
            stage=stage,
        ) from exc

    parsed = extract_json(reply)
    if parsed is None:
        log.debug("llm.non_json", stage=stage, provider=runtime.chat_provider)
    return parsed
