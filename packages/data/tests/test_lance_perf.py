"""性能底线：1000 条热表事实，向量 top-10 查询要快过 50ms。

验收线是 50ms。本机（Apple silicon，1000×1024 维全扫）实测 p50 约 3ms，
留了十几倍余量；这里断言的是 20 次查询的中位数，避开首次查询的冷启动与
偶发的调度抖动，慢机器上也不至于假红。真要在 CI 上频繁翻车，
调的应该是 `SLOW_MACHINE_BUDGET_MS`，不是把断言删掉。
"""

from __future__ import annotations

import statistics
import time
from pathlib import Path

from conftest import make_fact, make_vector
from qiuqiu_data.lance import VECTOR_INDEX_MIN_ROWS, LanceStore

ROWS = 1000
TOP_K = 10
BUDGET_MS = 50.0
SLOW_MACHINE_BUDGET_MS = 250.0  # 单次查询的上限，比中位数松，容忍偶发抖动


def test_vector_top10_over_1000_hot_facts_is_under_50ms(data_root: Path, rng, capsys) -> None:
    store = LanceStore()
    store.init()
    store.upsert([make_fact(f"f{i}", rng) for i in range(ROWS)])

    assert store.count("hot") == ROWS
    # 不到一万条，按约定不建向量索引，下面量的是全扫的耗时
    assert ROWS < VECTOR_INDEX_MIN_ROWS
    assert "vector_idx" not in store.list_indexes("hot")

    queries = [make_vector(rng) for _ in range(21)]
    store.query_vector(queries[0], k=TOP_K)  # 预热，排除首次连接与元数据加载

    timings: list[float] = []
    for query in queries[1:]:
        started = time.perf_counter()
        hits = store.query_vector(query, k=TOP_K)
        timings.append((time.perf_counter() - started) * 1000)
        assert len(hits) == TOP_K

    p50 = statistics.median(timings)
    with capsys.disabled():
        print(
            f"\n[perf] 1000 条热表事实向量 top-10："
            f"p50 {p50:.2f}ms / 最快 {min(timings):.2f}ms / 最慢 {max(timings):.2f}ms"
        )

    assert p50 < BUDGET_MS
    assert max(timings) < SLOW_MACHINE_BUDGET_MS
