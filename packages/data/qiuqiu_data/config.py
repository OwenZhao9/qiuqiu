"""数据目录与路径解析。

`DATA_DIR` 从进程环境或仓库根的 `.env` 读，缺省 `./data`；目录不存在就建。
本模块不 import lancedb / sqlite3 之外的重物，供其它模块无副作用地引用。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

DEFAULT_DATA_DIR = "./data"
"""`.env` 里没写 `DATA_DIR` 时的缺省值，与 `.env.example` 保持一致。"""

BLOB_KINDS: tuple[str, ...] = ("image", "text", "audio")
"""磁盘文件的三类：原图、原文、音频。"""

LANCE_DIRNAME = "lance"
SQLITE_FILENAME = "qiuqiu.db"
BLOBS_DIRNAME = "blobs"

_env_loaded = False


def _load_env() -> None:
    """只加载一次 `.env`，从当前工作目录逐级往上找；找不到就跳过。

    `usecwd=True` 是必须的：默认行为是从**调用方文件**往上找，包被装进
    site-packages 之后那条路径上不会有 `.env`。
    已经在进程环境里的变量优先，`.env` 不覆盖。
    """
    global _env_loaded
    if not _env_loaded:
        found = find_dotenv(usecwd=True)
        if found:
            load_dotenv(found)
        _env_loaded = True


def data_dir(override: str | os.PathLike[str] | None = None) -> Path:
    """返回数据根目录并保证它存在。

    `override` 优先（测试用临时目录走这里），其次环境变量 `DATA_DIR`，最后缺省值。
    """
    if override is not None:
        root = Path(override)
    else:
        _load_env()
        root = Path(os.environ.get("DATA_DIR") or DEFAULT_DATA_DIR)
    root = root.expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


@dataclass(frozen=True)
class DataPaths:
    """一次算清所有子路径，避免各模块各拼各的。"""

    root: Path
    lance: Path
    sqlite: Path
    blobs: Path

    def ensure(self) -> DataPaths:
        """建出所有目录（sqlite 是文件，只建它的父目录）。"""
        self.root.mkdir(parents=True, exist_ok=True)
        self.lance.mkdir(parents=True, exist_ok=True)
        self.sqlite.parent.mkdir(parents=True, exist_ok=True)
        self.blobs.mkdir(parents=True, exist_ok=True)
        for kind in BLOB_KINDS:
            (self.blobs / kind).mkdir(parents=True, exist_ok=True)
        return self


def paths(override: str | os.PathLike[str] | None = None) -> DataPaths:
    """解析出 `DataPaths` 并建好目录。"""
    root = data_dir(override)
    return DataPaths(
        root=root,
        lance=root / LANCE_DIRNAME,
        sqlite=root / SQLITE_FILENAME,
        blobs=root / BLOBS_DIRNAME,
    ).ensure()
