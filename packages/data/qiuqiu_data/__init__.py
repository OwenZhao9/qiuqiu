"""丘丘存储层：LanceDB 事实表、SQLite 八表、磁盘 blob。

对外四个模块，接口见 ARCHITECTURE § 5 的 data 一节：

- `qiuqiu_data.lance`：`upsert / get / query_vector / query_fts / query_scalar / mark_superseded`
- `qiuqiu_data.sqlite`：八张表的读写与迁移
- `qiuqiu_data.tiering`：`promote / demote_stale / nightly`
- `qiuqiu_data.blobs`：`put / get / path`

`init()` 一次调用把目录、表、索引、迁移全部建好，可重复执行。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .config import BLOB_KINDS, DataPaths, data_dir, paths

if TYPE_CHECKING:  # 只为类型标注，运行时不拉起 lancedb
    from .blobs import BlobStore
    from .lance import LanceStore
    from .sqlite import SqliteStore

__version__ = "0.1.0"

__all__ = [
    "BLOB_KINDS",
    "DataPaths",
    "Stores",
    "__version__",
    "data_dir",
    "init",
    "paths",
]


@dataclass(frozen=True)
class Stores:
    """`init()` 的返回值：建好的三个 store 与一组路径。"""

    paths: DataPaths
    lance: LanceStore
    sqlite: SqliteStore
    blobs: BlobStore


def init(data_dir: str | os.PathLike[str] | None = None) -> Stores:
    """建目录、建两张 Lance 表与索引、跑 SQLite 迁移、建 blob 目录。

    空目录上跑一次就绪，再跑一次不报错也不改动已有数据。
    lancedb 在这里才 import，`import qiuqiu_data` 本身保持轻量。
    """
    from .blobs import BlobStore
    from .lance import LanceStore
    from .sqlite import SqliteStore

    resolved = paths(data_dir)
    lance = LanceStore(resolved.root)
    lance.init()
    store = SqliteStore(resolved.root)
    store.migrate()
    blobs = BlobStore(resolved.root)
    return Stores(paths=resolved, lance=lance, sqlite=store, blobs=blobs)
