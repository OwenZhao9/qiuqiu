-- 001_init：CONTRACTS § 5 的八张表。
-- 全部 IF NOT EXISTS，脚本本身可重复执行；migrate() 另有版本账本保证只跑一次。
-- 字段名与 CONTRACTS § 5 逐字对应，不增不减不改名。
-- 时间列统一存 ISO-8601 UTC 字符串（形如 2026-09-05T03:04:05.123456+00:00）。

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

-- 原始会话，性格沉淀读这里
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    model      TEXT,
    favorite   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_favorite ON messages(favorite, created_at);

CREATE TABLE IF NOT EXISTS visible_memory (
    id            TEXT PRIMARY KEY,
    layer         TEXT    NOT NULL,
    content       TEXT    NOT NULL,
    source        TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    fact_ids_json TEXT    NOT NULL DEFAULT '[]',
    updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visible_memory_layer ON visible_memory(layer, updated_at);

-- id 自增，后端按 since 游标增量拉
CREATE TABLE IF NOT EXISTS event_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    trace_id     TEXT,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_event_log_trace ON event_log(trace_id);
CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type, id);

-- 性格档案历史版本，只追加不覆盖
CREATE TABLE IF NOT EXISTS persona_learned (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    version         INTEGER NOT NULL UNIQUE,
    learned_json    TEXT    NOT NULL,
    consolidated_at TEXT    NOT NULL
);

-- preset、sliders、thresholds
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS providers (
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL,
    base_url    TEXT,
    api_key     TEXT,
    models_json TEXT    NOT NULL DEFAULT '[]',
    enabled     INTEGER NOT NULL DEFAULT 1
);

-- provider 取值如 mock / deepseek / edge / volc，契约 v0.1.3 加的列
CREATE TABLE IF NOT EXISTS run_metrics (
    trace_id   TEXT NOT NULL,
    stage      TEXT NOT NULL,
    provider   TEXT NOT NULL,
    tokens_in  INTEGER,
    tokens_out INTEGER,
    latency_ms INTEGER,
    ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_metrics_trace ON run_metrics(trace_id, ts);
CREATE INDEX IF NOT EXISTS idx_run_metrics_ts ON run_metrics(ts);
