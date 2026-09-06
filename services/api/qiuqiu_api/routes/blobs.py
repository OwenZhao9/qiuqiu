"""`POST /blobs`：multipart 上传，返回 `blob_id`。

`data/blobs/` 的写入方是 backend（ARCHITECTURE § 7 数据归属表），所以这条路由直接调
`qiuqiu_data.blobs`，不经记忆门面。blob 内容寻址（`{kind}/{sha256}`），同一份字节
重复传是同一个 id，前端重传不会撑爆磁盘。

`kind` 契约里没写，这里按 `Content-Type` 猜，猜不出来用表单字段 `kind` 覆盖。
"""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response

from ..deps import StateDep
from ..errors import BadRequest, NotFound

router = APIRouter(tags=["blobs"])
log = structlog.get_logger("qiuqiu_api.blobs")

KINDS = ("image", "text", "audio")
MAX_BYTES = 32 * 1024 * 1024
"""单份上传上限。3 秒音频片段与截图都远小于它，超了多半是传错了东西。"""


def kind_of(content_type: str | None, filename: str | None) -> str:
    mime = (content_type or "").split(";")[0].strip().lower()
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("audio/") or mime in {"application/octet-stream+pcm"}:
        return "audio"
    if mime.startswith("text/") or mime in {"application/json"}:
        return "text"
    suffix = (filename or "").rsplit(".", 1)[-1].lower()
    if suffix in {"png", "jpg", "jpeg", "webp", "gif", "bmp"}:
        return "image"
    if suffix in {"wav", "pcm", "mp3", "m4a", "ogg", "flac"}:
        return "audio"
    return "text"


@router.post("/blobs")
async def upload_blob(
    state: StateDep,
    file: Annotated[UploadFile, File()],
    kind: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    resolved = (kind or kind_of(file.content_type, file.filename)).strip().lower()
    if resolved not in KINDS:
        raise BadRequest(
            f"不认识的 blob 类别 {resolved!r}。",
            hint="kind 只能是：" + "、".join(KINDS) + "。",
            code="blob.bad_kind",
        )
    data = await file.read()
    if not data:
        raise BadRequest(
            "上传的文件是空的。",
            hint="确认前端确实把 File / Blob 塞进了 multipart 的 file 字段。",
            code="blob.empty",
        )
    if len(data) > MAX_BYTES:
        raise BadRequest(
            f"文件 {len(data)} 字节，超过上限 {MAX_BYTES}。",
            hint="被动采集按 3 秒切片上传，图片先压一下再传。",
            code="blob.too_large",
        )
    blob_id = await state.off_loop(state.blobs.put, data, resolved)
    log.info("blob.stored", blob_id=blob_id, kind=resolved, bytes=len(data))
    return {"blob_id": blob_id, "kind": resolved, "bytes": len(data)}


#: 读回去的时候按内容前几个字节认类型。存的时候没记 MIME，也没必要为这个加一张表
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"RIFF", "image/webp"),
)


def _mime(kind: str, data: bytes) -> str:
    if kind == "image":
        for magic, mime in _MAGIC:
            if data.startswith(magic):
                return mime
        return "image/png"
    if kind == "audio":
        return "audio/wav"
    return "text/plain; charset=utf-8"


@router.get("/blobs/{kind}/{digest}")
async def read_blob(state: StateDep, kind: str, digest: str) -> Response:
    """把上传过的字节读回来。

    聊天记录里那张图靠它显示。上传时前端手上有 `File`，能 `createObjectURL`
    临时看一眼，但那个 URL 活不过刷新——重开窗口整条消息就只剩「带了 1 张图」。
    内容寻址意味着这里可以放心长缓存：同一个 `blob_id` 的字节永远是同一份。
    """
    blob_id = f"{kind}/{digest}"
    try:
        data = await state.off_loop(state.blobs.get, blob_id)
    except (FileNotFoundError, ValueError) as exc:
        raise NotFound(
            f"没有这份内容：{blob_id}",
            hint="blob_id 形如 image/<sha256>，且必须先上传过。",
            code="blob.not_found",
        ) from exc
    return Response(
        content=data,
        media_type=_mime(kind, data),
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
