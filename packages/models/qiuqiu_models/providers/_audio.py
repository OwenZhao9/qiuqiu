"""TTS 供应商共用的音频处理。三家实现都拿到 16k 单声道 PCM，切块与算包络的逻辑一样。

`AudioChunk.rms` 归一到 0–1，前端拿它驱动丘丘的发声脉动（CONTRACTS § 6：是容器级
脉动，不是嘴巴张合——Emotion Ball 的形象没有嘴）。
"""

from __future__ import annotations

import array
import math
from collections.abc import AsyncIterator, Iterable

#: 每块的时长。20ms 是口型动画够用的粒度，再细只是徒增事件数。
CHUNK_MS = 20
SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
#: int16 的满量程，rms 除它归一到 0–1。
FULL_SCALE = 32768.0


def chunk_bytes(sample_rate: int = SAMPLE_RATE, chunk_ms: int = CHUNK_MS) -> int:
    return max(2, (sample_rate * chunk_ms // 1000) * BYTES_PER_SAMPLE)


def rms_of(pcm: bytes) -> float:
    """一块 PCM 的均方根音量，归一到 0–1。

    空块返回 0；奇数字节（半个采样）丢掉尾巴——上游偶尔会在流末尾切出这种。
    """
    usable = len(pcm) - (len(pcm) % BYTES_PER_SAMPLE)
    if usable <= 0:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[:usable])
    total = sum(float(s) * float(s) for s in samples)
    return min(1.0, math.sqrt(total / len(samples)) / FULL_SCALE)


async def chunks_from(
    stream: AsyncIterator[bytes],
    *,
    sample_rate: int = SAMPLE_RATE,
    chunk_ms: int = CHUNK_MS,
) -> AsyncIterator[tuple[bytes, float]]:
    """把上游的任意分片重新切成固定时长的块，逐块给出 `(pcm, rms)`。

    上游按网络包切，块大小忽大忽小，直接透传的话 rms 序列会抖得没法用。
    """
    size = chunk_bytes(sample_rate, chunk_ms)
    buf = bytearray()
    async for part in stream:
        if not part:
            continue
        buf.extend(part)
        while len(buf) >= size:
            block = bytes(buf[:size])
            del buf[:size]
            yield block, rms_of(block)
    if buf:
        tail = bytes(buf)
        yield tail, rms_of(tail)


def chunks_of(
    data: bytes, *, sample_rate: int = SAMPLE_RATE, chunk_ms: int = CHUNK_MS
) -> Iterable[tuple[bytes, float]]:
    """整段 PCM 切块。非流式接口（一次拿到全部音频）用这个。"""
    size = chunk_bytes(sample_rate, chunk_ms)
    for i in range(0, len(data), size):
        block = data[i : i + size]
        yield block, rms_of(block)
