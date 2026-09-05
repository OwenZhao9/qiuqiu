"""记忆层的错误。全部带 ``hint``，`to_dict()` 直接就是 CONTRACTS § 1 的错误体。

约定与 ``qiuqiu_models`` 一致：``{ code, message, hint }``，``hint`` 必填，说明下一步能做什么。
本层不抛裸 ``Exception``；模型层的异常（``qiuqiu_models.ModelError``）原样往上冒，
它自己已经带 ``hint``。
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "ContractError",
    "EmbeddingUnavailableError",
    "MemoryError_",
    "UnknownVisibleMemoryError",
]


class MemoryError_(Exception):
    """记忆层异常基类。名字带下划线，避开内置的 ``MemoryError``。"""

    code = "memory_error"

    def __init__(self, message: str, *, hint: str, **extra: Any) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.extra = extra

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
        }
        body.update(self.extra)
        return body


class EmbeddingUnavailableError(MemoryError_):
    """嵌入模型加载不出来：缺依赖、缺权重、或者下载被墙。"""

    code = "embedding_unavailable"


class UnknownVisibleMemoryError(MemoryError_):
    """``edit_visible`` 给的 id 在 ``visible_memory`` 里不存在。"""

    code = "visible_memory_not_found"


class ContractError(MemoryError_):
    """调用方传了契约不允许的取值。"""

    code = "contract_violation"
