"""丘丘可选的音色目录。

**只收女声**——丘丘的设定是女声，男声与客服、教学、播报类音色不进这份表。
上游有一百多个中文女声，这里挑的是适合「桌面陪伴」这个场景的十个。

一个音色要同时能用在两条链路上，前端才只需要选一次：

- **级联**（`VOICE_MODE=cascade`）走豆包语音合成 2.0，音色 ID 是 `*_uranus_bigtts`
- **端到端**（`VOICE_MODE=realtime`）走实时语音大模型，O 路线的精品音色 ID 是
  `*_jupiter_bigtts`

同一个人的两个 ID 不一样（Vivi 在 TTS 里是 `zh_female_vv_uranus_bigtts`，在实时语音
里是 `zh_female_vv_jupiter_bigtts`），所以每条记录两个字段都存。实时语音只有四个精品
音色，其中两个是女声；其余八个音色没有实时语音对应项，`realtime_id` 为 `None`，
选中它们时端到端链路回退到默认音色。

表里每个 `tts_id` 都用真实接口验过能出声。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: 端到端链路没有对应音色时用它。
REALTIME_FALLBACK = "zh_female_vv_jupiter_bigtts"


@dataclass(frozen=True, slots=True)
class Voice:
    """一个可选音色。`id` 是前端与配置里用的稳定标识，不随供应商 ID 变。"""

    id: str
    label: str
    blurb: str
    tts_id: str
    realtime_id: str | None = None

    @property
    def realtime_supported(self) -> bool:
        return self.realtime_id is not None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "blurb": self.blurb,
            "realtime_supported": self.realtime_supported,
        }


#: 默认音色。活泼灵动，两条链路都有，适合桌宠。
DEFAULT_VOICE = "vivi"

VOICES: tuple[Voice, ...] = (
    Voice(
        id="vivi",
        label="Vivi",
        blurb="活泼灵动，分享欲强",
        tts_id="zh_female_vv_uranus_bigtts",
        realtime_id="zh_female_vv_jupiter_bigtts",
    ),
    Voice(
        id="xiaohe",
        label="小何",
        blurb="甜美活泼，带台湾口音",
        tts_id="zh_female_xiaohe_uranus_bigtts",
        realtime_id="zh_female_xiaohe_jupiter_bigtts",
    ),
    Voice(
        id="linjianvhai",
        label="邻家女孩",
        blurb="自然亲切，像住隔壁的朋友",
        tts_id="zh_female_linjianvhai_uranus_bigtts",
    ),
    Voice(
        id="qingxin",
        label="清新女声",
        blurb="干净清爽，不腻",
        tts_id="zh_female_qingxinnvsheng_uranus_bigtts",
    ),
    Voice(
        id="tianmeixiaoyuan",
        label="甜美小源",
        blurb="甜而不腻，语速偏慢",
        tts_id="zh_female_tianmeixiaoyuan_uranus_bigtts",
    ),
    Voice(
        id="tianmeitaozi",
        label="甜美桃子",
        blurb="偏少女，尾音上扬",
        tts_id="zh_female_tianmeitaozi_uranus_bigtts",
    ),
    Voice(
        id="shuangkuaisisi",
        label="爽快思思",
        blurb="干脆利落，不拖泥带水",
        tts_id="zh_female_shuangkuaisisi_uranus_bigtts",
    ),
    Voice(
        id="cancan",
        label="知性灿灿",
        blurb="沉稳知性，适合长句",
        tts_id="zh_female_cancan_uranus_bigtts",
    ),
    Voice(
        id="gaolengyujie",
        label="高冷御姐",
        blurb="冷淡疏离，配「毒舌」预设",
        tts_id="zh_female_gaolengyujie_uranus_bigtts",
    ),
    Voice(
        id="sajiaoxuemei",
        label="撒娇学妹",
        blurb="黏人，配「可爱」预设",
        tts_id="zh_female_sajiaoxuemei_uranus_bigtts",
    ),
)

_BY_ID = {v.id: v for v in VOICES}


def get(voice_id: str | None) -> Voice:
    """按 id 取音色。未知 id 回退默认，不抛错——用户存过的音色可能已被下架。"""
    return _BY_ID.get((voice_id or "").strip()) or _BY_ID[DEFAULT_VOICE]


def list_voices() -> list[dict[str, Any]]:
    """供 `GET /voices`。"""
    return [v.to_dict() for v in VOICES]


def tts_id(voice_id: str | None) -> str:
    return get(voice_id).tts_id


def realtime_id(voice_id: str | None) -> str:
    """端到端链路用的 ID。这个音色没有实时对应项时回退默认。"""
    return get(voice_id).realtime_id or REALTIME_FALLBACK
