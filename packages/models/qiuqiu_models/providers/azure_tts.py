"""TTS · Azure 语音服务。官方接口，可用于产品。

和 `edge_tts.py` 调的是**同一批音色**——`zh-CN-XiaoxiaoNeural` 本来就是 Azure 的音色名，
Edge 的朗读功能背后就是这个服务。区别只在于这里走官方的 REST 接口、带自己的订阅密钥，
而不是借用 Edge 客户端的通道。声音、韵律、可用音色都不变。

配置：

- `AZURE_SPEECH_KEY` —— Azure 门户里 Speech 资源的密钥（两个任取其一）
- `AZURE_SPEECH_REGION` —— 资源所在区域，如 `eastasia`、`southeastasia`、`westus`
- `AZURE_TTS_VOICE` —— 默认音色，缺省 `zh-CN-XiaoxiaoNeural`

免费档 F0 每月 50 万字符，长期有效；超出按字符计费。

输出格式固定 `raw-16khz-16bit-mono-pcm`——直接就是 `AudioChunk` 要的裸 PCM，
不用解码，也不用引入 ffmpeg。
"""

from __future__ import annotations

import os
import xml.sax.saxutils as saxutils
from collections.abc import AsyncIterator

import httpx

from ..base import AudioChunk, ProviderNotConfiguredError, UpstreamError
from ..metrics import measure
from . import _audio

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
OUTPUT_FORMAT = "raw-16khz-16bit-mono-pcm"
SAMPLE_RATE = 16000
TIMEOUT_S = 30.0


class AzureTTS:
    """`TTS` 协议的 Azure 实现。"""

    provider = "azure"

    def __init__(self, key: str, region: str, *, voice: str = DEFAULT_VOICE) -> None:
        self.key = key
        self.region = region
        self.voice = voice
        self.endpoint = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"

    async def synthesize(self, text: str, *, voice: str | None = None) -> AsyncIterator[AudioChunk]:
        payload = ssml(text, voice or self.voice)

        async def _gen() -> AsyncIterator[AudioChunk]:
            with measure(stage="tts.synthesize", provider=self.provider) as m:
                m.usage(len(text), None)
                async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
                    async with client.stream(
                        "POST",
                        self.endpoint,
                        content=payload.encode("utf-8"),
                        headers={
                            "Ocp-Apim-Subscription-Key": self.key,
                            "Content-Type": "application/ssml+xml",
                            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
                            "User-Agent": "qiuqiu",
                        },
                    ) as response:
                        if response.status_code >= 400:
                            body = (await response.aread()).decode("utf-8", "replace")[:200]
                            raise _upstream(response.status_code, body)
                        async for pcm, rms in _audio.chunks_from(
                            response.aiter_bytes(), sample_rate=SAMPLE_RATE
                        ):
                            yield AudioChunk(pcm=pcm, rms=rms, sample_rate=SAMPLE_RATE)

        return _gen()


def ssml(text: str, voice: str) -> str:
    """裹成 SSML。文本要转义——用户说的话里带 `<` 或 `&` 会把请求体弄坏。"""
    lang = "-".join(voice.split("-")[:2]) if voice.count("-") >= 2 else "zh-CN"
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{lang}">'
        f'<voice name="{saxutils.quoteattr(voice)[1:-1]}">{saxutils.escape(text)}</voice>'
        "</speak>"
    )


def _upstream(status: int, body: str) -> UpstreamError:
    if status in (401, 403):
        hint = "AZURE_SPEECH_KEY 不对，或和 AZURE_SPEECH_REGION 不是同一个资源的。"
    elif status == 429:
        hint = "超出配额或频率限制。F0 免费档每月 50 万字符，用完要升到 S0。"
    else:
        hint = "检查 AZURE_SPEECH_REGION 拼写（如 eastasia），以及音色名是否存在。"
    return UpstreamError(
        f"Azure 语音合成失败（HTTP {status}）：{body}", hint=hint, provider="azure"
    )


def from_env() -> AzureTTS:
    key = os.getenv("AZURE_SPEECH_KEY", "").strip()
    region = os.getenv("AZURE_SPEECH_REGION", "").strip()
    if not key or not region:
        raise ProviderNotConfiguredError(
            "Azure 语音合成没配好：缺少 AZURE_SPEECH_KEY 或 AZURE_SPEECH_REGION。",
            hint=(
                "Azure 门户建一个 Speech 资源（定价层选 F0，每月 50 万字符免费），"
                "把密钥填 AZURE_SPEECH_KEY、区域填 AZURE_SPEECH_REGION（如 eastasia）。"
            ),
            capability="tts",
            provider="azure",
        )
    return AzureTTS(key, region, voice=os.getenv("AZURE_TTS_VOICE", DEFAULT_VOICE))
