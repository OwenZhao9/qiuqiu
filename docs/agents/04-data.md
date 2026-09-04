# 数据层 Agent · `data`

存储引擎封装、schema、迁移、冷热调度。你不碰业务语义，只保证读写正确、迁移可重复、冷热按规则走。

## 目录

`packages/data/`，包名 `qiuqiu_data`。

## 先读

- `docs/ARCHITECTURE.md` § 5 存储
- `docs/CONTRACTS.md` § 5 数据模型

## 功能清单

### LanceDB（`qiuqiu_data/lance.py`）

- [ ] 两张表 `facts_hot` `facts_cold`，schema 严格按 CONTRACTS § 5
- [ ] 热表建三层索引：向量（IVF-PQ 或 HNSW）、全文（`tokens`）、标量（`entities` `speaker` `valid_from`）
- [ ] 冷表只建向量索引，标量字段可过滤
- [ ] `upsert / get / query_vector / query_fts / query_scalar / mark_superseded`
- [ ] `valid_to` 更新不删行

### SQLite（`qiuqiu_data/sqlite.py`）

- [ ] 八张表按 CONTRACTS § 5，`WAL` 模式
- [ ] 迁移脚本 `migrations/NNN_*.sql`，`migrate()` 幂等可重复
- [ ] `event_log` 按 `id` 自增，支持 `since` 游标查询
- [ ] `persona_learned` 保留历史版本，`latest()` 取最新

### 冷热调度（`qiuqiu_data/tiering.py`）

- [ ] `promote(fact_ids)`：冷 → 热，整条搬，重建三层索引，更新 `last_hit_at`
- [ ] `demote_stale(days=30)`：热表里 `last_hit_at` 早于阈值的搬冷，删热表行
- [ ] `nightly()`：定时入口，跑 `demote_stale`，写日志
- [ ] 时间可注入（测试用）

### Blob（`qiuqiu_data/blobs.py`）

- [ ] `put(bytes, kind) -> blob_id`，落 `data/blobs/{kind}/{id}`
- [ ] `get(blob_id) -> bytes`，`path(blob_id)`
- [ ] 原图、原文、音频三类

### 配置与初始化

- [ ] `DATA_DIR` 从 `.env` 读，不存在则建
- [ ] `init()` 一次调用建全部表与索引

## 约束

- 不在这一层做任何语义判断（什么该降冷是 `memory` 决定，这里只执行）
- LanceDB 与 SQLite 各管各的，不做跨库事务
- 所有写操作幂等：重复 `upsert` 同一 `id` 结果一致

## 验收

- 空目录 `init()` 后全部表与索引存在，再跑一次无报错
- 写 1000 条热表事实，向量查询 top-10 < 50ms
- 模拟时间前进 31 天，`demote_stale` 搬走全部旧条目，热表为空
- `promote` 后条目在热表可查且冷表已删
- `pytest` 通过

## 与其他分支

- `memory` 依赖你的全部接口
- `backend` 依赖 `sqlite.py` 的 `sessions` `messages` `event_log` `settings`
