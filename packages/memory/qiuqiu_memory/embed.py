"""嵌入：把文本变成 1024 维向量，喂 LanceDB 的语义路。

对外只有一个函数：``embed(texts) -> list[list[float]]``，1024 维、L2 归一化。
``embed_one(text)`` 是它的单条包装。

**维度是破坏性契约**（CONTRACTS § 5）：``EMBED_DIM`` 必须等于
``qiuqiu_data.lance.VECTOR_DIM``，改它要重建冷热两张表并升契约主版本。有一条测试盯着
这两个常量相等。

两个 provider，由环境变量 ``EMBEDDING_PROVIDER`` 选：

- 缺省（不设，或设成 ``hash``）：``HashEmbedder``。token 哈希投影，确定性、零依赖、
  不出网、不下权重。同一段文本永远得到同一个向量。它不是「随机向量」——同样的 token
  落同一维，所以词面重合的两句话余弦相似度也高，离线链路的语义路因此仍有区分度，
  集成测试和冒烟脚本才跑得通。**测试与冒烟一律走这条。**
- ``EMBEDDING_PROVIDER=qwen3``：``Qwen3Embedder``，``Qwen/Qwen3-Embedding-0.6B``
  （ARCHITECTURE § 4 选型），经 ``sentence-transformers``。**不在默认依赖里，连
  optional extra 都没声明**——声明了 ``uv.lock`` 就会把 torch 那一整棵树解析进来。
  要用就手动 ``uv pip install "sentence-transformers>=3.0"`` 再设 ``EMBEDDING_PROVIDER=qwen3``。

**加载时机**：两个实现的构造函数都不加载任何东西；``Qwen3Embedder`` 在**第一次真正
调用 ``embed()``** 时才 import ``sentence_transformers`` 并下权重。所以「后端启动」
「建 ``MemoryRuntime``」「跑一条没有事实产出的 ingest」都不会触发下载。镜像走
``HF_ENDPOINT``（``huggingface_hub`` 自己认这个环境变量，本模块只负责在报错的 hint
里提示它）。
"""

from __future__ import annotations

import hashlib
import math
import os
import threading
from collections.abc import Sequence
from typing import Any, Protocol, runtime_checkable

from .errors import EmbeddingUnavailableError
from .text import tokenize

__all__ = [
    "DEFAULT_PROVIDER",
    "EMBED_DIM",
    "Embedder",
    "HashEmbedder",
    "PROVIDER_ENV",
    "QWEN_MODEL_ID",
    "Qwen3Embedder",
    "embed",
    "embed_one",
    "get_embedder",
    "provider_name",
    "reset_embedder",
]

PROVIDER_ENV = "EMBEDDING_PROVIDER"
"""选 provider 的环境变量。取值 ``hash``（缺省）或 ``qwen3``。"""

DEFAULT_PROVIDER = "hash"

EMBED_DIM = 1024
"""与 `qiuqiu_data.lance.VECTOR_DIM` 必须一致。"""

QWEN_MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"


@runtime_checkable
class Embedder(Protocol):
    """嵌入器。上层只认这两个方法和 `dim`。"""

    dim: int

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_one(self, text: str) -> list[float]: ...


def _l2_normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:
        # 全零向量喂给 cosine 距离会 NaN，给一个确定的方向兜底
        return [1.0] + [0.0] * (len(vector) - 1)
    return [v / norm for v in vector]


class HashEmbedder:
    """token 哈希投影。确定性、零依赖、不出网。

    做法是特征哈希（hashing trick）：每个 token 用 blake2b 定出一个维度和一个符号，
    权重取 `1/sqrt(词频)` 的开方衰减，最后 L2 归一。同一个 token 永远落同一维，
    所以「用户喜欢喝美式咖啡」和「用户喜欢喝什么」的余弦相似度显著高于随机。
    """

    def __init__(self, dim: int = EMBED_DIM) -> None:
        self.dim = dim

    def _slot(self, token: str) -> tuple[int, float]:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        raw = int.from_bytes(digest, "big")
        return raw % self.dim, 1.0 if (raw >> 63) & 1 else -1.0

    def embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        tokens = tokenize(text)
        if not tokens:
            return _l2_normalize(vector)
        weight = 1.0 / math.sqrt(len(tokens))
        for token in tokens:
            index, sign = self._slot(token)
            vector[index] += sign * weight
        return _l2_normalize(vector)

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self.embed_one(t) for t in texts]


class Qwen3Embedder:
    """Qwen3-Embedding-0.6B。**构造不加载，第一次 embed 才加载。**

    加载失败一律抛 `EmbeddingUnavailableError`，`hint` 里写清三条出路：装依赖、设
    `HF_ENDPOINT` 镜像、或者把权重手动放到 `QIUQIU_EMBED_MODEL` 指的本地目录。
    ARCHITECTURE § 3 的失败处理就是这么写的。
    """

    dim = EMBED_DIM

    def __init__(self, model_id: str | None = None) -> None:
        self.model_id = model_id or os.environ.get("QIUQIU_EMBED_MODEL") or QWEN_MODEL_ID
        self._model: Any | None = None
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        """加载了没有。测试拿它断言「没碰过权重」。"""
        return self._model is not None

    def _endpoint_hint(self) -> str:
        endpoint = os.environ.get("HF_ENDPOINT")
        mirrored = (
            f"当前 HF_ENDPOINT={endpoint}。"
            if endpoint
            else "国内网络先设 HF_ENDPOINT=https://hf-mirror.com。"
        )
        return (
            f"{mirrored}"
            f'装依赖：uv pip install "sentence-transformers>=3.0"；'
            f"或把权重下到本地目录后用 QIUQIU_EMBED_MODEL 指过去；"
            f"或者去掉 EMBEDDING_PROVIDER=qwen3，走离线的哈希嵌入。"
        )

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as exc:
                raise EmbeddingUnavailableError(
                    f"嵌入模型 {self.model_id} 加载不了：缺 sentence-transformers。",
                    hint=self._endpoint_hint(),
                    model=self.model_id,
                ) from exc
            try:
                # HF_ENDPOINT 由 huggingface_hub 自己读环境变量，这里不重复传，
                # 只保证它已经在进程环境里（后端从 .env 载入）。
                self._model = SentenceTransformer(self.model_id)
            except Exception as exc:  # noqa: BLE001 - 下载、鉴权、磁盘都可能炸，统一成带 hint 的错
                raise EmbeddingUnavailableError(
                    f"嵌入模型 {self.model_id} 加载失败：{exc}",
                    hint=self._endpoint_hint(),
                    model=self.model_id,
                ) from exc
            return self._model

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._load()
        raw = model.encode(list(texts), normalize_embeddings=True)
        vectors = [[float(x) for x in row] for row in raw]
        for vector in vectors:
            if len(vector) != EMBED_DIM:
                raise EmbeddingUnavailableError(
                    f"{self.model_id} 输出 {len(vector)} 维，契约要 {EMBED_DIM} 维。",
                    hint="换回 Qwen/Qwen3-Embedding-0.6B；"
                    "真要换模型得重建冷热两张表并升契约主版本。",
                    model=self.model_id,
                )
        return vectors

    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]


_cached: dict[str, Embedder] = {}
_cache_lock = threading.Lock()


def provider_name() -> str:
    """当前选中的 provider 名。不认识的值一律退回哈希嵌入，不炸。"""
    choice = (os.environ.get(PROVIDER_ENV) or "").strip().lower()
    return "qwen3" if choice in {"qwen3", "qwen"} else DEFAULT_PROVIDER


def get_embedder() -> Embedder:
    """按 ``EMBEDDING_PROVIDER`` 挑一个嵌入器，进程内按 provider 缓存。

    **不加载任何权重**——qwen3 那条也是惰性的，第一次 ``embed()`` 才加载。
    """
    name = provider_name()
    cached = _cached.get(name)
    if cached is not None:
        return cached
    with _cache_lock:
        cached = _cached.get(name)
        if cached is not None:
            return cached
        instance: Embedder = Qwen3Embedder() if name == "qwen3" else HashEmbedder()
        _cached[name] = instance
        return instance


def reset_embedder() -> None:
    """清掉缓存。改了 ``EMBEDDING_PROVIDER`` 之后调；测试用。"""
    with _cache_lock:
        _cached.clear()


def embed(texts: Sequence[str]) -> list[list[float]]:
    """一批文本 → 一批 1024 维、L2 归一化的向量。**这是本模块唯一的对外入口。**"""
    if not texts:
        return []
    return get_embedder().embed(list(texts))


def embed_one(text: str) -> list[float]:
    """单条文本 → 一个 1024 维向量。"""
    return embed([text])[0]
