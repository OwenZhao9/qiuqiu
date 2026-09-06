"""契约测试。**期望值全部从 `docs/CONTRACTS.md` 解析**，这一份不抄任何一张表。

解析器在 `memory_contract_spec.py`，它把契约当唯一事实源读进来；本文件只做一件事：
拿解析结果去比代码。所以「文档改了、代码没跟」和「代码改了、文档没跟」两个方向都会
在这里炸——抄一份表的写法只能测出前者。

别的用例测行为，这一份只测形状。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import inspect
from collections.abc import AsyncIterator

import memory_contract_spec as spec
import pytest
import qiuqiu_memory
from memory_helpers import BASE_TIME
from qiuqiu_memory import (
    Budget,
    IngestResult,
    MemoryFacade,
    PersonaService,
    RecallResult,
    Source,
    VisibleMemory,
)
from qiuqiu_memory.bus import EVENT_TYPES
from qiuqiu_memory.pipeline.compress import Fact
from qiuqiu_memory.runtime import DEFAULTS
from qiuqiu_memory.types import Hit, Learned, MergeOp, RetrievalPlan, Sliders, iso


def test_declared_contract_version_matches_the_document() -> None:
    assert qiuqiu_memory.CONTRACT_VERSION == spec.declared_version()


class TestSourceEnum:
    """§ 3 的 `Source`。取值同时是 § 5 `facts.source` 列的取值域。"""

    def test_members_and_values_match_the_contract(self) -> None:
        assert {s.name: s.value for s in Source} == spec.enum_members("Source")

    def test_ambient_members_are_exactly_the_filter_sources(self) -> None:
        """筛选只认 `filter` 事件 payload 里 `source` 的那两个取值（AD-3）。"""
        declared = set(spec.event_payload_shapes()["filter"]["source"].literals)
        assert {s.value for s in qiuqiu_memory.AMBIENT_SOURCES} == declared

    def test_persona_is_a_facts_source_but_not_an_ingest_entry(self) -> None:
        """§ 5 的 `facts.source` 认 `persona`；§ 3 写明它「中间件内部用，调用方不传」。"""
        assert Source.PERSONA.value in spec.enum_members("Source").values()
        assert Source.PERSONA not in qiuqiu_memory.INGESTABLE_SOURCES
        assert {s.value for s in qiuqiu_memory.INGESTABLE_SOURCES} | {"persona"} == set(
            spec.enum_members("Source").values()
        )


@pytest.fixture(scope="session")
def declared_facade() -> dict[str, spec.MethodSpec]:
    """§ 3 里 `MemoryFacade` 的签名规格。"""
    return spec.method_specs("MemoryFacade")


@pytest.fixture(scope="session")
def declared_persona() -> dict[str, spec.MethodSpec]:
    """§ 3 里 `PersonaService` 的签名规格。"""
    return spec.method_specs("PersonaService", block=1)


@pytest.fixture(scope="session")
def shapes() -> dict[str, spec.Node]:
    """§ 1 四类 payload 的形状。"""
    return spec.event_payload_shapes()


class TestFacadeSignatures:
    """§ 3 `MemoryFacade` 五个方法，逐参数比对文档里的签名。"""

    def test_exactly_the_declared_methods_exist(self, declared_facade) -> None:
        for name in declared_facade:
            assert callable(getattr(MemoryFacade, name)), name

    def test_parameter_names_and_order(self, declared_facade) -> None:
        for name, want in declared_facade.items():
            got = inspect.signature(getattr(MemoryFacade, name))
            listed = [p for p in got.parameters if p != "fields"]
            assert listed == want.parameters, name

    def test_keyword_only_params_stay_keyword_only(self, declared_facade) -> None:
        for name, want in declared_facade.items():
            params = inspect.signature(getattr(MemoryFacade, name)).parameters
            for arg in want.keyword_only:
                assert params[arg].kind is inspect.Parameter.KEYWORD_ONLY, f"{name}.{arg}"

    def test_optional_params_keep_their_defaults(self, declared_facade) -> None:
        for name, want in declared_facade.items():
            params = inspect.signature(getattr(MemoryFacade, name)).parameters
            for arg in want.defaults:
                assert params[arg].default is not inspect.Parameter.empty, f"{name}.{arg}"

    def test_edit_visible_takes_arbitrary_fields(self) -> None:
        """契约写的是 `edit_visible(self, mid, **fields)`。"""
        edit = inspect.signature(MemoryFacade.edit_visible)
        assert edit.parameters["fields"].kind is inspect.Parameter.VAR_KEYWORD

    def test_subscribe_returns_an_async_iterator(self, facade: MemoryFacade) -> None:
        """契约 v0.1.8：注册同步完成，所以必须在协程里调（订阅要绑定调用方的事件循环）。"""

        async def check() -> bool:
            stream = facade.subscribe()
            try:
                return isinstance(stream, AsyncIterator)
            finally:
                await stream.aclose()

        assert asyncio.run(check())

    def test_subscribe_registers_synchronously(self, facade: MemoryFacade) -> None:
        """v0.1.8 的核心保证：`subscribe()` 返回时订阅已经在册。

        惰性注册的话，调用方只能靠让步几次去猜注册好没有，注册与补发之间的窗口里
        发布的事件会被静默丢掉——而 `/events` 正是「先订阅再补发」这么用的。
        """

        async def check() -> tuple[int, int]:
            before = facade.runtime.bus.subscriber_count
            stream = facade.subscribe()
            try:
                return before, facade.runtime.bus.subscriber_count
            finally:
                await stream.aclose()

        before, after = asyncio.run(check())
        assert (before, after) == (0, 1), "subscribe() 返回时订阅必须已经在册，一次让步都不该等"

    def test_ingest_and_recall_are_plain_defs(self) -> None:
        """契约里它们是同步方法，后端靠 `asyncio.to_thread` 调。"""
        assert not inspect.iscoroutinefunction(MemoryFacade.ingest)
        assert not inspect.iscoroutinefunction(MemoryFacade.recall)


class TestPersonaSignatures:
    """§ 3 的 `PersonaService` 四个方法。"""

    def test_declared_methods_exist_with_matching_parameters(self, declared_persona) -> None:
        for name, want in declared_persona.items():
            assert callable(getattr(PersonaService, name)), name
            got = list(inspect.signature(getattr(PersonaService, name)).parameters)
            assert got == want.parameters, name

    def test_current_returns_str(self, persona: PersonaService) -> None:
        assert isinstance(persona.current(), str)

    def test_run_consolidation_returns_learned(self, persona: PersonaService) -> None:
        assert isinstance(persona.run_consolidation(), Learned)

    def test_composition_order_follows_section_seven(self, persona: PersonaService) -> None:
        """§ 7 的公式：identity → output → boundary → preset → learned，顺序不能变（AD-12）。

        `identity_block` 排在最前，写明「你叫丘丘」——没有它，模型被问名字只能现编。
        `output_block` 紧跟其后，禁止括号旁白。
        """
        order = spec.persona_composition_order()
        assert order[:5] == [
            "identity_block",
            "output_block",
            "boundary_block",
            "preset_block",
            "learned_block",
        ]

        from qiuqiu_memory.persona import (
            BOUNDARY_MARKER,
            IDENTITY_MARKER,
            LEARNED_MARKER,
            PRESET_MARKER,
        )

        persona.set_preset("warm")
        persona.runtime.sqlite.append_persona_learned({"nickname": "小赵"})
        text = persona.recompute()
        positions = [
            text.index(m) for m in (IDENTITY_MARKER, BOUNDARY_MARKER, PRESET_MARKER, LEARNED_MARKER)
        ]
        assert positions == sorted(positions)


class TestDataclassShapes:
    """§ 3 的四个数据类。字段名与默认值都从契约里读。"""

    def test_budget_fields_and_defaults(self) -> None:
        assert [f for f in spec.dataclass_fields("Budget")] == ["max_items", "max_tokens", "paths"]
        for name, value in spec.dataclass_defaults("Budget").items():
            assert getattr(Budget(), name) == value, name

    def test_ingest_result_carries_every_declared_field(self, facade: MemoryFacade) -> None:
        result = facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        assert isinstance(result, IngestResult)
        assert set(spec.dataclass_fields("IngestResult")) <= set(result.to_dict())

    def test_recall_result_fields_match_exactly(self, facade: MemoryFacade) -> None:
        result = facade.recall("他叫什么", budget=Budget())
        assert isinstance(result, RecallResult)
        assert set(result.to_dict()) == set(spec.dataclass_fields("RecallResult"))

    def test_rejection_shape(self) -> None:
        """`Rejection = { reason, score, preview }`，写在 `IngestResult` 的行内注释里。"""
        from qiuqiu_memory.types import Rejection

        line = next(
            ln
            for ln in spec.section(3).split("\n")
            if "Rejection" in ln and "reason" in ln  # 注释里那一行
        )
        declared = set(line.split("{", 1)[1].split("}", 1)[0].replace(",", " ").split())
        assert set(Rejection(reason="r", score=0.1, preview="p").to_dict()) == declared

    def test_hit_shape(self) -> None:
        """`Hit = { id, text, path, score, valid_from }`，同样写在 `RecallResult` 的注释里。"""
        line = next(ln for ln in spec.section(3).split("\n") if "Hit = {" in ln)
        declared = set(line.split("{", 1)[1].split("}", 1)[0].replace(",", " ").split())
        hit = Hit(id="fact_1", text="t", path="semantic", score=0.5, valid_from=iso(BASE_TIME))
        assert set(hit.to_dict()) == declared

    def test_visible_memory_matches_the_typescript_interface(self) -> None:
        body = VisibleMemory(
            id="vm_1", layer="L0", content="c", source="auto", enabled=True
        ).to_dict()
        assert list(body) == spec.ts_interface_fields("VisibleMemory")

    def test_visible_memory_layers_match_the_route_query(self) -> None:
        """`GET /memories?layer=L0|L1|L2`。"""
        import re

        from qiuqiu_memory.facade import LAYERS

        line = next(ln for ln in spec.section(1).split("\n") if "/memories?layer=" in ln)
        assert set(LAYERS) == set(re.findall(r"L\d", line))

    def test_sliders_match_the_typescript_alias(self) -> None:
        assert list(Sliders().to_dict()) == spec.ts_interface_fields("Sliders")

    def test_learned_keys_match_the_typescript_alias(self) -> None:
        body = Learned(
            nickname="小赵", humor_tolerance=80, topics=["咖啡"], reply_length="short"
        ).to_dict()
        assert set(body) == set(spec.ts_interface_fields("Learned"))

    def test_learned_reply_length_values(self) -> None:
        """`reply_length?: "short"|"medium"|"long"`，别的取值一律当没填。"""
        import re

        line = next(ln for ln in spec.contracts_text().split("\n") if "type Learned" in ln)
        declared = set(re.findall(r'"(\w+)"', line))
        for value in declared:
            assert Learned.from_dict({"reply_length": value}).reply_length == value
        assert Learned.from_dict({"reply_length": "巨长"}).reply_length is None


class TestEventEnvelope:
    """§ 1 的统一信封。"""

    def test_envelope_keys_and_order(self, runtime) -> None:
        event = runtime.bus.emit("write", {}, trace_id="trc_x")
        assert list(event.to_dict()) == spec.envelope_keys()

    def test_only_the_declared_types_are_publishable(self, runtime) -> None:
        assert set(EVENT_TYPES) == spec.event_types()
        with pytest.raises(ValueError):
            runtime.bus.emit("thinking", {}, trace_id="trc_x")

    def test_id_is_evt_plus_the_event_log_rowid(self, runtime) -> None:
        """`id` 为 `evt_` 加 `event_log` 自增 id；`since` 游标就是那个自增 id。"""
        event = runtime.bus.emit("write", {}, trace_id="trc_x")
        assert event.id == f"evt_{runtime.sqlite.latest_event_id()}"

    def test_event_log_columns_are_all_written(self, runtime) -> None:
        runtime.bus.emit("write", {"raw": "x"}, trace_id="trc_x")
        row = runtime.sqlite.events_since(0)[0]
        assert set(spec.sqlite_table_columns("event_log")) <= set(row)


class TestEventPayloads:
    """四类 payload 的键必须与 § 1 逐字一致，嵌套那几层也比。"""

    def _payload(self, facade: MemoryFacade, kind: str) -> dict:
        return next(e for e in reversed(facade.runtime.bus.history) if e.type == kind).payload

    def test_filter(self, facade: MemoryFacade, shapes) -> None:
        facade.ingest("", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        payload = self._payload(facade, "filter")
        assert set(payload) == shapes["filter"].keys
        assert payload["decision"] in set(shapes["filter"]["decision"].literals)
        assert payload["source"] in set(shapes["filter"]["source"].literals)
        assert 0.0 <= payload["score"] <= 1.0

    def test_write(self, facade: MemoryFacade, shapes) -> None:
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        payload = self._payload(facade, "write")
        assert set(payload) == shapes["write"].keys
        assert payload["speaker"] in set(shapes["write"]["speaker"].literals)
        for fact in payload["facts"]:
            assert set(fact) == shapes["write"]["facts"].keys

    def test_merge(self, facade: MemoryFacade, shapes) -> None:
        for _ in range(2):
            facade.ingest("我喜欢喝美式咖啡", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        payload = self._payload(facade, "merge")
        assert set(payload) == shapes["merge"].keys
        for entry in payload["absorbed"]:
            assert set(entry) == shapes["merge"]["absorbed"].keys
        for entry in payload["invalidated"]:
            assert set(entry) == shapes["merge"]["invalidated"].keys

    def test_recall(self, facade: MemoryFacade, shapes) -> None:
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        facade.recall("他叫什么", budget=Budget())
        payload = self._payload(facade, "recall")
        assert set(payload) == shapes["recall"].keys
        assert set(payload["plan"]) == shapes["recall"]["plan"].keys
        declared_paths = set(shapes["recall"]["plan"]["paths"].literals)
        assert set(payload["plan"]["paths"]) <= declared_paths
        assert set(payload["skipped_paths"]) <= declared_paths
        for hit in payload["hits"]:
            assert set(hit) == shapes["recall"]["hits"].keys

    def test_retrieval_plan_dataclass_matches_the_event_plan(self, shapes) -> None:
        plan = RetrievalPlan(paths=["semantic"], depth=8, rewritten="x")
        assert set(plan.to_dict()) == shapes["recall"]["plan"].keys

    def test_merge_op_dataclass_matches_the_event(self, shapes) -> None:
        assert set(MergeOp(result_id="a", result_text="b").to_dict()) == shapes["merge"].keys


class TestIngestRoute:
    """`POST /ingest` 的响应体 `{ trace_id, decision }`——后端要能直接转发。"""

    def test_decision_values(self, facade: MemoryFacade) -> None:
        declared = spec.ingest_decision_values()
        result = facade.ingest("", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        assert result.decision in declared

    def test_active_input_is_always_accepted(self, facade: MemoryFacade) -> None:
        """主动输入不进筛选（AD-3），响应体里的 decision 恒为 accept。"""
        result = facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        assert result.decision == "accept"


class TestUncertainNeverPersists:
    """§ 3：「`uncertain` 只发事件，不落库。」句子本身也从契约里读，改一个字这里就炸。"""

    SENTENCE = "**`uncertain` 只发事件，不落库。**"

    def test_the_contract_still_says_so(self) -> None:
        assert self.SENTENCE in spec.section(3)

    def test_only_accept_continues_to_compression(self, facade: MemoryFacade) -> None:
        """判定为 `uncertain` 时：`filter` 事件照发，热表零行，`write` 事件一条都没有。"""
        import json

        assert self.SENTENCE in spec.section(3)
        facade.runtime.sqlite.set_setting(
            "thresholds", json.dumps({"accept": 0.99, "uncertain": 0.01})
        )
        result = facade.ingest("买牛奶", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)

        assert result.decision == "uncertain"
        assert result.accepted == []
        assert facade.runtime.lance.count("hot") == 0
        assert facade.runtime.sqlite.list_visible_memory() == []
        kinds = [e.type for e in facade.runtime.bus.history]
        assert kinds == ["filter"], "只发事件，不落库"

    def test_reject_stops_at_the_same_place(self, facade: MemoryFacade) -> None:
        """`reject` 与 `uncertain` 一样到此为止，区别只在侧栏怎么呈现（§ 3 / § 6）。"""
        result = facade.ingest("", source=Source.AMBIENT_AUDIO, speaker="user", ts=BASE_TIME)
        assert result.decision == "reject"
        assert facade.runtime.lance.count("hot") == 0
        assert [e.type for e in facade.runtime.bus.history] == ["filter"]


class TestThresholds:
    """§ 1 `/config/thresholds` 的 body 与判定规则。"""

    def test_defaults_match_the_document(self) -> None:
        for name, value in spec.threshold_defaults().items():
            assert DEFAULTS[name] == value, name

    def test_decision_rule(self, runtime) -> None:
        """`score >= accept` 留，`score >= uncertain` 拿不准，否则丢。"""
        declared = spec.threshold_defaults()
        assert runtime.thresholds.decide(declared["accept"]) == "accept"
        assert runtime.thresholds.decide(declared["uncertain"]) == "uncertain"
        assert runtime.thresholds.decide(declared["uncertain"] - 0.01) == "reject"

    def test_hot_reload_from_sqlite_settings(self, runtime) -> None:
        """`PUT` 后热生效，落 SQLite `settings`。"""
        import json

        runtime.sqlite.set_setting("thresholds", json.dumps({"accept": 0.1, "uncertain": 0.05}))
        assert runtime.thresholds.decide(0.2) == "accept"


class TestLanceColumns:
    """§ 5 的 `facts` 表。热表与冷表同 schema。"""

    def test_written_row_carries_every_contract_column(self, facade: MemoryFacade) -> None:
        result = facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        row = facade.runtime.lance.get_many(result.accepted, "hot")[0]
        for column in spec.facts_columns():
            assert column in row, column

    def test_fact_row_builder_covers_the_same_columns(self) -> None:
        """写热表那一步用的是 `Fact.to_row()`，它给的键必须是契约字段的子集。"""
        row = Fact(
            id="fact_1",
            text="t",
            entities=[],
            tokens=[],
            speaker="user",
            source="dialogue",
            valid_from=BASE_TIME,
        ).to_row()
        assert set(row) <= set(spec.facts_columns())

    def test_vector_dimension_is_the_breaking_contract(self) -> None:
        """§ 5：向量维度是破坏性契约，两处常量必须相等。"""
        from qiuqiu_data.lance import VECTOR_DIM
        from qiuqiu_memory.embed import EMBED_DIM

        assert EMBED_DIM == VECTOR_DIM

    def test_speaker_and_source_values_come_from_the_contract(self, facade: MemoryFacade) -> None:
        """`speaker` 与 § 1 `write` 事件一致；`source` 就是 `Source` 枚举的 value。"""
        result = facade.ingest("我叫赵宁", source=Source.JOURNAL, speaker="assistant", ts=BASE_TIME)
        row = facade.runtime.lance.get_many(result.accepted, "hot")[0]
        shapes = spec.event_payload_shapes()
        assert row["speaker"] in set(shapes["write"]["speaker"].literals)
        assert row["source"] in set(spec.enum_members("Source").values())


class TestVisibleMemoryTable:
    """§ 5 的 `visible_memory` 表——写入方是 memory（ARCHITECTURE § 7 数据归属）。"""

    def test_row_columns(self, facade: MemoryFacade) -> None:
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        row = facade.runtime.sqlite.list_visible_memory()[0]
        assert set(spec.sqlite_table_columns("visible_memory")) <= set(row)

    def test_source_values(self, facade: MemoryFacade) -> None:
        """`source: auto|manual`，写在 § 5 那一行的注释里。"""
        import re

        line = next(ln for ln in spec.section(5).split("\n") if ln.startswith("visible_memory("))
        declared = set(re.search(r"source:\s*([\w|]+)", line).group(1).split("|"))
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        assert {m.source for m in facade.list_visible()} <= declared


class TestTimeFormat:
    """ARCHITECTURE § 7：所有时间戳 ISO 8601 UTC。样例见 § 1 的信封。"""

    def test_envelope_ts_matches_the_sample_shape(self, runtime) -> None:
        import re

        sample = spec.parse_object(
            spec.contracts_text(), spec.contracts_text().index('{\n  "id": "evt_')
        )["ts"].literals[0]
        pattern = re.sub(r"\d", r"\\d", re.escape(sample).replace(r"\-", "-"))
        assert re.fullmatch(pattern, runtime.bus.emit("write", {}, trace_id="t").ts)

    @pytest.mark.parametrize(
        "moment",
        [
            dt.datetime(2026, 9, 4, 22, 31, tzinfo=dt.UTC),
            dt.datetime(2026, 9, 4, 22, 31),
            dt.datetime(2026, 9, 5, 6, 31, tzinfo=dt.timezone(dt.timedelta(hours=8))),
        ],
    )
    def test_iso_is_utc_with_millis_and_z(self, moment: dt.datetime) -> None:
        assert iso(moment) == "2026-09-04T22:31:00.000Z"


class TestNamedEntryPoints:
    """契约里点名到文件、函数、键名的那几处。改名字就是破坏性改动。"""

    def test_layer_of_is_the_named_bucketing_rule(self) -> None:
        """§ 1：「归层规则在 `packages/memory/qiuqiu_memory/facade.py::layer_of`」。"""
        import importlib
        import re

        line = next(ln for ln in spec.section(1).split("\n") if "归层规则在" in ln)
        found = re.search(r"`([^`]+)::(\w+)`", line)
        assert found, "§ 1 里那句「归层规则在 …」被改了"
        dotted = found.group(1).removeprefix("packages/memory/").removesuffix(".py")
        module = importlib.import_module(dotted.replace("/", "."))
        assert callable(getattr(module, found.group(2)))

    def test_layer_semantics_follow_the_stability_table(self) -> None:
        """§ 1 的三层稳定度表：L0 身份 / L1 偏好 / L2 近况。"""
        from qiuqiu_memory.facade import layer_of

        assert layer_of("用户叫赵宁") == "L0"
        assert layer_of("用户的生日是十月一日") == "L0"
        assert layer_of("用户喜欢喝美式咖啡") == "L1"
        assert layer_of("用户明天下午三点要去医院") == "L2"

    def test_delete_route_lands_on_edit_visible(self, facade: MemoryFacade) -> None:
        """§ 1：`DELETE /memories/{id}` → `edit_visible(mid, deleted=True)`，
        `enabled` 置否 + `fact_ids` 逐条 `mark_superseded`，不删行。"""
        assert "`edit_visible(mid, deleted=True)`" in spec.section(1)
        facade.ingest("我叫赵宁", source=Source.DIALOGUE, speaker="user", ts=BASE_TIME)
        target = facade.list_visible()[0]

        facade.edit_visible(target.id, deleted=True)

        assert [m.enabled for m in facade.list_visible()] == [False], "不删行"
        row = facade.runtime.lance.get_many(target.fact_ids, "hot")[0]
        assert row["valid_to"] is not None

    def test_persona_snapshot_lands_on_the_three_settings_keys(
        self, persona: PersonaService
    ) -> None:
        """§ 3：热存储 `persona_snapshot` 落 `settings` 的三个键，memory 写 memory 读。"""
        import re

        line = next(ln for ln in spec.section(3).split("\n") if "persona_snapshot" in ln)
        declared = set(re.findall(r"`(persona\.\w+)`", line))
        assert declared == {"persona.snapshot", "persona.preset", "persona.sliders"}

        persona.set_preset("warm")
        stored = {k for k in declared if persona.runtime.sqlite.get_setting(k) is not None}
        assert stored == declared

    def test_nightly_is_the_named_demotion_entry(self) -> None:
        """§ 3：降冷入口是 `qiuqiu_memory.pipeline.tiering.nightly(runtime)`（AD-10）。"""
        import importlib
        import inspect as _inspect
        import re

        line = next(ln for ln in spec.section(3).split("\n") if "降冷的入口在" in ln)
        found = re.search(r"`([\w.]+)\.(\w+)\((\w+)\)`", line)
        module = importlib.import_module(found.group(1))
        entry = getattr(module, found.group(2))
        assert list(_inspect.signature(entry).parameters)[0] == found.group(3)


class TestPublicSurface:
    def test_backend_only_needs_four_names(self) -> None:
        for name in ("MemoryFacade", "PersonaService", "Budget", "Source"):
            assert hasattr(qiuqiu_memory, name)

    def test_all_is_importable(self) -> None:
        for name in qiuqiu_memory.__all__:
            assert hasattr(qiuqiu_memory, name), name

    @staticmethod
    def _imported_modules() -> dict:
        """本包每个文件真正 import 了哪些模块。注释与文档字符串里的提名不算。"""
        import ast
        from pathlib import Path

        root = Path(qiuqiu_memory.__file__).parent
        found: dict[Path, set[str]] = {}
        for path in root.rglob("*.py"):
            names: set[str] = set()
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                if isinstance(node, ast.Import):
                    names.update(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    names.add(node.module)
            found[path] = names
        return found

    def test_no_provider_imported_directly(self) -> None:
        """AD-8：所有调模型的地方经 `qiuqiu_models.registry`，不 import 供应商。"""
        for path, names in self._imported_modules().items():
            for name in names:
                assert not name.startswith("qiuqiu_models.providers"), f"{path}: {name}"
                assert name.split(".")[0] != "openai", f"{path}: {name}"

    def test_no_vision_in_this_layer(self) -> None:
        """AD-15：图片描述由后端调 Vision 生成，中间件不碰。"""
        import ast
        from pathlib import Path

        root = Path(qiuqiu_memory.__file__).parent
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    if node.func.attr == "get" and node.args:
                        first = node.args[0]
                        if isinstance(first, ast.Constant):
                            assert first.value not in {"vision", "asr", "vad", "tts"}, path

    def test_no_http_or_ipc_in_this_layer(self) -> None:
        """「不在这一层碰 HTTP、SSE、IPC」——任务书的约束。"""
        banned = {
            "fastapi",
            "starlette",
            "httpx",
            "requests",
            "aiohttp",
            "uvicorn",
            "sse_starlette",
        }
        for path, names in self._imported_modules().items():
            assert not {n.split(".")[0] for n in names} & banned, path


class TestFactoryDefaults:
    """§ 9 出厂默认。表在文档里，值在代码里，这里逼两边对上。"""

    def test_factory_preset_matches_the_contract(self) -> None:
        from qiuqiu_memory.persona import FACTORY_PRESET, PRESETS

        declared = spec.factory_defaults()["人格预设"]
        assert FACTORY_PRESET == declared
        assert declared in PRESETS, "出厂预设必须是 PRESETS 里真有的一个"

    def test_the_persona_prompt_carries_no_expression_state(self) -> None:
        """§ 9「不往上送」的 Python 半边：人格 prompt 里没有当前表情。

        模型不知道脸上在演什么，也就无从配合着演——32 个表情的调度权在本地
        规则表里。`OUTPUT` 里提到「表情」是在**禁止**模型写动作描写，
        不是在告诉它现在是哪个表情，两回事。
        """
        from qiuqiu_memory.persona import compose
        from qiuqiu_memory.types import Learned, Sliders

        prompt = compose("cute", Sliders(), Learned())
        for forbidden in ("emotionId", "当前表情", "你现在的表情", "表情 id"):
            assert forbidden not in prompt

        body = spec.section(9)
        assert "不往上送" in body and "不从下取" in body
