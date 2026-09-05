"""服务入口。

    python -m qiuqiu_api.main            # 起服务，默认 127.0.0.1:8000
    python -m qiuqiu_api.main --check    # 只自检，不监听端口（scripts/smoke.sh 用）

`--check` 做的事：载 `.env` → 建存储（目录、两张 Lance 表、SQLite 迁移）→ 建记忆门面
与人格 → 问一遍注册表每项能力在不在 → 装配一次应用把路由数点出来。全过程不出网：
`MODELS_MOCK=1` 时注册表全返回 mock，没设的话缺 key 也只是报告 `available=false`，
不会真去连供应商。
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .config import Config, load_env

__all__ = ["check", "main"]


def check() -> int:
    """启动自检。0 = 能起来。"""
    load_env()
    from .app import create_app
    from .log_config import configure_logging
    from .routes import API_PATHS
    from .routes.health import CONTRACT_VERSION
    from .state import AppState

    configure_logging()

    report: dict[str, Any] = {"contract": CONTRACT_VERSION}
    state: AppState | None = None
    try:
        config = Config.from_env()
        state = AppState.create(config=config)
        report["data_dir"] = str(state.stores.paths.root)
        report["tables"] = sorted(state.sqlite.table_names())

        from qiuqiu_models import registry

        providers = registry.list_providers()
        report["models"] = {p["capability"]: p["available"] for p in providers}
        report["missing"] = [p["capability"] for p in providers if not p["available"]]

        create_app(state=state, start_scheduler=False)
        report["routes"] = list(API_PATHS)
        report["ok"] = True
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - 自检就是要把任何失败翻成人话
        report["ok"] = False
        report["error"] = str(exc)
        report["hint"] = getattr(
            exc, "hint", "看上面的 error；多半是 .env 没配好或数据目录不可写。"
        )
        print(json.dumps(report, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        if state is not None:
            state.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="qiuqiu-api", description="丘丘后端服务")
    parser.add_argument("--check", action="store_true", help="只做启动自检，不监听端口")
    parser.add_argument("--host", default=None, help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=None, help="监听端口，默认 8000")
    parser.add_argument("--reload", action="store_true", help="改代码自动重启（开发用）")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.check:
        return check()

    load_env()
    import uvicorn

    from .log_config import configure_logging

    configure_logging()

    config = Config.from_env()
    uvicorn.run(
        "qiuqiu_api.app:create_app",
        factory=True,
        host=args.host or config.host,
        port=args.port or config.port,
        reload=args.reload,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
