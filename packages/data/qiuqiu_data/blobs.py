"""磁盘文件：原图、原文、音频。冷存储里只存指针（`facts.blob_id`）。

落盘位置 `data/blobs/{kind}/{id}`，`id` 是内容的 sha256 十六进制串。
对外的 `blob_id` 是 `"{kind}/{sha256}"`——自带 kind，`get` 与 `path` 不必再问一遍
是哪一类，拼出来的相对路径又正好等于磁盘布局。

内容寻址带来一个顺手的性质：同样的字节重复 `put` 得到同一个 `blob_id`，不重复占盘。
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from .config import BLOB_KINDS, paths

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class BlobStore:
    """一个实例对应一个 `data/blobs/` 目录。"""

    kinds: tuple[str, ...] = BLOB_KINDS

    def __init__(
        self,
        data_dir: str | os.PathLike[str] | None = None,
        *,
        root: str | os.PathLike[str] | None = None,
    ) -> None:
        self.root = Path(root) if root is not None else paths(data_dir).blobs
        self.init()

    def init(self) -> None:
        """建出 `blobs/` 与三个 kind 子目录。重复调用无副作用。"""
        self.root.mkdir(parents=True, exist_ok=True)
        for kind in self.kinds:
            (self.root / kind).mkdir(parents=True, exist_ok=True)

    # ---------- 内部 ----------

    def _check_kind(self, kind: str) -> str:
        if kind not in self.kinds:
            raise ValueError(f"未知的 blob 类别：{kind!r}，只能是 {list(self.kinds)}")
        return kind

    def _split(self, blob_id: str) -> tuple[str, str]:
        kind, _, digest = blob_id.partition("/")
        # 校验两段都合法，顺带挡掉 ../ 之类的路径穿越
        self._check_kind(kind)
        if not _SHA256_RE.match(digest):
            raise ValueError(f"blob_id 格式应为 '<kind>/<sha256>'，收到 {blob_id!r}")
        return kind, digest

    # ---------- 读写 ----------

    def put(self, data: bytes, kind: str) -> str:
        """写入一份字节，返回 `blob_id`。同样的内容重复写是同一个 id。"""
        if not isinstance(data, bytes | bytearray):
            raise TypeError(f"blob 只收 bytes，收到 {type(data).__name__}")
        self._check_kind(kind)
        digest = hashlib.sha256(data).hexdigest()
        blob_id = f"{kind}/{digest}"
        target = self.root / kind / digest
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            # 先写临时文件再 rename，避免读到写了一半的文件
            tmp = target.with_name(f".{digest}.tmp")
            tmp.write_bytes(bytes(data))
            os.replace(tmp, target)
        return blob_id

    def path(self, blob_id: str) -> Path:
        """`blob_id` 对应的磁盘路径。文件不一定存在。"""
        kind, digest = self._split(blob_id)
        return self.root / kind / digest

    def get(self, blob_id: str) -> bytes:
        """读回字节。不存在抛 `FileNotFoundError`。"""
        return self.path(blob_id).read_bytes()

    def exists(self, blob_id: str) -> bool:
        return self.path(blob_id).is_file()

    def size(self, blob_id: str) -> int:
        return self.path(blob_id).stat().st_size
