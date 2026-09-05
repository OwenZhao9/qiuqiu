"""记忆层测试的公共构件。

为什么不放 `conftest.py`：仓库里每个包都有一个 `tests/conftest.py`，而 pytest 把它们
都当顶层模块 `conftest`——测试文件里写 `from conftest import ...` 会随收集顺序抓到别的
包那一个。文件名带上 `memory_` 前缀就没有这个问题（测试文件名同理，用
`test_memory_*.py`，跟 `packages/models` 的做法一致）。

夹具仍然留在 `conftest.py` 里，那是 pytest 自己的注入机制，不受影响。
"""

from __future__ import annotations

import datetime as dt
import json
import re
from collections.abc import AsyncIterator
from typing import Any

from qiuqiu_memory.runtime import MemoryRuntime

__all__ = [
    "BASE_TIME",
    "FakeChat",
    "absorb_all",
    "make_runtime",
    "seed_messages",
]

BASE_TIME = dt.datetime(2026, 9, 5, 10, 0, 0, tzinfo=dt.UTC)


class FakeChat:
    """脚本化的 Chat。

    `script` 是一串 `(关键词, 回复)`：拿用户提示里第一个命中的关键词对应的回复。
    回复可以是字符串，也可以是 `callable(prompt) -> str`——合成那一步要从提示里读出
    候选 id 才知道该吸收谁，就用后者。没命中就回 `default`。
    `calls` 记下每次的提示，测试拿它断言「问过模型没有」。

    它经 `MemoryRuntime(chat=...)` 注入，仍然满足 AD-8——上层拿到的是一个符合
    `ChatModel` 形状的对象，不是某个供应商。
    """

    provider = "fake"

    def __init__(
        self,
        script: list[tuple[str, Any]] | None = None,
        *,
        default: str = "这不是 JSON。",
    ) -> None:
        self.script = script or []
        self.default = default
        self.calls: list[str] = []

    async def complete(self, messages: list[Any]) -> str:
        prompt = "\n".join(m.content for m in messages)
        self.calls.append(prompt)
        for keyword, reply in self.script:
            if keyword in prompt:
                return reply(prompt) if callable(reply) else reply
        return self.default

    async def stream(self, messages: list[Any], *, temperature: float = 0.7) -> AsyncIterator[str]:
        text = await self.complete(messages)

        async def _gen() -> AsyncIterator[str]:
            yield text

        return _gen()


def make_runtime(clock: dict[str, dt.datetime], chat: Any) -> MemoryRuntime:
    """注入一个脚本化 Chat 的运行时。要走「模型路径」的用例用它。"""
    return MemoryRuntime(chat=chat, clock=lambda: clock["now"])


def absorb_all(prompt: str) -> str:
    """合成那一步的脚本回复：把提示里列出的候选全部吸收。"""
    ids = re.findall(r"- (fact_[0-9a-f]+):", prompt)
    return json.dumps({"absorbed": ids, "result_text": ""}, ensure_ascii=False)


def seed_messages(
    runtime: MemoryRuntime,
    turns: list[tuple[str, str]],
    *,
    session_id: str = "s1",
    start: dt.datetime = BASE_TIME,
) -> None:
    """往 SQLite `messages` 表里灌一段原始会话。性格沉淀的用例用它。"""
    runtime.sqlite.upsert_session(session_id, "测试会话")
    for index, (role, content) in enumerate(turns):
        runtime.sqlite.add_message(
            f"{session_id}_m{index:03d}",
            session_id,
            role,
            content,
            created_at=start + dt.timedelta(seconds=index),
        )
