"""服务配置。**只从 `.env` 与进程环境读**（ARCHITECTURE § 7）。

例外只有一个：阈值与几个能热改的运行参数落 SQLite `settings`，`/config/thresholds`
改完立刻生效——那部分不在本模块，在 `qiuqiu_memory.runtime.Thresholds` 与 `routes/config.py`。

`.env` 的载入放在这里做一次，之后 `qiuqiu_models.registry` 与 `qiuqiu_data.config`
读 `os.environ` 就都能读到（registry 明确写了「把 .env 载入进程环境是应用的事」）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

__all__ = ["Config", "load_env"]

_env_loaded = False


def load_env() -> None:
    """载入 `.env`，只做一次。已经在进程环境里的变量优先，`.env` 不覆盖。"""
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    found = find_dotenv(usecwd=True)
    if found:
        load_dotenv(found)


def _int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, "")).strip())
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(str(os.environ.get(name, "")).strip())
    except ValueError:
        return default


def _flag(name: str, default: bool) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _default_scenarios_dir() -> Path:
    """仓库根的 `scenarios/`。装成 wheel 之后那条相对路径不存在，退回当前目录。"""
    here = Path(__file__).resolve()
    if len(here.parents) > 3:
        candidate = here.parents[3] / "scenarios"
        if candidate.is_dir():
            return candidate
    return Path.cwd() / "scenarios"


@dataclass(frozen=True)
class Config:
    """一次读齐，之后不再碰 `os.environ`（`VOICE_MODE` 除外，见 `voice_mode()`）。"""

    host: str = "127.0.0.1"
    port: int = 8000
    data_dir: str | None = None
    scenarios_dir: Path = field(default_factory=_default_scenarios_dir)

    #: 拼 prompt 时带上本会话最近多少条消息
    history_limit: int = 20
    #: 召回预算，对应 `qiuqiu_memory.Budget`
    recall_max_items: int = 12
    recall_max_tokens: int = 2048
    #: 生成温度
    temperature: float = 0.7
    #: TTS 音色。registry 拿不到 TTS 时这一项没用武之地
    #: 后门：设了就绕过界面上的音色选择。留空走 `GET /config/voice`。
    tts_voice: str = ""
    #: `/events` 多久发一次心跳注释，防中间件掐空闲连接
    events_heartbeat_s: float = 15.0
    #: 每页补发多少条历史事件
    events_page: int = 200
    #: 定时任务开关与降冷时刻（UTC 整点）
    scheduler_enabled: bool = True
    nightly_hour_utc: int = 19
    #: 累计多少轮对话触发一次性格沉淀；SQLite `settings.consolidate_every` 优先
    consolidate_every: int = 20
    #: 出网失败的重试间隔（秒），ARCHITECTURE § 3 定的「重试 2 次，间隔 1s、4s」
    retry_delays: tuple[float, ...] = (1.0, 4.0)

    @classmethod
    def from_env(cls) -> Config:
        load_env()
        scenarios = os.environ.get("SCENARIOS_DIR")
        return cls(
            host=os.environ.get("QIUQIU_HOST") or "127.0.0.1",
            port=_int("QIUQIU_PORT", 8000),
            data_dir=os.environ.get("DATA_DIR") or None,
            scenarios_dir=Path(scenarios) if scenarios else _default_scenarios_dir(),
            history_limit=_int("CHAT_HISTORY_LIMIT", 20),
            recall_max_items=_int("RECALL_MAX_ITEMS", 12),
            recall_max_tokens=_int("RECALL_MAX_TOKENS", 2048),
            temperature=_float("CHAT_TEMPERATURE", 0.7),
            tts_voice=os.environ.get("TTS_VOICE") or "",
            events_heartbeat_s=_float("EVENTS_HEARTBEAT_SECONDS", 15.0),
            scheduler_enabled=_flag("SCHEDULER_ENABLED", True),
            nightly_hour_utc=_int("TIERING_NIGHTLY_HOUR_UTC", 19),
            consolidate_every=_int("CONSOLIDATE_EVERY", 20),
        )


def voice_mode() -> str:
    """`cascade`（默认）或 `realtime`。**只有编排读它**（AD-13），走 registry 那份实现。"""
    from qiuqiu_models import registry

    return registry.voice_mode()
