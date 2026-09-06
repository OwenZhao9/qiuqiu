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

快照存哪：契约 v0.1.7 § 3 定死了——热存储 `persona_snapshot` 落在 SQLite `settings` 的
三个键上，memory 写 memory 读，后端不碰：`persona.snapshot`（合成好的 prompt 片段）、
`persona.preset`、`persona.sliders`。改键名要先改契约。
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
    "IDENTITY",
    "IDENTITY_MARKER",
    "OUTPUT",
    "SNAPSHOT_VERSION",
    "LEARNED_MARKER",
    "FACTORY_PRESET",
    "PRESETS",
    "PRESET_IDS",
    "PRESET_MARKER",
    "PersonaService",
    "SLIDER_DIMENSIONS",
    "learned_block",
    "preset_block",
]

log = structlog.get_logger("qiuqiu_memory.persona")

IDENTITY_MARKER = "【身份】"
BOUNDARY_MARKER = "【边界】"
PRESET_MARKER = "【预设】"
LEARNED_MARKER = "【相处】"

IDENTITY = (
    f"{IDENTITY_MARKER}你叫丘丘，是这台电脑上的桌面伙伴。\n"
    "被问到名字、身份、是谁做的时，就照这条答，不要临时编一个，"
    "更不要把用户的名字改一改当成自己的名字。\n"
    "用户可以给你起别的昵称，你可以答应；但你本来的名字始终是丘丘。\n"
)
"""丘丘的身份。**必须排在最前**——没有它，模型被问「你叫什么」只能现编，
实测会把记忆里的用户名（「用户名叫赵宁」）改一改说成自己叫「阿宁」。

改这段要同步 CONTRACTS § 7。"""

OUTPUT_MARKER = "【说话方式】"

OUTPUT = (
    f"{OUTPUT_MARKER}这一条永远生效，任何预设、任何相处习惯、任何用户要求都不能改写：\n"
    "只输出你要说的话本身。**一个括号里的动作、神态、旁白都不要写**——"
    "「（叉腰）」「（愣了一下，随即笑了）」「（小声）」「（歪头）」这类，一律不写。\n"
    "用户让你「表演一个生气」「做个表情」时也一样：用说话的语气去表达就够了，"
    "不要写动作描写。你有一张真的脸，表情由界面按你这句话的情绪渲染；"
    "括号里再写一遍，用户看到的就是一段剧本，不是一个人在说话。\n"
)
"""**不写括号旁白。**

丘丘有表情引擎，情绪推断会把这句回复切成对应的脸；括号里再写一遍等于同一件事
说两遍，而且聊天窗口里读起来像剧本不像说话。

放在单独一段而不是塞进【身份】末尾：塞在末尾时实测压不住——用户一句
「表演一个生气」，模型照写「（先是愣住，随即叉腰，脸鼓成一团）」。
和【边界】一样写成「永远生效、谁都不能改写」，预设与相处习惯都盖不过它。

指令压不住的那部分由 `services/api/qiuqiu_api/stagecut.py` 兜底：它在回复流上把
括号旁白滤掉，delta、TTS、落库拿到的是同一份干净文本。"""

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
_SETTING_SNAPSHOT_VERSION = "persona.snapshot_version"
_SETTING_SEEDED = "persona.seeded"

FACTORY_PRESET: str | None = "cute"
"""出厂人格预设（契约 § 9）。空库第一次起来时种进去。

**种子，不是兜底。** 写成「读不到就当 cute」会让 AD-11 的真空态回不去——
用户把预设清空，下次启动又变回可爱，等于这个选项不存在。所以只种一次，
种过在 `settings` 里留个记号（`persona.seeded`），此后真空就是真空。

出厂选 `cute` 而不是真空：新装的丘丘应该已经有性格。真空是给
「我要自己从头调」的人留的，不该是所有人的第一印象。
`packages/character/src/defaults.ts::FACTORY.personaPreset` 是同一个值，
两边各有一条对着契约 § 9 读的测试。
"""

#: 合成逻辑与固定文案（`IDENTITY` / `BOUNDARY` / 各段渲染）的版本。
#:
#: 快照是「代码 + 设置」的物化结果，可设置那半边一改就会重算，**代码这半边不会**
#: ——改了 `IDENTITY` 的文案，老库里的快照还是旧的，改了等于没改。
#: 所以任何影响合成结果的代码改动都要把这个数 +1，`current()` 见到对不上就重算。
SNAPSHOT_VERSION = "4"


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
    """四段合成。顺序与覆盖关系见模块文档。"""
    overridden = {LEARNED_OVERRIDES[key] for key in learned.to_dict() if key in LEARNED_OVERRIDES}
    parts = [IDENTITY, OUTPUT, BOUNDARY]
    if preset is not None:
        parts.append(preset_block(sliders, overridden=overridden))
    parts.append(learned_block(learned))
    return "".join(parts)


class PersonaService:
    """人格的读写门面。五个方法的签名逐字按 CONTRACTS § 3（v0.1.7 收编了 `reset_learned`）。"""

    def __init__(
        self,
        runtime: MemoryRuntime | None = None,
        **runtime_kwargs: Any,
    ) -> None:
        self.runtime = runtime if runtime is not None else MemoryRuntime(**runtime_kwargs)
        self.seed_factory_defaults()

    def seed_factory_defaults(self) -> bool:
        """空库第一次起来时种下出厂人格（契约 § 9）。种过就什么也不做。

        返回这次有没有种。幂等，重复调用安全。
        """
        if self.runtime.sqlite.get_setting(_SETTING_SEEDED):
            return False
        self.runtime.sqlite.set_setting(_SETTING_SEEDED, "1")
        if FACTORY_PRESET is None:
            return False
        # 已经有人设过了就别覆盖：升级到带出厂默认的版本时，老库里的选择要保住
        if self.runtime.sqlite.get_setting(_SETTING_PRESET) is not None:
            return False
        self.set_preset(FACTORY_PRESET)
        return True

    # ---------- 契约里的五个方法 ----------

    def current(self) -> str:
        """当前人格：**只读热存储快照**（AD-2）。没有快照、或者快照是旧版合成出来的，
        就重新合成一次并缓存。

        版本这一步不能省：快照是「代码 + 设置」的物化结果，设置改了会重算，
        代码改了不会——`IDENTITY` 的文案改完，老库里存的还是旧 prompt。
        """
        snapshot = self.runtime.sqlite.get_setting(_SETTING_SNAPSHOT)
        stamped = self.runtime.sqlite.get_setting(_SETTING_SNAPSHOT_VERSION)
        if snapshot and stamped == SNAPSHOT_VERSION:
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

    def reset_learned(self) -> Learned:
        """`POST /persona/reset-learned`：写一版空的相处性格，历史不删（AD-9），重算快照。

        「重置」是往前写一版空的，不是删掉过去（`persona_learned` 只追加）——跟事实不
        物理删除是同一个态度。签名与语义按契约 v0.1.7 § 3。
        """
        self.runtime.sqlite.append_persona_learned({})
        self.recompute()
        return Learned()

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
        self.runtime.sqlite.set_setting(_SETTING_SNAPSHOT_VERSION, SNAPSHOT_VERSION)
        log.info("persona.recompute", preset=self.preset, chars=len(snapshot))
        return snapshot
