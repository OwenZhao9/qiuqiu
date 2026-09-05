"""音色目录。只收女声，且一个音色要能跨两条语音链路。"""

from __future__ import annotations

import pytest
from qiuqiu_models import voices


def test_every_voice_is_female() -> None:
    """丘丘的设定是女声，男声不进这份表。"""
    for voice in voices.VOICES:
        assert voice.tts_id.startswith("zh_female_"), voice.id
        if voice.realtime_id:
            assert voice.realtime_id.startswith("zh_female_"), voice.id


def test_ids_are_unique() -> None:
    assert len({v.id for v in voices.VOICES}) == len(voices.VOICES)
    assert len({v.tts_id for v in voices.VOICES}) == len(voices.VOICES)


def test_default_exists_and_works_on_both_paths() -> None:
    """默认音色两条链路都得有，否则端到端一上来就回退。"""
    default = voices.get(voices.DEFAULT_VOICE)
    assert default.id == voices.DEFAULT_VOICE
    assert default.realtime_supported


def test_unknown_id_falls_back_instead_of_raising() -> None:
    """用户存过的音色可能已被下架，这时要能开口，不能整条链路挂掉。"""
    assert voices.get("nope").id == voices.DEFAULT_VOICE
    assert voices.get(None).id == voices.DEFAULT_VOICE
    assert voices.get("").id == voices.DEFAULT_VOICE


def test_realtime_id_falls_back_when_the_voice_has_no_realtime_twin() -> None:
    """实时语音的精品音色只有四个，多数音色没有对应项。"""
    no_twin = next(v for v in voices.VOICES if not v.realtime_supported)
    assert voices.realtime_id(no_twin.id) == voices.REALTIME_FALLBACK
    assert voices.tts_id(no_twin.id) == no_twin.tts_id


@pytest.mark.parametrize("voice", voices.VOICES, ids=lambda v: v.id)
def test_listing_shape_is_stable_for_the_frontend(voice: voices.Voice) -> None:
    d = voice.to_dict()
    assert set(d) == {"id", "label", "blurb", "realtime_supported"}
    assert d["label"] and d["blurb"]
    # 供应商 ID 不外泄，前端只认稳定的短 id
    assert "uranus" not in str(d) and "jupiter" not in str(d)


def test_list_voices_returns_every_entry() -> None:
    assert len(voices.list_voices()) == len(voices.VOICES)
