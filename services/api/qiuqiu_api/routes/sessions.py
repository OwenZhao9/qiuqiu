"""会话与历史。契约 v0.1.8 § 1 收编的两条，只读。

`sessions` 与 `messages` 由后端写（§ 7 数据归属表），写入只经 `/chat`——这里没有
POST 与 PATCH。收编的理由是两个分支同时报了同一条：表归后端管，前端却没有路由读，
刷新一次就把界面上的历史丢光。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from ..deps import StateDep
from ..errors import ApiError

router = APIRouter(tags=["sessions"])


def _session(row: dict[str, Any]) -> dict[str, Any]:
    """一行 `sessions` → 契约 § 1 的 `Session`。键序照契约写。"""
    return {
        "id": row["id"],
        "title": row.get("title") or "",
        "archived": bool(row.get("archived")),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _message(row: dict[str, Any]) -> dict[str, Any]:
    """一行 `messages` → 契约 § 1 的 `Message`。"""
    return {
        "id": str(row["id"]),
        "session_id": row["session_id"],
        "role": row["role"],
        "content": row.get("content") or "",
        "model": row.get("model"),
        "favorite": bool(row.get("favorite")),
        "attachments": list(row.get("attachments_json") or []),
        "created_at": row.get("created_at"),
    }


@router.get("/sessions")
async def list_sessions(
    state: StateDep,
    archived: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict[str, Any]]:
    rows = await state.off_loop(state.sqlite.list_sessions, archived=archived, limit=limit)
    return [_session(r) for r in rows]


@router.get("/sessions/{session_id}/messages")
async def list_messages(
    session_id: str,
    state: StateDep,
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    exists = await state.off_loop(state.sqlite.get_session, session_id)
    if exists is None:
        raise ApiError(
            f"没有这个会话：{session_id}。",
            hint="会话由 POST /chat 自动创建；先发一句话，或用 GET /sessions 看现有的。",
            code="session_not_found",
            status=404,
        )
    rows = await state.off_loop(state.sqlite.list_messages, session_id, limit=limit, offset=offset)
    return [_message(r) for r in rows]
