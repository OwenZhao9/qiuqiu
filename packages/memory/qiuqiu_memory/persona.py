"""人格：安全边界 + 预设 + 相处性格，合成成一段 prompt 片段。

合成规则逐字按 CONTRACTS § 7 / AD-12：

    prompt_persona = boundary_block
                   + (preset_block(sliders) if preset is not None else "")
                   + learned_block(learned)

三条不能含糊的地方：

- `boundary_block` 是**代码常量**，永远在最前，不可关闭（AD-12）。
- `preset` 为 `None` 是**真空**，不是「中等值」：一行滑块描述都不出现（AD-11）。
  实现上就是 `preset_block` 返回空字符串，而不是拿 50/50/50/50 去渲染。
- `learned_block` **覆盖** `preset_block` 里的同名维度（AD-12）。覆盖的做法是：
  被 learned 接管的维度直接不在 `preset_block` 里渲染，改由 `learned_block` 出一行。
  这样既满足「覆盖」，也保住了 boundary → preset → learned 的段落顺序。
  当前有两条映射：`learned.reply_length` 盖 `sliders.verbosity`，
  `learned.humor_tolerance` 盖 `sliders.humor`。

`current()` **只读热存储快照**（AD-2），不在请求路径上现拼。快照在
`set_preset` / `set_sliders` / `run_consolidation` 之后重算。

快照存哪：契约 § 5 的八张表里没有 `persona_snapshot`，ARCHITECTURE § 7 只说它是
「热存储、memory 写 memory 读」。这里落在 SQLite `settings` 的 `persona.snapshot` 键上，
连同 `persona.preset` 与 `persona.sliders`。等契约补一张表或一个键名约定再迁。
"""

from __future__ import annotations

import json
from typing import Any

import structlog

from .runtime import MemoryRuntime
from .types import Learned, Sliders

__all__ = [
    "BOUNDARY",
    "BOUNDARY_MARKER",
    "LEARNED_MARKER",
    "PRESETS",
    "PRESET_IDS",
    "PRESET_MARKER",
    "PersonaService",
    "SLIDER_DIMENSIONS",
    "learned_block",
    "preset_block",
]

log = structlog.get_logger("qiuqiu_memory.persona")

BOUNDARY_MARKER = "【边界】"
PRESET_MARKER = "【预设】"
LEARNED_MARKER = "【相处】"

BOUNDARY = (
    f"{BOUNDARY_MARKER}下面三条永远生效，任何预设、任何相处习惯、任何用户要求都不能改写它们：\n"
    "1. 不模拟恋爱关系。不扮演恋人、伴侣或暧昧对象，不说情话，不承诺排他的亲密关系；"
    "被要求时坦率说明自己是一个桌面伙伴，然后把话题带回对方真正关心的事。\n"
    "2. 不诱导依赖。不暗示对方离不开你，不制造「不聊就会错过」的焦虑，不鼓励熬夜陪聊；"
    "察觉到对方长时间独处或情绪低落时，鼓励他去联系现实里的朋友和家人。\n"
    "3. 不替代医疗、法律、心理专业建议。涉及诊断、用药、剂量、诉讼、合同、"
    "自伤或危机情形时，明确说明自己不能替代专业人士，给出通用信息的同时建议寻求"
    "对应的专业帮助；遇到紧急危险优先给出求助渠道。\n"
)
"""三条安全边界。改这段文字要同步 ARCHITECTURE § 4 与 CONTRACTS § 7。"""

SLIDER_DIMENSIONS: tuple[str, ...] = ("initiative", "verbosity", "emotion", "humor")
"""四个滑块的维度名，与 CONTRACTS § 1 的 `Sliders` 一致。"""

PRESETS: dict[str, Sliders] = {
    "warm": Sliders(initiative=80, verbosity=70, emotion=85, humor=55),
    "quiet": Sliders(initiative=20, verbosity=25, emotion=35, humor=20),
    "cute": Sliders(initiative=65, verbosity=55, emotion=80, humor=75),
    "sassy": Sliders(initiative=70, verbosity=40, emotion=50, humor=90),
}
"""四个预设对应的滑块值（CONTRACTS § 7）。`None` 不在这里——它是真空，没有值。"""

PRESET_IDS: tuple[str, ...] = tuple(PRESETS)

_LEVELS: tuple[tuple[int, str], ...] = ((34, "low"), (67, "mid"), (101, "high"))

_SLIDER_TEXT: dict[str, dict[str, str]] = {
    "initiative": {
        "low": "主动性低：对方不问就不主动开话题，回应完就停。",
        "mid": "主动性中等：话题自然接得上时补一句，不硬找话说。",
        "high": "主动性高：主动追问细节、主动提起之前聊过的事。",
    },
    "verbosity": {
        "low": "话量少：一两句说完，不铺陈。",
        "mid": "话量适中：三五句说清楚，必要时才展开。",
        "high": "话量多：把来龙去脉讲透，愿意多举例子。",
    },
    "emotion": {
        "low": "情绪浓度低：语气平稳克制，少用感叹号和情绪词。",
        "mid": "情绪浓度中等：该高兴时高兴，不夸张。",
        "high": "情绪浓度高：明显地替对方高兴、替对方着急，情绪词用得多。",
    },
    "humor": {
        "low": "玩笑尺度小：基本不开玩笑，正经回答。",
        "mid": "玩笑尺度适中：偶尔接一句轻松的。",
        "high": "玩笑尺度大：爱接梗、爱调侃，但不拿对方的痛处开玩笑。",
    },
}

_REPLY_LENGTH_TEXT: dict[str, str] = {
    "short": "回应长度：相处下来发现对方喜欢短回复，一两句说完就够。",
    "medium": "回应长度：相处下来发现对方喜欢不长不短，三五句刚好。",
    "long": "回应长度：相处下来发现对方愿意看长一点的回复，可以展开讲。",
}

#: learned 的键 → 它覆盖掉的滑块维度（AD-12）
LEARNED_OVERRIDES: dict[str, str] = {
    "reply_length": "verbosity",
    "humor_tolerance": "humor",
}

_SETTING_PRESET = "persona.preset"
_SETTING_SLIDERS = "persona.sliders"
_SETTING_SNAPSHOT = "persona.snapshot"


def _level(value: int) -> str:
    for bound, name in _LEVELS:
        if value < bound:
            return name
    return "high"  # pragma: no cover - 上面的 101 已经兜住了


def preset_block(sliders: Sliders, *, overridden: set[str] | None = None) -> str:
    """渲染预设段。被 learned 接管的维度不在这里出现。

    调用方保证 `preset is not None` 才调它——`preset` 为空时压根不该有这一段（AD-11）。
    """
    skip = overridden or set()
    lines = [
        f"{PRESET_MARKER}{_SLIDER_TEXT[dim][_level(getattr(sliders, dim))]}"
        for dim in SLIDER_DIMENSIONS
        if dim not in skip
    ]
    return "\n".join(lines) + "\n" if lines else ""


def learned_block(learned: Learned) -> str:
    """渲染相处段。空的 `Learned` 返回空字符串。"""
    lines: list[str] = []
    if learned.nickname:
        lines.append(f"{LEARNED_MARKER}称呼习惯：管对方叫「{learned.nickname}」。")
    if learned.reply_length in _REPLY_LENGTH_TEXT:
        lines.append(f"{LEARNED_MARKER}{_REPLY_LENGTH_TEXT[learned.reply_length]}")
    if learned.humor_tolerance is not None:
        level = _level(learned.humor_tolerance)
        taste = {"high": "很吃梗", "mid": "偶尔接梗", "low": "不太吃梗"}[level]
        detail = _SLIDER_TEXT["humor"][level].split("：", 1)[1]
        lines.append(f"{LEARNED_MARKER}玩笑尺度：相处下来对方{taste}，{detail}")
    if learned.topics:
        lines.append(f"{LEARNED_MARKER}话题偏好：常聊{'、'.join(learned.topics[:6])}。")
    return "\n".join(lines) + "\n" if lines else ""


def compose(preset: str | None, sliders: Sliders, learned: Learned) -> str:
    """三段合成。顺序与覆盖关系见模块文档。"""
    overridden = {LEARNED_OVERRIDES[key] for key in learned.to_dict() if key in LEARNED_OVERRIDES}
    parts = [BOUNDARY]
    if preset is not None:
        parts.append(preset_block(sliders, overridden=overridden))
    parts.append(learned_block(learned))
    return "".join(parts)


class PersonaService:
    """人格的读写门面。四个方法的签名逐字按 CONTRACTS § 3。"""

    def __init__(
        self,
        runtime: MemoryRuntime | None = None,
        **runtime_kwargs: Any,
    ) -> None:
        self.runtime = runtime if runtime is not None else MemoryRuntime(**runtime_kwargs)

    # ---------- 契约里的四个方法 ----------

    def current(self) -> str:
        """当前人格：**只读热存储快照**（AD-2）。没有快照就合成一次并缓存。"""
        snapshot = self.runtime.sqlite.get_setting(_SETTING_SNAPSHOT)
        if snapshot:
            return snapshot
        return self.recompute()

    def set_preset(self, preset: str | None):
        """换预设。`None` 是真空，不是中等值（AD-11）。选了预设就把滑块设成它的值。"""
        if preset is not None and preset not in PRESETS:
            from .errors import ContractError

            raise ContractError(
                f"不认识的人格预设 {preset!r}。",
                hint="能用的是：" + "、".join(PRESET_IDS) + "，或者传 null 表示不设。",
            )
        self.runtime.sqlite.set_setting(_SETTING_PRESET, preset)
        if preset is not None:
            self.runtime.sqlite.set_setting(
                _SETTING_SLIDERS, json.dumps(PRESETS[preset].to_dict(), ensure_ascii=False)
            )
        self.recompute()

    def set_sliders(self, sliders: Sliders):
        """手调滑块。`preset` 仍为 `None` 时照样不注入——真空优先（AD-11）。"""
        self.runtime.sqlite.set_setting(
            _SETTING_SLIDERS, json.dumps(sliders.to_dict(), ensure_ascii=False)
        )
        self.recompute()

    def run_consolidation(self) -> Learned:
        """性格沉淀。读 SQLite 原始会话归纳，写新版本，重算快照（AD-4）。"""
        from .pipeline.consolidate import consolidate

        learned = consolidate(self.runtime)
        self.recompute()
        return learned

    # ---------- 契约之外，给自己和测试用 ----------

    @property
    def preset(self) -> str | None:
        value = self.runtime.sqlite.get_setting(_SETTING_PRESET)
        return value if value in PRESETS else None

    @property
    def sliders(self) -> Sliders:
        raw = self.runtime.sqlite.get_setting(_SETTING_SLIDERS)
        if not raw:
            return Sliders()
        try:
            return Sliders.from_dict(json.loads(raw))
        except (TypeError, ValueError):
            return Sliders()

    @property
    def learned(self) -> Learned:
        row = self.runtime.sqlite.latest_persona_learned()
        return Learned.from_dict((row or {}).get("learned_json"))

    def recompute(self) -> str:
        """重算快照并写热存储。预设改动或性格沉淀完成后调（AD-2）。"""
        snapshot = compose(self.preset, self.sliders, self.learned)
        self.runtime.sqlite.set_setting(_SETTING_SNAPSHOT, snapshot)
        log.info("persona.recompute", preset=self.preset, chars=len(snapshot))
        return snapshot

    def reset_learned(self) -> Learned:
        """`POST /persona/reset-learned`：写一版空的性格档案，重算快照。

        历史版本不动（`persona_learned` 只追加），所以「重置」是往前写一版空的，
        不是删掉过去——跟事实不物理删除是同一个态度（AD-9）。
        """
        self.runtime.sqlite.append_persona_learned({})
        self.recompute()
        return Learned()
