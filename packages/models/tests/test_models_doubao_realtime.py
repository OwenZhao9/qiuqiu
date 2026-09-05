"""豆包端到端实时语音：二进制协议与事件翻译。不出网。

协议部分**拿文档里的真实帧逐字节比对**——这种自定义二进制最容易在字节序、
optional 段顺序、session id 该不该带这几处出错，而错了只表现为服务端默默断开，
不好排查。
"""

from __future__ import annotations

import array
import json
import math

import pytest
from qiuqiu_models import base
from qiuqiu_models.providers import _volc_protocol as proto
from qiuqiu_models.providers import doubao_realtime as dr

# 接入文档 § 2.3 备注里给出的两个真实客户端帧
DOC_START_CONNECTION = bytes([17, 20, 16, 0, 0, 0, 0, 1, 0, 0, 0, 2, 123, 125])
DOC_SESSION_ID = "75a6126e-427f-49a1-a2c1-621143cb9db3"
DOC_START_SESSION = bytes(
    [17, 20, 16, 0, 0, 0, 0, 100, 0, 0, 0, 36]
    + list(DOC_SESSION_ID.encode())
    + [0, 0, 0, 60]
    + list(
        json.dumps(
            {"dialog": {"bot_name": "豆包", "dialog_id": "", "extra": None}},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
    )
)
# 服务端 TTSResponse 帧的前 100 字节（文档示例，payload 被截断）
DOC_TTS_RESPONSE = bytes(
    [17, 180, 0, 0, 0, 0, 1, 96, 0, 0, 0, 36]
    + list(b"3c791a7d-227a-4446-993b-24f9e302cc98")
    + [0, 0, 7, 252]
    + list(b"OggS")
    + [0] * 44
)


def tone(samples: int) -> bytes:
    return array.array("h", (int(8000 * math.sin(i / 8)) for i in range(samples))).tobytes()


class TestProtocolAgainstRealFrames:
    def test_start_connection_matches_the_documented_bytes(self) -> None:
        assert proto.encode(proto.Event.START_CONNECTION, payload={}) == DOC_START_CONNECTION

    def test_start_session_matches_the_documented_bytes(self) -> None:
        """连 JSON 的分隔符都要对上：默认 `json.dumps` 会多出空格，长度就不一样了。"""
        got = proto.encode(
            proto.Event.START_SESSION,
            payload={"dialog": {"bot_name": "豆包", "dialog_id": "", "extra": None}},
            session_id=DOC_SESSION_ID,
        )
        assert got == DOC_START_SESSION

    def test_decodes_the_documented_server_audio_frame(self) -> None:
        frame = proto.decode(DOC_TTS_RESPONSE)
        assert frame.msg_type is proto.MsgType.AUDIO_SERVER
        assert frame.event is proto.Event.TTS_RESPONSE
        assert frame.session_id == "3c791a7d-227a-4446-993b-24f9e302cc98"
        assert frame.payload.startswith(b"OggS")

    def test_connection_events_carry_no_session_id(self) -> None:
        """连接类事件带上 session id 会被服务端拒——这是最容易写错的一处。"""
        raw = proto.encode(proto.Event.START_CONNECTION, payload={})
        assert DOC_SESSION_ID.encode() not in raw
        assert len(raw) == 14  # header 4 + event 4 + size 4 + "{}"

    def test_session_events_without_a_session_id_are_refused_early(self) -> None:
        """宁可在本地炸，也别发出去让服务端默默断开。"""
        with pytest.raises(ValueError, match="会话类"):
            proto.encode(proto.Event.TASK_REQUEST, payload=b"\x00\x00")

    def test_audio_frames_switch_message_type_and_serialization(self) -> None:
        raw = proto.encode(proto.Event.TASK_REQUEST, payload=tone(320), session_id="s")
        assert raw[1] >> 4 == proto.MsgType.AUDIO_CLIENT
        assert raw[2] >> 4 == proto.SERIAL_RAW

    def test_roundtrip_preserves_payload_and_session(self) -> None:
        raw = proto.encode(
            proto.Event.CHAT_TEXT_QUERY, payload={"content": "你好"}, session_id="abc"
        )
        frame = proto.decode(raw)
        assert frame.event is proto.Event.CHAT_TEXT_QUERY
        assert frame.session_id == "abc"
        assert frame.json_payload == {"content": "你好"}

    def test_unknown_event_ids_survive_instead_of_crashing(self) -> None:
        """服务端加新事件时不能把整条流带崩。"""
        raw = bytearray(proto.encode(proto.Event.START_CONNECTION, payload={}))
        raw[4:8] = (9999).to_bytes(4, "big")
        assert proto.decode(bytes(raw)).event == 9999


class TestEventTranslation:
    def test_tts_response_becomes_audio_with_the_downlink_sample_rate(self) -> None:
        """下行是 24k 不是 16k。按 16k 播会又慢又闷（契约 v0.1.9 加 sample_rate 的原因）。"""
        frame = proto.Frame(
            msg_type=proto.MsgType.AUDIO_SERVER,
            event=proto.Event.TTS_RESPONSE,
            payload=tone(480),
        )
        (event,) = dr._translate(frame)
        assert event.type == "audio"
        assert event.sample_rate == 24000
        assert 0.0 < (event.rms or 0) <= 1.0

    def test_asr_info_becomes_an_interrupt(self) -> None:
        """听到用户首字就该停播。能打断是这条链路相对级联的主要优势。"""
        frame = proto.Frame(msg_type=proto.MsgType.FULL_SERVER, event=proto.Event.ASR_INFO)
        (event,) = dr._translate(frame)
        assert event.type == "interrupt"

    def test_asr_response_splits_into_user_transcripts_with_final_flag(self) -> None:
        frame = proto.Frame(
            msg_type=proto.MsgType.FULL_SERVER,
            event=proto.Event.ASR_RESPONSE,
            json_payload={
                "results": [
                    {"text": "我住在", "is_interim": True},
                    {"text": "我住在深圳", "is_interim": False},
                ]
            },
        )
        events = dr._translate(frame)
        assert [(e.role, e.text, e.final) for e in events] == [
            ("user", "我住在", False),
            ("user", "我住在深圳", True),
        ]

    def test_chat_response_becomes_an_assistant_transcript(self) -> None:
        frame = proto.Frame(
            msg_type=proto.MsgType.FULL_SERVER,
            event=proto.Event.CHAT_RESPONSE,
            json_payload={"content": "你好呀"},
        )
        (event,) = dr._translate(frame)
        assert (event.type, event.role, event.text) == ("transcript", "assistant", "你好呀")

    def test_tts_ended_becomes_turn_end(self) -> None:
        frame = proto.Frame(msg_type=proto.MsgType.FULL_SERVER, event=proto.Event.TTS_ENDED)
        (event,) = dr._translate(frame)
        assert event.type == "turn_end"

    def test_empty_text_produces_no_event(self) -> None:
        frame = proto.Frame(
            msg_type=proto.MsgType.FULL_SERVER,
            event=proto.Event.CHAT_RESPONSE,
            json_payload={"content": ""},
        )
        assert dr._translate(frame) == []

    @pytest.mark.parametrize(
        ("payload", "keyword"),
        [
            ({"message": "ClientError:InvalidSpeaker"}, "音色"),
            ({"message": "StartSession event payload asr extra is null"}, "extra"),
            ({"message": "45000003 Abnormal silence audio"}, "10 分钟"),
        ],
    )
    def test_errors_carry_a_hint_matched_to_the_cause(self, payload: dict, keyword: str) -> None:
        frame = proto.Frame(
            msg_type=proto.MsgType.FULL_SERVER,
            event=proto.Event.DIALOG_ERROR,
            json_payload=payload,
        )
        with pytest.raises(base.UpstreamError) as excinfo:
            dr._translate(frame)
        assert keyword in excinfo.value.hint


class TestSessionConfig:
    def test_asks_for_16_bit_pcm_not_the_default_opus(self) -> None:
        """默认下行是 OGG/Opus；不显式要 `pcm_s16le` 就得自己解码。
        写成 `pcm` 会拿到 32 位浮点，塞进 AudioChunk 是错的。"""
        cfg = dr.DoubaoRealtime("1", "t")._session_config("", dr.DEFAULT_SPEAKER)
        assert cfg["tts"]["audio_config"]["format"] == "pcm_s16le"
        assert cfg["tts"]["audio_config"]["sample_rate"] == 24000

    def test_uplink_is_16k_downlink_is_24k(self) -> None:
        cfg = dr.DoubaoRealtime("1", "t")._session_config("", dr.DEFAULT_SPEAKER)
        assert cfg["asr"]["audio_info"]["sample_rate"] == 16000
        assert cfg["tts"]["audio_config"]["sample_rate"] == 24000

    def test_extra_objects_are_never_null(self) -> None:
        """`asr.extra` 或 `tts.extra` 为 null 时服务端报 42000020。"""
        cfg = dr.DoubaoRealtime("1", "t")._session_config("", dr.DEFAULT_SPEAKER)
        assert isinstance(cfg["asr"]["extra"], dict)
        assert isinstance(cfg["tts"]["extra"], dict)

    def test_system_prompt_goes_into_system_role(self) -> None:
        """人格与召回都从这里进模型（AD-2、AD-13）。"""
        cfg = dr.DoubaoRealtime("1", "t")._session_config("你叫丘丘", dr.DEFAULT_SPEAKER)
        assert cfg["dialog"]["system_role"] == "你叫丘丘"


class TestConfig:
    def test_missing_credentials_refuse_with_a_hint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("VOLC_SPEECH_APPID", raising=False)
        monkeypatch.delenv("VOLC_SPEECH_TOKEN", raising=False)
        with pytest.raises(base.ProviderNotConfiguredError) as excinfo:
            dr.from_env()
        assert "VOLC_SPEECH_APPID" in excinfo.value.hint
        assert "cascade" in excinfo.value.hint

    def test_model_and_speaker_are_overridable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("VOLC_SPEECH_APPID", "1")
        monkeypatch.setenv("VOLC_SPEECH_TOKEN", "t")
        monkeypatch.setenv("DOUBAO_REALTIME_MODEL", "2.2.0.0")
        monkeypatch.setenv("DOUBAO_REALTIME_SPEAKER", "saturn_zh_female_keainvsheng_tob")
        rt = dr.from_env()
        assert (rt.model, rt.speaker) == ("2.2.0.0", "saturn_zh_female_keainvsheng_tob")
