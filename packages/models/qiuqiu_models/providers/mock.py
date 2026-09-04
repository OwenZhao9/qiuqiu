"""六种能力的 mock 实现。固定输出、零延迟、不出网。

只在 ``MODELS_MOCK=1`` 时由注册表全量返回（AD-16），运行时任何出网失败都不会
偷偷换成这里的实现。mock 同样记 ``run_metrics``，``provider`` 字段固定为 ``"mock"``。
"""

from __future__ import annotations

import math
import struct
from collections.abc import AsyncIterator, Iterable, Iterator

from ..base import (
    AudioChunk,
    Message,
    PartialTranscript,
    RealtimeEvent,
    Transcript,
    VadResult,
)
from ..metrics import measure

PROVIDER = "mock"

#: ChatModel 的固定回复，逐字 yield。
MOCK_REPLY = "我是丘丘的 mock 回复，用来离线跑通链路。"

#: VisionModel 的固定描述。
MOCK_DESCRIPTION = "这是一张 mock 图片：画面里有一只圆圆的丘丘，背景是浅色的桌面。"

#: ASR 的固定转写。
MOCK_TRANSCRIPT_TEXT = "这是一段 mock 转写。"

_MOCK_SAMPLE_RATE = 16000


def _count_tokens(text: str) -> int:
    """粗略 token 估算。mock 不接真实分词器，按字符数算，只为让指标非零。"""

    return len(text)


class MockChatModel:
    """固定回复，``stream()`` 逐字产出。"""

    provider = PROVIDER

    async def stream(
        self, messages: list[Message], *, temperature: float = 0.7
    ) -> AsyncIterator[str]:
        tokens_in = sum(_count_tokens(m.content) for m in messages)

        async def _gen() -> AsyncIterator[str]:
            with measure(stage="chat.stream", provider=PROVIDER) as m:
                m.usage(tokens_in, _count_tokens(MOCK_REPLY))
                for ch in MOCK_REPLY:
                    yield ch

        return _gen()

    async def complete(self, messages: list[Message]) -> str:
        with measure(stage="chat.complete", provider=PROVIDER) as m:
            m.usage(
                sum(_count_tokens(msg.content) for msg in messages),
                _count_tokens(MOCK_REPLY),
            )
            return MOCK_REPLY


class MockVisionModel:
    """固定中文描述，不看图内容。"""

    provider = PROVIDER

    async def describe(self, image: bytes | str, prompt: str) -> str:
        size = len(image) if isinstance(image, bytes) else len(image.encode("utf-8"))
        with measure(stage="vision.describe", provider=PROVIDER) as m:
            m.usage(_count_tokens(prompt) + size // 1024, _count_tokens(MOCK_DESCRIPTION))
            return MOCK_DESCRIPTION


class MockASR:
    """固定转写。``stream()`` 每收一段回一个 partial，末尾补一条 ``final``。"""

    provider = PROVIDER

    def transcribe(self, pcm16k: bytes) -> Transcript:
        with measure(stage="asr.transcribe", provider=PROVIDER) as m:
            m.usage(len(pcm16k) // 2, _count_tokens(MOCK_TRANSCRIPT_TEXT))
            return Transcript(text=MOCK_TRANSCRIPT_TEXT, lang="zh", confidence=1.0)

    def stream(self, chunks: Iterator[bytes]) -> Iterator[PartialTranscript]:
        text = ""
        samples = 0
        for i, chunk in enumerate(chunks):
            samples += len(chunk) // 2
            text = MOCK_TRANSCRIPT_TEXT[: min(len(MOCK_TRANSCRIPT_TEXT), (i + 1) * 3)]
            yield PartialTranscript(text=text, final=False, lang="zh", confidence=0.5)
        with measure(stage="asr.stream", provider=PROVIDER) as m:
            m.usage(samples, _count_tokens(MOCK_TRANSCRIPT_TEXT))
        yield PartialTranscript(text=MOCK_TRANSCRIPT_TEXT, final=True, lang="zh", confidence=1.0)


class MockVAD:
    """按 PCM 能量判断。全静音（全 0）返回 ``has_speech=False``，否则 ``True``。"""

    provider = PROVIDER

    def evaluate(self, pcm16k: bytes) -> VadResult:
        with measure(stage="vad.evaluate", provider=PROVIDER):
            energy = _rms(pcm16k)
            return VadResult(
                has_speech=energy > 0.0,
                energy=energy,
                confidence=1.0 if energy > 0.0 else 0.0,
            )


class MockTTS:
    """按字数产出定长静音 chunk，``rms`` 随字序做一条可预期的起伏曲线。"""

    provider = PROVIDER

    #: 每个字合成多少个 16-bit 采样点（0.1 秒）
    samples_per_char = 1600

    async def synthesize(self, text: str, *, voice: str) -> AsyncIterator[AudioChunk]:
        chars = list(text)

        async def _gen() -> AsyncIterator[AudioChunk]:
            with measure(stage="tts.synthesize", provider=PROVIDER) as m:
                m.usage(_count_tokens(text), len(chars) * self.samples_per_char)
                for i, _ch in enumerate(chars):
                    # 0.2–1.0 之间起伏，非零且随「语音」变化，前端拿它驱动口型
                    rms = 0.6 + 0.4 * math.sin(i * 0.7)
                    rms = max(0.2, min(1.0, rms))
                    amplitude = int(rms * 8000)
                    pcm = struct.pack(
                        f"<{self.samples_per_char}h",
                        *(
                            int(amplitude * math.sin(2 * math.pi * 220 * n / _MOCK_SAMPLE_RATE))
                            for n in range(self.samples_per_char)
                        ),
                    )
                    yield AudioChunk(pcm=pcm, rms=rms, sample_rate=_MOCK_SAMPLE_RATE)

        return _gen()


class MockRealtimeVoice:
    """把输入音频原样回放，并给固定转写。

    一轮的事件顺序：用户转写（final） → 输入音频原样回放（audio） → 助手转写（final） → turn_end。
    """

    provider = PROVIDER

    def __init__(self) -> None:
        self._opened = False
        self._inbox: list[bytes] = []
        self._interrupted = False
        self.system_prompt: str | None = None
        self.voice: str | None = None

    async def open(self, *, system_prompt: str, voice: str) -> None:
        self._opened = True
        self._interrupted = False
        self.system_prompt = system_prompt
        self.voice = voice
        self._inbox.clear()

    async def send(self, pcm16k: bytes) -> None:
        self._inbox.append(pcm16k)

    async def interrupt(self) -> None:
        self._interrupted = True
        self._inbox.clear()

    def events(self) -> AsyncIterator[RealtimeEvent]:
        return self._events()

    async def _events(self) -> AsyncIterator[RealtimeEvent]:
        with measure(stage="realtime.events", provider=PROVIDER) as m:
            audio = b"".join(self._inbox)
            self._inbox.clear()
            m.usage(len(audio) // 2, len(audio) // 2)
            if self._interrupted:
                yield RealtimeEvent(type="turn_end")
                return
            yield RealtimeEvent(
                type="transcript", role="user", text=MOCK_TRANSCRIPT_TEXT, final=True
            )
            if audio:
                yield RealtimeEvent(type="audio", pcm=audio, rms=_rms(audio))
            yield RealtimeEvent(type="transcript", role="assistant", text=MOCK_REPLY, final=True)
            yield RealtimeEvent(type="turn_end")

    async def close(self) -> None:
        self._opened = False
        self._inbox.clear()


def _rms(pcm16: bytes) -> float:
    """16-bit little-endian PCM 的均方根，归一到 0–1。"""

    n = len(pcm16) // 2
    if n == 0:
        return 0.0
    samples: Iterable[int] = struct.unpack(f"<{n}h", pcm16[: n * 2])
    total = sum(s * s for s in samples)
    return min(1.0, math.sqrt(total / n) / 32768.0)
