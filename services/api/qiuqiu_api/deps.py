"""路由拿 `AppState` 的唯一途径。

state 挂在 `app.state.qiuqiu` 上，lifespan 建、lifespan 拆。测试里换一份指向临时
`DATA_DIR` 的 state，路由代码一个字都不用改。
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, Request, WebSocket

from .state import AppState

__all__ = ["StateDep", "get_state", "state_from_ws", "state_of"]


def state_of(app: Any) -> AppState:
    return app.state.qiuqiu


def get_state(request: Request) -> AppState:
    return state_of(request.app)


def state_from_ws(websocket: WebSocket) -> AppState:
    return state_of(websocket.app)


StateDep = Annotated[AppState, Depends(get_state)]
