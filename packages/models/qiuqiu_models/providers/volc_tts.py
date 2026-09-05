"""TTS · 豆包语音合成大模型 2.0。官方接口，可用于产品。

走 v3 的单向流式 HTTP 接口，响应是一行一个 JSON、`data` 字段是 base64 PCM，
边收边解、边解边给出 `AudioChunk`，首字不用等整段合成完。

**接口版本别搞混**：2.0 是 `/api/v3/tts/unidirectional`，头里带 `X-Api-Resource-Id:
seed-tts-2.0`；1.0 那套 `/api/v1/tts` 加 `cluster` 参数在这里一律 403。

配置：

- `VOLC_SPEECH_APPID` —— 豆包语音控制台的 APP ID
- `VOLC_SPEECH_TOKEN` —— 同一页的 Access Token
- `VOLC_TTS_SPEAKER` —— 音色 ID，缺省见 `DEFAULT_SPEAKER`

鉴权用旧版控制台那套（`X-Api-App-Key` + `X-Api-Access-Key`）。方舟的 ark key 在这个
接口上不认，两套凭证各管各的。

计费按字符，试用额度 2 万字符；额度用完前不会自动转后付费。
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from collections.abc import AsyncIterator

import httpx

from ..base import AudioChunk, ProviderNotConfiguredError, UpstreamError
from ..metrics import measure
from . import _audio

ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
RESOURCE_ID = "seed-tts-2.0"
DEFAULT_SPEAKER = "zh_female_gaolengyujie_uranus_bigtts"
SAMPLE_RATE = 16000
TIMEOUT_S = 60.0


class VolcTTS:
    """`TTS` 协议的豆包语音实现。"""

    provider = "volcengine"

    def __init__(self, appid: str, token: str, *, speaker: str = DEFAULT_SPEAKER) -> None:
        self.appid = appid
        self.token = token
        self.speaker = speaker

    async def synthesize(self, text: str, *, voice: str | None = None) -> AsyncIterator[AudioChunk]:
        body = {
            "user": {"uid": "qiuqiu"},
            "req_params": {
                "text": text,
                "speaker": voice or self.speaker,
                "audio_params": {"format": "pcm", "sample_rate": SAMPLE_RATE},
            },
        }
        headers = {
            "X-Api-App-Key": self.appid,
            "X-Api-Access-Key": self.token,
            "X-Api-Resource-Id": RESOURCE_ID,
            "X-Api-Connect-Id": str(uuid.uuid4()),
            "Content-Type": "application/json",
        }

        async def _pcm() -> AsyncIterator[bytes]:
            async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
                async with client.stream("POST", ENDPOINT, json=body, headers=headers) as response:
                    if response.status_code >= 400:
                        raw = (await response.aread()).decode("utf-8", "replace")[:200]
                        raise _upstream(response.status_code, raw)
                    async for line in response.aiter_lines():
                        chunk = _decode_line(line)
                        if chunk:
                            yield chunk

        async def _gen() -> AsyncIterator[AudioChunk]:
            with measure(stage="tts.synthesize", provider=self.provider) as m:
                m.usage(len(text), None)
                async for pcm, rms in _audio.chunks_from(_pcm(), sample_rate=SAMPLE_RATE):
                    yield AudioChunk(pcm=pcm, rms=rms, sample_rate=SAMPLE_RATE)

        return _gen()


def _decode_line(line: str) -> bytes | None:
    """一行响应 → PCM。非 JSON 行、无 `data` 的行（事件行）都跳过。"""
    line = line.strip()
    if not line:
        return None
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    if code not in (None, 0):
        raise UpstreamError(
            f"豆包语音合成返回错误码 {code}：{payload.get('message', '')}",
            hint="音色 ID 不存在，或试用额度已用完（控制台 > 豆包语音合成模型2.0 看余量）。",
            provider="volcengine",
        )
    data = payload.get("data")
    return base64.b64decode(data) if data else None


def _upstream(status: int, body: str) -> UpstreamError:
    if status in (401, 403):
        hint = (
            "VOLC_SPEECH_APPID 或 VOLC_SPEECH_TOKEN 不对。注意这两个来自豆包语音控制台，"
            "不是方舟的 ark key，两套凭证不通用。"
        )
    elif status == 429:
        hint = "超出并发或额度限制。试用版并发 10，字符额度在控制台可查。"
    else:
        hint = "确认走的是 v3 的 /tts/unidirectional 且头里带 X-Api-Resource-Id: seed-tts-2.0。"
    return UpstreamError(
        f"豆包语音合成失败（HTTP {status}）：{body}", hint=hint, provider="volcengine"
    )


def from_env() -> VolcTTS:
    appid = os.getenv("VOLC_SPEECH_APPID", "").strip()
    token = os.getenv("VOLC_SPEECH_TOKEN", "").strip()
    if not appid or not token:
        raise ProviderNotConfiguredError(
            "豆包语音合成没配好：缺少 VOLC_SPEECH_APPID 或 VOLC_SPEECH_TOKEN。",
            hint=(
                "火山引擎「豆包语音」控制台建一个应用，勾上「豆包语音合成模型2.0 字符版」，"
                "在服务详情页复制 APP ID 填 VOLC_SPEECH_APPID、Access Token 填 VOLC_SPEECH_TOKEN。"
                "想改用 Azure 就设 TTS_PROVIDER=azure，再填 AZURE_SPEECH_KEY 与 "
                "AZURE_SPEECH_REGION。"
            ),
            capability="tts",
            provider="volcengine",
        )
    return VolcTTS(appid, token, speaker=os.getenv("VOLC_TTS_SPEAKER", DEFAULT_SPEAKER))
