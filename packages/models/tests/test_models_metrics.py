"""计量：字段、trace_id 传播、sink 可注入、sink 抛错不拖垮主流程。"""

from __future__ import annotations

import pytest
from qiuqiu_models import metrics


def test_record_fields_match_run_metrics_schema(
    sink: metrics.InMemoryMetricsSink,
) -> None:
    m = metrics.record(
        stage="chat.stream", provider="mock", tokens_in=3, tokens_out=9, latency_ms=12
    )
    assert sink.records == [m]
    assert m.to_dict()["stage"] == "chat.stream"
    assert m.trace_id.startswith("trc_")


def test_trace_id_comes_from_context(sink: metrics.InMemoryMetricsSink) -> None:
    with metrics.use_trace_id("trc_abc"):
        metrics.record(stage="a", provider="mock")
        metrics.record(stage="b", provider="mock")
    metrics.record(stage="c", provider="mock")

    ids = [m.trace_id for m in sink.records]
    assert ids[0] == ids[1] == "trc_abc"
    assert ids[2] != "trc_abc"


def test_measure_times_and_records(sink: metrics.InMemoryMetricsSink) -> None:
    with metrics.measure(stage="chat.complete", provider="mock") as handle:
        handle.usage(11, 22)
    m = sink.records[0]
    assert (m.tokens_in, m.tokens_out) == (11, 22)
    assert m.latency_ms >= 0


def test_measure_records_even_when_the_call_fails(
    sink: metrics.InMemoryMetricsSink,
) -> None:
    with pytest.raises(RuntimeError), metrics.measure(stage="chat.stream", provider="mock"):
        raise RuntimeError("上游炸了")
    assert [m.stage for m in sink.records] == ["chat.stream"]


def test_sink_is_injectable() -> None:
    captured: list[metrics.RunMetric] = []

    class Collect:
        def record(self, metric: metrics.RunMetric) -> None:
            captured.append(metric)

    collector = Collect()
    old = metrics.set_sink(collector)
    try:
        assert isinstance(collector, metrics.MetricsSink)
        assert metrics.get_sink() is collector
        metrics.record(stage="x", provider="mock")
        assert len(captured) == 1
    finally:
        metrics.set_sink(old)


def test_broken_sink_does_not_break_the_caller() -> None:
    class Broken:
        def record(self, metric: metrics.RunMetric) -> None:
            raise OSError("磁盘满了")

    old = metrics.set_sink(Broken())
    try:
        metrics.record(stage="x", provider="mock")  # 不该抛
    finally:
        metrics.set_sink(old)


def test_in_memory_sink_is_bounded() -> None:
    s = metrics.InMemoryMetricsSink(maxlen=3)
    for i in range(10):
        s.record(
            metrics.RunMetric(
                trace_id="t",
                stage=str(i),
                tokens_in=0,
                tokens_out=0,
                latency_ms=0,
                ts="now",
                provider="mock",
            )
        )
    assert [m.stage for m in s.records] == ["7", "8", "9"]
    s.clear()
    assert s.records == []


def test_models_package_does_not_import_qiuqiu_data() -> None:
    """packages/data 还没合进来，模型层不许 import 它。"""

    import inspect
    from pathlib import Path

    import qiuqiu_models

    pkg_dir = Path(inspect.getfile(qiuqiu_models)).parent
    for path in pkg_dir.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "import qiuqiu_data" not in text, path.name
        assert "from qiuqiu_data" not in text, path.name
