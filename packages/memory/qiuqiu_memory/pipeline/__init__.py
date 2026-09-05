"""记忆的六个环节。上层不直接 import 这里，都走 `MemoryFacade`（AD-7）。

- `filter`：只筛被动采集（AD-3），输出 `FilterDecision`，每次判断发 `filter` 事件
- `compress`：拆自包含原子事实，代词消解、时间绝对化，发 `write` 事件
- `synthesize`：同义合并，旧事实写 `valid_to` 与 `superseded_by`（AD-9），发 `merge` 事件
- `retrieve`：检索规划 → 三路 → 并集去重 → 按 `Budget` 截断，发 `recall` 事件
- `tiering`：冷热联动，`recall` 命中冷条目回热；`nightly()` 给后端调度器
- `consolidate`：性格沉淀，只读 `messages` 表（AD-4）
"""

from __future__ import annotations

__all__ = ["compress", "consolidate", "filter", "retrieve", "synthesize", "tiering"]
