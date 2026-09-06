"""空目录 init() 后表与索引齐全，再跑一次不报错。"""

from __future__ import annotations

from pathlib import Path

import qiuqiu_data
from qiuqiu_data.lance import COLD_TABLE, HOT_TABLE
from qiuqiu_data.sqlite import MIGRATIONS_DIR, TABLES

#: 迁移目录里现有的全部脚本。写死列表的话每加一条迁移都要来改测试
ALL_MIGRATIONS = sorted(p.stem for p in MIGRATIONS_DIR.glob("[0-9][0-9][0-9]_*.sql"))


def test_init_on_empty_dir_creates_everything(data_root: Path) -> None:
    assert not data_root.exists()

    stores = qiuqiu_data.init()

    # 目录
    assert stores.paths.root == data_root.resolve()
    assert stores.paths.lance.is_dir()
    assert stores.paths.sqlite.is_file()
    for kind in qiuqiu_data.BLOB_KINDS:
        assert (stores.paths.blobs / kind).is_dir()

    # 两张 Lance 表
    assert stores.lance.table_names() == {HOT_TABLE, COLD_TABLE}

    # 热表三层里跟条数无关的那两层：全文与标量
    hot_indexes = stores.lance.list_indexes("hot")
    assert hot_indexes == {
        "tokens_idx": "FTS",
        "entities_idx": "LabelList",
        "speaker_idx": "BTree",
        "valid_from_idx": "BTree",
    }
    # 条数不足一万，向量索引按约定先不建，走全扫
    assert "vector_idx" not in hot_indexes
    assert stores.lance.list_indexes("cold") == {}

    # SQLite 八张表 + 迁移账本
    assert TABLES == (
        "sessions",
        "messages",
        "visible_memory",
        "event_log",
        "persona_learned",
        "settings",
        "providers",
        "run_metrics",
    )
    assert set(TABLES) <= stores.sqlite.table_names()
    assert stores.sqlite.applied_migrations() == ALL_MIGRATIONS
    assert stores.sqlite.journal_mode().lower() == "wal"


def test_init_is_repeatable(data_root: Path) -> None:
    first = qiuqiu_data.init()
    first.sqlite.set_setting("preset", "quiet")
    first.sqlite.close()

    second = qiuqiu_data.init()

    assert second.sqlite.applied_migrations() == ALL_MIGRATIONS
    assert second.sqlite.get_setting("preset") == "quiet"
    assert second.lance.list_indexes("hot")["tokens_idx"] == "FTS"
    assert second.lance.table_names() == {HOT_TABLE, COLD_TABLE}
