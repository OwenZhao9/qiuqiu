"""嵌入。最要紧的一条：维度必须等于 `qiuqiu_data.lance.VECTOR_DIM`（CONTRACTS § 5）。"""

from __future__ import annotations

import math

import pytest
from qiuqiu_data.lance import VECTOR_DIM
from qiuqiu_memory import embed as embed_module
from qiuqiu_memory.embed import (
    EMBED_DIM,
    HashEmbedder,
    Qwen3Embedder,
    embed,
    embed_one,
    get_embedder,
    provider_name,
)
from qiuqiu_memory.errors import EmbeddingUnavailableError


def test_dimension_matches_data_contract() -> None:
    """改这个数要重建冷热两张表并升契约主版本，所以这条测试盯着它。"""
    assert EMBED_DIM == VECTOR_DIM == 1024


class TestHashEmbedder:
    def test_shape_and_normalization(self) -> None:
        vector = embed_one("用户喜欢喝美式咖啡")
        assert len(vector) == EMBED_DIM
        assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0, rel_tol=1e-6)

    def test_deterministic(self) -> None:
        assert embed_one("一样的话") == embed_one("一样的话")

    def test_empty_text_is_not_nan(self) -> None:
        vector = embed_one("")
        assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0, rel_tol=1e-6)

    def test_batch_matches_single(self) -> None:
        texts = ["用户叫赵宁", "用户喜欢咖啡"]
        assert embed(texts) == [embed_one(t) for t in texts]

    def test_empty_batch(self) -> None:
        assert embed([]) == []

    def test_lexical_overlap_beats_random(self) -> None:
        """哈希嵌入不是随机向量：词面重合的两句余弦明显更高，语义路才有区分度。"""

        def cosine(a: list[float], b: list[float]) -> float:
            return sum(x * y for x, y in zip(a, b, strict=True))

        query = embed_one("用户喜欢喝什么")
        near = embed_one("用户喜欢喝美式咖啡")
        far = embed_one("窗外今天下了很大的雨")
        assert cosine(query, near) > cosine(query, far)


class TestProviderSelection:
    def test_default_is_hash(self) -> None:
        assert provider_name() == "hash"
        assert isinstance(get_embedder(), HashEmbedder)

    def test_unknown_value_falls_back_to_hash(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("EMBEDDING_PROVIDER", "什么鬼")
        embed_module.reset_embedder()
        assert isinstance(get_embedder(), HashEmbedder)

    def test_cached_per_provider(self) -> None:
        assert get_embedder() is get_embedder()

    def test_qwen3_selected_but_not_loaded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """选中 qwen3 不等于下权重——构造函数一个字节都不碰。"""
        monkeypatch.setenv("EMBEDDING_PROVIDER", "qwen3")
        embed_module.reset_embedder()
        chosen = get_embedder()
        assert isinstance(chosen, Qwen3Embedder)
        assert chosen.loaded is False


class TestQwen3Failure:
    def test_missing_dependency_raises_with_hint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """缺依赖时抛的错必须带 hint，且 hint 里提到镜像与降级出路。"""
        import builtins

        real_import = builtins.__import__

        def fake_import(name: str, *args: object, **kwargs: object) -> object:
            if name == "sentence_transformers":
                raise ImportError("no module named sentence_transformers")
            return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(builtins, "__import__", fake_import)
        with pytest.raises(EmbeddingUnavailableError) as caught:
            Qwen3Embedder().embed(["随便一句"])
        body = caught.value.to_dict()
        assert body["code"] == "embedding_unavailable"
        assert "HF_ENDPOINT" in body["hint"]
        assert "EMBEDDING_PROVIDER" in body["hint"]

    def test_wrong_dimension_rejected(self) -> None:
        """模型换了、维度对不上，宁可炸也不能悄悄写进表里。"""

        class ShortModel:
            def encode(self, texts: list[str], **_: object) -> list[list[float]]:
                return [[0.1] * 8 for _ in texts]

        embedder = Qwen3Embedder()
        embedder._model = ShortModel()  # noqa: SLF001 - 直接塞一个假模型，不下权重
        with pytest.raises(EmbeddingUnavailableError) as caught:
            embedder.embed(["随便一句"])
        assert "1024" in str(caught.value)

    def test_empty_batch_never_loads(self) -> None:
        embedder = Qwen3Embedder()
        assert embedder.embed([]) == []
        assert embedder.loaded is False
