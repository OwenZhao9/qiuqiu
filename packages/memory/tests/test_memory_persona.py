"""人格合成。规则逐字按 CONTRACTS § 7 / AD-11 / AD-12。"""

from __future__ import annotations

import json

import pytest
from qiuqiu_memory.errors import ContractError
from qiuqiu_memory.persona import (
    BOUNDARY,
    BOUNDARY_MARKER,
    FACTORY_PRESET,
    IDENTITY,
    IDENTITY_MARKER,
    LEARNED_MARKER,
    OUTPUT,
    PRESET_IDS,
    PRESET_MARKER,
    PRESETS,
    SLIDER_DIMENSIONS,
    PersonaService,
    compose,
    learned_block,
    preset_block,
)
from qiuqiu_memory.runtime import MemoryRuntime
from qiuqiu_memory.types import Learned, Sliders


class TestBoundary:
    def test_three_rules_present(self) -> None:
        assert BOUNDARY.startswith(BOUNDARY_MARKER)
        for marker in ("1.", "2.", "3."):
            assert marker in BOUNDARY

    def test_covers_the_three_required_topics(self) -> None:
        assert "恋爱" in BOUNDARY
        assert "依赖" in BOUNDARY
        assert "医疗" in BOUNDARY and "法律" in BOUNDARY

    def test_always_first_and_unconditional(self, persona: PersonaService) -> None:
        # 身份在最前，说话方式、边界紧跟其后；三段都不受预设影响
        for preset in (None, *PRESET_IDS):
            persona.set_preset(preset)
            assert persona.current().startswith(IDENTITY + OUTPUT + BOUNDARY)


class TestPresets:
    def test_four_presets_match_contract(self) -> None:
        assert set(PRESETS) == {"warm", "quiet", "cute", "sassy"}

    def test_every_preset_sets_all_four_sliders(self) -> None:
        for sliders in PRESETS.values():
            body = sliders.to_dict()
            assert set(body) == set(SLIDER_DIMENSIONS)
            assert all(0 <= v <= 100 for v in body.values())

    def test_preset_block_renders_one_line_per_dimension(self) -> None:
        block = preset_block(PRESETS["warm"])
        assert block.count(PRESET_MARKER) == 4

    def test_selecting_preset_writes_its_sliders(self, persona: PersonaService) -> None:
        persona.set_preset("sassy")
        assert persona.sliders.to_dict() == PRESETS["sassy"].to_dict()

    def test_unknown_preset_rejected_with_hint(self, persona: PersonaService) -> None:
        with pytest.raises(ContractError) as caught:
            persona.set_preset("grumpy")
        assert "warm" in caught.value.to_dict()["hint"]


class TestVacuum:
    """`preset: None` 是真空，**不是**中等值（AD-11）。"""

    def test_none_produces_no_preset_block(self, persona: PersonaService) -> None:
        persona.set_preset(None)
        assert PRESET_MARKER not in persona.current()

    def test_none_ignores_manually_set_sliders(self, persona: PersonaService) -> None:
        persona.set_preset(None)
        persona.set_sliders(Sliders(initiative=100, verbosity=100, emotion=100, humor=100))
        assert PRESET_MARKER not in persona.current()

    def test_sliders_apply_once_a_preset_is_chosen(self, persona: PersonaService) -> None:
        persona.set_preset("quiet")
        persona.set_sliders(Sliders(initiative=95, verbosity=95, emotion=95, humor=95))
        current = persona.current()
        assert PRESET_MARKER in current
        assert "主动性高" in current

    def test_compose_with_none_is_identity_and_boundary_only(self) -> None:
        assert compose(None, Sliders(), Learned()) == IDENTITY + OUTPUT + BOUNDARY


class TestLearnedOverride:
    """`learned_block` 覆盖 `preset_block` 里的同名维度（AD-12）。"""

    def test_reply_length_replaces_verbosity_line(self) -> None:
        sliders = Sliders(verbosity=95)
        learned = Learned(reply_length="short")
        out = compose("warm", sliders, learned)
        assert "话量多" not in out
        assert "喜欢短回复" in out

    def test_humor_tolerance_replaces_humor_line(self) -> None:
        out = compose("sassy", Sliders(humor=95), Learned(humor_tolerance=5))
        assert "玩笑尺度大：" not in out
        assert "不太吃梗" in out

    def test_untouched_dimensions_survive(self) -> None:
        out = compose("warm", PRESETS["warm"], Learned(reply_length="short"))
        assert "主动性高" in out
        assert "情绪浓度高" in out

    def test_section_order_is_boundary_preset_learned(self) -> None:
        out = compose("warm", PRESETS["warm"], Learned(nickname="小赵"))
        assert out.index(BOUNDARY_MARKER) < out.index(PRESET_MARKER) < out.index(LEARNED_MARKER)

    def test_empty_learned_renders_nothing(self) -> None:
        assert learned_block(Learned()) == ""

    def test_topics_capped_at_six(self) -> None:
        block = learned_block(Learned(topics=[f"话题{i}" for i in range(20)]))
        assert block.count("、") == 5


class TestSnapshot:
    def test_current_reads_the_cached_snapshot(self, persona: PersonaService) -> None:
        """`current()` 只读热存储快照（AD-2），不在请求路径上现拼。"""
        persona.set_preset("warm")
        persona.runtime.sqlite.set_setting("persona.snapshot", "手写的快照")
        assert persona.current() == "手写的快照"

    def test_missing_snapshot_is_computed_once(self, persona: PersonaService) -> None:
        # 出厂种子（契约 § 9）会顺手算一遍快照，所以空库其实是有快照的。
        # 这条测的是「没有快照时会算一次并缓存」，先把它清掉才测得到
        persona.runtime.sqlite.set_setting("persona.snapshot", None)
        assert persona.runtime.sqlite.get_setting("persona.snapshot") is None
        computed = persona.current()
        assert persona.runtime.sqlite.get_setting("persona.snapshot") == computed

    def test_set_preset_recomputes(self, persona: PersonaService) -> None:
        persona.set_preset("quiet")
        quiet = persona.current()
        persona.set_preset("sassy")
        assert persona.current() != quiet

    def test_set_sliders_recomputes(self, persona: PersonaService) -> None:
        persona.set_preset("warm")
        before = persona.current()
        persona.set_sliders(Sliders(initiative=0, verbosity=0, emotion=0, humor=0))
        assert persona.current() != before


class TestLearnedStorage:
    def test_reads_latest_persona_learned_version(self, persona: PersonaService) -> None:
        persona.runtime.sqlite.append_persona_learned({"nickname": "老赵"})
        persona.runtime.sqlite.append_persona_learned({"nickname": "小赵"})
        assert persona.learned.nickname == "小赵"

    def test_reset_learned_appends_empty_version(self, persona: PersonaService) -> None:
        """重置是往前写一版空的，不是删历史——跟事实不物理删除同一个态度（AD-9）。"""
        persona.runtime.sqlite.append_persona_learned({"nickname": "小赵"})
        assert persona.reset_learned().to_dict() == {}
        assert len(persona.runtime.sqlite.list_persona_learned()) == 2
        assert LEARNED_MARKER not in persona.current()

    def test_broken_sliders_json_falls_back_to_defaults(self, persona: PersonaService) -> None:
        persona.runtime.sqlite.set_setting("persona.sliders", "{ 不是 JSON")
        assert persona.sliders.to_dict() == Sliders().to_dict()

    def test_preset_setting_with_junk_reads_as_none(self, persona: PersonaService) -> None:
        persona.runtime.sqlite.set_setting("persona.preset", "grumpy")
        assert persona.preset is None


class TestSlidersAndLearnedTypes:
    def test_sliders_clamped(self) -> None:
        body = Sliders.from_dict({"initiative": 999, "verbosity": -5, "humor": "很高"}).to_dict()
        assert body == {"initiative": 100, "verbosity": 0, "emotion": 50, "humor": 50}

    def test_learned_to_dict_drops_none_keys(self) -> None:
        assert Learned(nickname="小赵").to_dict() == {"nickname": "小赵"}

    def test_learned_merge_keeps_missing_values(self) -> None:
        """新值覆盖、缺失沿用——一次没归纳出称呼不该把上次学到的抹掉。"""
        old = Learned(nickname="小赵", reply_length="long")
        merged = old.merge(Learned(reply_length="short"))
        assert merged.nickname == "小赵"
        assert merged.reply_length == "short"

    def test_learned_rejects_bad_reply_length(self) -> None:
        assert Learned.from_dict({"reply_length": "巨长"}).reply_length is None

    def test_learned_round_trips_through_json(self, runtime: MemoryRuntime) -> None:
        body = Learned(nickname="小赵", topics=["咖啡"], humor_tolerance=80).to_dict()
        assert Learned.from_dict(json.loads(json.dumps(body))).to_dict() == body


class TestIdentity:
    """丘丘得知道自己叫什么。

    没有这一段时实测：问「你叫什么」，模型会把记忆里的用户名（「用户名叫赵宁」）
    改一改，答「我叫阿宁」。人格里从来没写过它的名字，它只能编。
    """

    def test_identity_states_the_name(self) -> None:
        assert "丘丘" in IDENTITY
        assert IDENTITY_MARKER in IDENTITY

    def test_identity_is_first_even_with_everything_set(self) -> None:
        out = compose("cute", Sliders(humor=90), Learned(reply_length="short"))
        assert out.startswith(IDENTITY)
        assert out.index(IDENTITY) < out.index(BOUNDARY)

    def test_snapshot_recomputed_when_compose_version_changes(
        self, persona: PersonaService
    ) -> None:
        """快照是「代码 + 设置」的物化结果。设置改了会重算，代码改了不会——
        所以要有个版本号，对不上就重算。没有它，改了 IDENTITY 的文案，
        老库里存的还是旧 prompt，改了等于没改。"""
        persona.current()  # 先落一份快照
        sqlite = persona.runtime.sqlite
        sqlite.set_setting("persona.snapshot", "这是上一版合成出来的老 prompt")
        # 版本还对得上：照旧读缓存，不重算
        assert persona.current() == "这是上一版合成出来的老 prompt"
        # 版本对不上：重算，老的被顶掉
        sqlite.set_setting("persona.snapshot_version", "0")
        assert persona.current().startswith(IDENTITY)


class TestOutputStyle:
    """不写括号旁白。

    丘丘有表情引擎，情绪推断会把这句回复切成对应的脸；括号里再写一遍等于
    同一件事说两遍，聊天窗口里读起来像剧本不像说话。
    """

    def test_forbids_parenthetical_stage_directions(self) -> None:
        assert "括号" in OUTPUT
        assert "动作" in OUTPUT and "神态" in OUTPUT

    def test_covers_the_case_that_actually_breaks_it(self) -> None:
        # 压不住的正是这一句：用户直接要求「表演一个生气」
        assert "表演" in OUTPUT

    def test_is_unconditional_like_the_boundary(self, persona: PersonaService) -> None:
        for preset in (None, *PRESET_IDS):
            persona.set_preset(preset)
            assert OUTPUT in persona.current()


class TestFactorySeed:
    """出厂人格（契约 § 9）：空库种一次，之后用户说了算。"""

    def test_a_fresh_install_is_cute(self, persona: PersonaService) -> None:
        """装完不动任何设置，丘丘就是可爱的——不是一张白纸。"""
        assert persona.preset == FACTORY_PRESET == "cute"
        assert persona.sliders == PRESETS["cute"]
        assert "预设" in persona.current()

    def test_clearing_the_preset_stays_cleared(self, persona: PersonaService) -> None:
        """真空（AD-11）是用户能选到的状态，不能被出厂默认拽回来。

        这就是「种子」与「兜底」的区别：兜底写法下，用户清空预设、重开进程，
        又变回可爱，等于这个选项形同虚设。
        """
        persona.set_preset(None)
        assert persona.preset is None

        again = PersonaService(runtime=persona.runtime)
        assert again.preset is None, "种过就不该再种"
        assert again.seed_factory_defaults() is False

    def test_an_existing_choice_is_not_overwritten(self, persona: PersonaService) -> None:
        """升级到带出厂默认的版本时，老库里已有的选择要保住。"""
        persona.set_preset("quiet")
        persona.runtime.sqlite.set_setting("persona.seeded", None)  # 装成没种过的老库

        again = PersonaService(runtime=persona.runtime)
        assert again.preset == "quiet"

    def test_seeding_is_idempotent(self, persona: PersonaService) -> None:
        assert persona.seed_factory_defaults() is False
        assert persona.preset == "cute"
