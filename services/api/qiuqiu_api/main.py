"""服务入口。骨架占位，由 backend 分支实现真正的 FastAPI 应用。

``--check`` 只做启动自检（导入、配置、依赖可达），不监听端口，供 scripts/smoke.sh 用。
"""

from __future__ import annotations

import sys


def check() -> int:
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--check" in argv:
        return check()
    print("骨架占位，尚未实现服务启动；用 --check 做自检", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
