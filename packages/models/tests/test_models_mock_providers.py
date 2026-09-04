"""六个 mock 的行为，外加「mock 也记 run_metrics」。"""

from __future__ import annotations

import struct

from qiuqiu_models import Message, metrics, registry
from qiuqiu_models.providers.mock import MOCK_REPLY, MOCK_TRANSCRIPT_TEXT

SILENCE = b"\x00\x00" * 1600


def _voice(n: int = 1600) -> bytes:
    return struct.pack(f"<{n}h", *([8000, -8000] * (n // 2)))


# ------------------------------------------------------------------ chat


async def test_mock_chat_streams_character_by_character(
    mock_env: None, sink: metrics.InMemoryMetricsSink
) -> None:
    chat = registry.get("chat")
    deltas = [d async for d in await chat.stream([Message(role="user", content="你好")])]
    assert deltas == list(MOCK_REPLY)
    assert "".join(deltas) == MOCK_REPLY


async def test_mock_chat_stream_records_run_metrics(
    mock_env: None, sink: metrics.InMemoryMetricsSink
) -> None:
    chat = registry.get("chat")
    with metrics.use_trace_id("trc_test_stream"):
        async for _ in await chat.stream([Message(role="user", content="你好呀")]):
            pass

    assert len(sink.records) == 1
    m = sink.records[0]
    assert m.provider == "mock"
    assert m.stage == "chat.stream"
    assert m.trace_id == "trc_test_stream"
    assert m.tokens_in == len("你好呀")
    assert m.tokens_out == len(MOCK_REPLY)
    assert m.latency_ms >= 0
    assert m.ts.endswith("+00:00")
    assert set(m.to_dict()) == {
        "trace_id",
        "stage",
        "tokens_in",
        "tokens_out",
        "latency_ms",
        "ts",
        "provider",
    }


async def test_mock_chat_complete(mock_env: None, sink: metrics.InMemoryMetricsSink) -> None:
    text = await registry.get("chat").complete([Message(role="user", content="嗨")])
    assert text == MOCK_REPLY
    assert [m.stage for m in sink.records] == ["chat.complete"]


# ------------------------------------------------------------------ vision


async def test_mock_vision_describes_in_chinese(
    mock_env: None, sink: metrics.InMemoryMetricsSink
) -> None:
    desc = await registry.get("vision").describe(b"\x89PNG\r\n\x1a\n", "这是什么")
    assert "丘丘" in desc
    assert sink.records[0].provider == "mock"


async def test_mock_vision_accepts_url(mock_env: None) -> None:
    assert await registry.get("vision").describe("https://example.com/a.png", "看看")


# ------------------------------------------------------------------ asr


def test_mock_asr_transcribe(mock_env: None, sink: metrics.InMemoryMetricsSink) -> None:
    t = registry.get("asr").transcribe(_voice())
    assert t.text == MOCK_TRANSCRIPT_TEXT
    assert t.lang == "zh"
    assert t.confidence == 1.0
    assert sink.records[0].stage == "asr.transcribe"


def test_mock_asr_stream_ends_with_final(mock_env: None) -> None:
    parts = list(registry.get("asr").stream(iter([_voice(), _voice()])))
    assert [p.final for p in parts] == [False, False, True]
    assert parts[-1].text == MOCK_TRANSCRIPT_TEXT


# ------------------------------------------------------------------ vad


def test_mock_vad_silence_vs_voice(mock_env: None) -> None:
    vad = registry.get("vad")
    quiet = vad.evaluate(SILENCE)
    loud = vad.evaluate(_voice())
    assert quiet.has_speech is False
    assert quiet.energy == 0.0
    assert loud.has_speech is True
    assert loud.energy > 0.0


# ------------------------------------------------------------------ tts


async def test_mock_tts_chunks_have_non_zero_rms(
    mock_env: None, sink: metrics.InMemoryMetricsSink
) -> None:
    text = "丘丘你好呀"
    chunks = [c async for c in await registry.get("tts").synthesize(text, voice="mock")]
    assert len(chunks) == len(text)
    assert all(c.sample_rate == 16000 for c in chunks)
    assert all(0.0 < c.rms <= 1.0 for c in chunks)
    assert len({round(c.rms, 4) for c in chunks}) > 1  # 有起伏，不是常数
    assert all(len(c.pcm) == 3200 for c in chunks)
    assert sink.records[0].provider == "mock"


# ------------------------------------------------------------------ realtime


async def test_mock_realtime_echoes_audio_and_gives_fixed_transcripts(
    mock_env: None, monkeypatch, sink: metrics.InMemoryMetricsSink
) -> None:
    monkeypatch.setenv("VOICE_MODE", "realtime")
    registry.reset()
    rv = registry.get("realtime")
    await rv.open(system_prompt="你是丘丘", voice="mock")
    await rv.send(_voice())
    await rv.send(_voice())

    events = [e async for e in rv.events()]
    types = [e.type for e in events]
    assert types == ["transcript", "audio", "transcript", "turn_end"]
    assert events[0].role == "user"
    assert events[1].pcm == _voice() * 2  # 原样回放
    assert events[1].rms > 0
    assert events[2].role == "assistant"
    assert events[2].text == MOCK_REPLY
    assert sink.records[0].provider == "mock"
    await rv.close()


async def test_mock_realtime_interrupt_clears_the_queue(mock_env: None, monkeypatch) -> None:
    monkeypatch.setenv("VOICE_MODE", "realtime")
    registry.reset()
    rv = registry.get("realtime")
    await rv.open(system_prompt="你是丘丘", voice="mock")
    await rv.send(_voice())
    await rv.interrupt()
    assert [e.type async for e in rv.events()] == ["turn_end"]
    await rv.close()
