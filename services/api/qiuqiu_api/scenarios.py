"""演示场景回放。脚本格式见 `scenarios/README.md`。

`clock_offset_days` **不改系统时钟**（任务书里已定死）：把偏移算进每一步的时间，
`ingest()` 的 `ts` 与 `recall()` 的 `now` 都收偏移后的那个时刻。「过了三个月再问旧事」
于是变成「往三个月后写事实、再站在三个月后问」，热表自然未命中、下探冷表，
`recall` 事件里 `cold_promoted` 非空——正是 ARCHITECTURE § 6 第四条链路要演的东西。

一步有两种写法（`text` 走写入，`query` 走召回），见 `Step`。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog

from .errors import BadRequest, NotFound
from .state import AppState, new_trace_id

__all__ = ["Scenario", "Step", "list_scenarios", "load_scenario", "play"]

log = structlog.get_logger("qiuqiu_api.scenarios")

_SOURCES = {"dialogue", "journal", "ambient_audio", "ambient_image"}


@dataclass(slots=True)
class Step:
    """一步。`text` 与 `query` 二选一。

    - `text`：走 `MemoryFacade.ingest()`，`source` 与 `speaker` 按脚本
    - `query`：走 `MemoryFacade.recall()`，用来演「三个月后问旧事」的召回那一下
    """

    at_ms: int = 0
    source: str = "dialogue"
    speaker: str = "user"
    text: str | None = None
    query: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Step:
        source = str(raw.get("source") or "dialogue")
        if source not in _SOURCES:
            raise BadRequest(
                f"场景脚本里的 source {source!r} 不认识。",
                hint="能用的是：" + "、".join(sorted(_SOURCES)) + "。",
                code="scenario.bad_source",
            )
        speaker = str(raw.get("speaker") or "user")
        if speaker not in {"user", "assistant"}:
            raise BadRequest(
                f"场景脚本里的 speaker {speaker!r} 不认识。",
                hint="只能是 user 或 assistant。",
                code="scenario.bad_speaker",
            )
        text = raw.get("text")
        query = raw.get("query")
        if not text and not query:
            raise BadRequest(
                "场景脚本的每一步要么有 text（写入），要么有 query（召回）。",
                hint="给这一步补上 text 或 query 其中一个。",
                code="scenario.empty_step",
            )
        return cls(
            at_ms=int(raw.get("at_ms") or 0),
            source=source,
            speaker=speaker,
            text=str(text) if text else None,
            query=str(query) if query else None,
        )


@dataclass(slots=True)
class Scenario:
    name: str
    title: str = ""
    clock_offset_days: int = 0
    steps: list[Step] = field(default_factory=list)

    @classmethod
    def from_dict(cls, raw: dict[str, Any], *, name: str) -> Scenario:
        steps = raw.get("steps")
        if not isinstance(steps, list) or not steps:
            raise BadRequest(
                f"场景 {name} 没有 steps。",
                hint="脚本格式见 scenarios/README.md，steps 至少要有一步。",
                code="scenario.no_steps",
            )
        return cls(
            name=str(raw.get("name") or name),
            title=str(raw.get("title") or ""),
            clock_offset_days=int(raw.get("clock_offset_days") or 0),
            steps=[Step.from_dict(s) for s in steps],
        )


def list_scenarios(directory: Path) -> list[str]:
    if not directory.is_dir():
        return []
    return sorted(p.stem for p in directory.glob("*.json"))


def load_scenario(directory: Path, name: str) -> Scenario:
    """读 `<scenarios_dir>/<name>.json`。名字里不许有路径分隔符。"""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise BadRequest(
            f"场景名 {name!r} 不合法。",
            hint="场景名就是 scenarios/ 下的文件名（不带 .json）。",
            code="scenario.bad_name",
        )
    path = directory / f"{name}.json"
    if not path.is_file():
        available = list_scenarios(directory)
        raise NotFound(
            f"没有场景 {name}。",
            hint=(
                "现有场景：" + "、".join(available) + "。"
                if available
                else f"往 {directory} 放一个 {name}.json，格式见 scenarios/README.md。"
            ),
            code="scenario.not_found",
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BadRequest(
            f"场景 {name} 的 JSON 读不出来：{exc}",
            hint="检查文件编码与 JSON 语法，格式见 scenarios/README.md。",
            code="scenario.bad_json",
        ) from exc
    return Scenario.from_dict(raw, name=name)


async def play(
    state: AppState,
    scenario: Scenario,
    *,
    speed: float = 1.0,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """按时间轴回放。`speed=0` 不等待（测试与「立刻看结果」用）。

    每一步的时刻 = 现在 + `clock_offset_days` 天 + `at_ms` 毫秒。前端在 `/events` 上
    看到的事件顺序就是脚本顺序。
    """
    from qiuqiu_memory import Budget, Source

    trace_id = trace_id or new_trace_id()
    base = dt.datetime.now(dt.UTC) + dt.timedelta(days=scenario.clock_offset_days)
    elapsed_ms = 0
    played: list[dict[str, Any]] = []

    for index, step in enumerate(scenario.steps):
        wait_ms = max(0, step.at_ms - elapsed_ms)
        if speed > 0 and wait_ms:
            await asyncio.sleep(wait_ms / 1000.0 / speed)
        elapsed_ms = max(elapsed_ms, step.at_ms)
        moment = base + dt.timedelta(milliseconds=step.at_ms)

        if step.query:
            result = await state.off_loop(
                state.facade.recall,
                step.query,
                budget=Budget(
                    max_items=state.config.recall_max_items,
                    max_tokens=state.config.recall_max_tokens,
                ),
                now=moment,
                trace_id=trace_id,
            )
            played.append(
                {
                    "index": index,
                    "at_ms": step.at_ms,
                    "kind": "recall",
                    "query": step.query,
                    "hits": [h.id for h in result.items],
                    "cold_promoted": list(result.cold_promoted),
                    "paths_used": list(result.paths_used),
                }
            )
            continue

        result = await state.off_loop(
            state.facade.ingest,
            step.text,
            source=Source(step.source),
            speaker=step.speaker,
            ts=moment,
            trace_id=trace_id,
        )
        played.append(
            {
                "index": index,
                "at_ms": step.at_ms,
                "kind": "ingest",
                "source": step.source,
                "speaker": step.speaker,
                "decision": result.decision,
                "accepted": list(result.accepted),
            }
        )

    log.info("scenario.played", name=scenario.name, steps=len(played), trace_id=trace_id)
    return {
        "name": scenario.name,
        "title": scenario.title,
        "trace_id": trace_id,
        "clock_offset_days": scenario.clock_offset_days,
        "played_from": base.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "steps": played,
    }
