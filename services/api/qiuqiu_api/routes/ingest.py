"""`POST /ingest`：被动采集入口。返回 `trace_id` 与筛选决策。

两条来源，处理方式不同（AD-15：描述与转写由后端做，中间件只收文本与 `blob_id`）：

- `ambient_image`：读 blob → `VisionModel.describe()` → `ingest(source=AMBIENT_IMAGE)`。
  Vision 失败按 ARCHITECTURE § 3 返回带 hint 的错误，**不静默跳过**
- `ambient_audio`：读 blob → `VAD.evaluate()` → 有语音才 `ASR.transcribe()` →
  `ingest(source=AMBIENT_AUDIO)`。VAD 判无语音就到此为止，decision 记 `reject`，
  并经 `facade.note_filter()` 让中间件代发一条 `filter` 事件（契约 v0.1.8 § 3）

VAD / ASR 这一轮还没接真实实现（M5）。缺失时按 AD-16 返回带 hint 的 503，**不换 mock**——
`MODELS_MOCK=1` 是唯一的 mock 入口。筛选是中间件的活（AD-3），后端不做预筛。
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..deps import StateDep
from ..errors import ApiError, NotFound
from ..orchestrator import describe_image
from ..state import AppState, new_trace_id

router = APIRouter(tags=["ingest"])
log = structlog.get_logger("qiuqiu_api.ingest")

#: VAD 判定无语音时的固定理由，写进响应体让前端能解释「为什么没记」
NO_SPEECH_REASON = "VAD 判定这一段没有人声"


class IngestIn(BaseModel):
    source: Literal["ambient_audio", "ambient_image"]
    blob_id: str = Field(min_length=1)
    captured_at: dt.datetime | None = None


@router.post("/ingest")
async def ingest(body: IngestIn, state: StateDep) -> dict[str, Any]:
    from qiuqiu_memory import Source
    from qiuqiu_models import metrics

    trace_id = new_trace_id()
    moment = body.captured_at or dt.datetime.now(dt.UTC)

    with metrics.use_trace_id(trace_id):
        if body.source == "ambient_image":
            text = await _image_text(state, body.blob_id)
        else:
            text = await _audio_text(state, body.blob_id)

        if text is None:
            # VAD 拦下的片段进不到中间件，所以中间件不会发 filter 事件。把这条判断
            # 报上去让它代发一条（契约 v0.1.8 § 3 `note_filter`）——ambient-noise
            # 那个演示要看的正是这些拒绝，侧栏空着等于演示白做。
            event_id = state.facade.note_filter(
                decision="reject",
                score=0.0,
                reason=NO_SPEECH_REASON,
                source=Source(body.source),
                input_preview=f"[音频片段 {body.blob_id}]",
                trace_id=trace_id,
            )
            log.info("ingest.no_speech", trace_id=trace_id, blob_id=body.blob_id, event_id=event_id)
            return {"trace_id": trace_id, "decision": "reject", "reason": NO_SPEECH_REASON}

        result = await state.off_loop(
            state.facade.ingest,
            text,
            source=Source(body.source),
            # 被动采集的说话人未知，一律 `ambient`，**不能记成 `user`**
            # （契约 v0.1.8 § 5：multi-person 演示里客厅有三个人）
            speaker="ambient",
            ts=moment,
            blob_id=body.blob_id,
            trace_id=trace_id,
        )

    log.info("ingest.done", trace_id=result.trace_id, decision=result.decision, source=body.source)
    return {"trace_id": result.trace_id, "decision": result.decision}


async def _blob(state: AppState, blob_id: str) -> bytes:
    try:
        return await state.off_loop(state.blobs.get, blob_id)
    except (FileNotFoundError, ValueError) as exc:
        raise NotFound(
            f"blob {blob_id} 读不到：{exc}",
            hint="先 POST /blobs 上传拿到 blob_id，再用那个 id 调 /ingest。",
            code="blob.not_found",
        ) from exc


async def _image_text(state: AppState, blob_id: str) -> str:
    await _blob(state, blob_id)  # 先确认文件在，缺文件的错比模型错更好解释
    try:
        described = await describe_image(state, blob_id)
    except ApiError:
        raise
    except Exception as exc:  # noqa: BLE001 - 出网失败统一成带 hint 的错（AD-16）
        raise ApiError(
            f"这张图没看懂：{exc}",
            hint="检查 DEEPSEEK_API_KEY 与网络；离线开发设 MODELS_MOCK=1。",
            code="vision.failed",
            status=502,
        ) from exc
    if not described:
        raise ApiError(
            "Vision 没给出描述。",
            hint="换一张图再试；若持续如此，检查 DEEPSEEK_VISION_MODEL 配置。",
            code="vision.empty",
            status=502,
        )
    return described


async def _audio_text(state: AppState, blob_id: str) -> str | None:
    """VAD → ASR。无语音返回 `None`；能力缺失时 `state.capability` 抛带 hint 的 503。"""
    pcm = await _blob(state, blob_id)
    vad = state.capability("vad")
    verdict = await state.off_loop(vad.evaluate, pcm)
    if not verdict.has_speech:
        return None
    asr = state.capability("asr")
    transcript = await state.off_loop(asr.transcribe, pcm)
    text = str(getattr(transcript, "text", "") or "").strip()
    return text or None
