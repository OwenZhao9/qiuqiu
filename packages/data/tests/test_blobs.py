"""磁盘 blob：三类 kind、内容寻址、路径布局。"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from qiuqiu_data.blobs import BlobStore


@pytest.fixture
def blobs(data_root: Path) -> BlobStore:
    return BlobStore()


def test_kind_dirs_are_created(blobs: BlobStore) -> None:
    assert blobs.kinds == ("image", "text", "audio")
    for kind in blobs.kinds:
        assert (blobs.root / kind).is_dir()


@pytest.mark.parametrize("kind", ["image", "text", "audio"])
def test_put_get_path_roundtrip(blobs: BlobStore, kind: str) -> None:
    payload = f"内容-{kind}".encode()

    blob_id = blobs.put(payload, kind)

    digest = hashlib.sha256(payload).hexdigest()
    assert blob_id == f"{kind}/{digest}"
    assert blobs.get(blob_id) == payload
    assert blobs.path(blob_id) == blobs.root / kind / digest
    assert blobs.path(blob_id).is_file()
    assert blobs.exists(blob_id)
    assert blobs.size(blob_id) == len(payload)


def test_put_is_content_addressed_and_idempotent(blobs: BlobStore) -> None:
    payload = b"\x89PNG same bytes"

    first = blobs.put(payload, "image")
    second = blobs.put(payload, "image")

    assert first == second
    assert len(list((blobs.root / "image").iterdir())) == 1


def test_same_bytes_in_two_kinds_are_two_blobs(blobs: BlobStore) -> None:
    payload = b"same"

    as_text = blobs.put(payload, "text")
    as_audio = blobs.put(payload, "audio")

    assert as_text != as_audio
    assert blobs.get(as_text) == blobs.get(as_audio) == payload


def test_unknown_kind_is_rejected(blobs: BlobStore) -> None:
    with pytest.raises(ValueError, match="未知的 blob 类别"):
        blobs.put(b"x", "video")


def test_non_bytes_is_rejected(blobs: BlobStore) -> None:
    with pytest.raises(TypeError):
        blobs.put("字符串不行", "text")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "bad_id",
    ["text/../../etc/passwd", "text/notasha", "image", "video/" + "a" * 64, "text/" + "A" * 64],
)
def test_malformed_blob_id_is_rejected(blobs: BlobStore, bad_id: str) -> None:
    with pytest.raises(ValueError):
        blobs.path(bad_id)


def test_missing_blob_raises(blobs: BlobStore) -> None:
    missing = "text/" + "0" * 64

    assert blobs.exists(missing) is False
    with pytest.raises(FileNotFoundError):
        blobs.get(missing)


def test_no_temp_files_left_behind(blobs: BlobStore) -> None:
    blobs.put(b"abc", "text")

    leftovers = [p.name for p in (blobs.root / "text").iterdir() if p.name.startswith(".")]
    assert leftovers == []
