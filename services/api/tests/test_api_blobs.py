"""`POST /blobs`。"""

from __future__ import annotations

from starlette.testclient import TestClient


def upload(client: TestClient, name: str, data: bytes, mime: str, **form: str) -> dict:
    return client.post("/blobs", files={"file": (name, data, mime)}, data=form).json()


def test_upload_returns_content_addressed_id(client: TestClient) -> None:
    body = upload(client, "a.png", b"pretend png", "image/png")
    assert body["kind"] == "image"
    assert body["blob_id"].startswith("image/")
    assert body["bytes"] == len(b"pretend png")


def test_same_bytes_give_the_same_id(client: TestClient) -> None:
    first = upload(client, "a.wav", b"same bytes", "audio/wav")["blob_id"]
    second = upload(client, "b.wav", b"same bytes", "audio/wav")["blob_id"]
    assert first == second


def test_kind_falls_back_to_extension(client: TestClient) -> None:
    body = upload(client, "clip.wav", b"riff", "application/octet-stream")
    assert body["kind"] == "audio"


def test_explicit_kind_wins(client: TestClient) -> None:
    body = upload(client, "note.bin", b"hello", "application/octet-stream", kind="text")
    assert body["kind"] == "text"


def test_bad_kind_has_hint(client: TestClient) -> None:
    response = client.post(
        "/blobs",
        files={"file": ("x.bin", b"1", "application/octet-stream")},
        data={"kind": "video"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["hint"]


def test_empty_file_has_hint(client: TestClient) -> None:
    response = client.post("/blobs", files={"file": ("x.txt", b"", "text/plain")})
    assert response.status_code == 400
    assert response.json()["error"]["hint"]


def test_blob_is_readable_by_the_store(client: TestClient, state) -> None:
    blob_id = upload(client, "a.txt", b"content", "text/plain")["blob_id"]
    assert state.blobs.get(blob_id) == b"content"
