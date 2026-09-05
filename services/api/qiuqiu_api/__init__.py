"""丘丘 · 后端服务。

对外只有一个入口：`create_app()`。启动走 `python -m qiuqiu_api.main`，
自检走 `python -m qiuqiu_api.main --check`（不监听端口，冒烟脚本用）。

    from qiuqiu_api import create_app
    app = create_app()

全部路由与事件按 `docs/CONTRACTS.md` § 1，契约版本见 `routes/health.py::CONTRACT_VERSION`。
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__", "create_app"]


def __getattr__(name: str):  # noqa: ANN202 - 惰性导出，import qiuqiu_api 时不拉起 FastAPI
    if name == "create_app":
        from .app import create_app

        return create_app
    raise AttributeError(name)
