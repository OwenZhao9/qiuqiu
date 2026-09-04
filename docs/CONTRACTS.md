# 跨模块契约

各分支并行开发靠这份文件。**改契约必须先改这里，再改代码，PR 里两者一起。** 主调度 Agent 审契约改动。

**契约地位。** 本文全部是契约，不是快照。七个分支并行开发期间，跨块共享的接口签名与数据表字段以本文为准，代码服从文档。全部分支合入 main 之后，跨块接口的改动在同一个 PR 里同时改代码与本文。

## 1 · HTTP 与 SSE

后端 `services/api`，监听 `127.0.0.1:8000`。所有响应 JSON，错误统一 `{ "error": { "code": string, "message": string, "hint": string } }`。

### 对话

```
POST /chat
Body: { "session_id": string, "content": string, "attachments"?: [{ "type": "image"|"audio", "blob_id": string }] }
Response: text/event-stream
```

SSE 事件：

```
event: meta
data: { "model": string, "memory_used": boolean, "recall_ids": string[] }

event: delta
data: { "text": string }

event: done
data: { "message_id": string, "tokens_in": number, "tokens_out": number, "latency_ms": number }

event: audio
data: { "pcm_b64": string, "sample_rate": number, "rms": 0–1 }     有 TTS 时才发，前端解码播放，rms 喂口型

event: error
data: { "code": string, "message": string, "hint": string }
```

### 记忆事件流

```
GET /events?since=<cursor>
Response: text/event-stream，断线用 since 续传
```

统一信封：

```json
{
  "id": "evt_...",
  "ts": "2026-09-04T22:31:00.000Z",
  "trace_id": "trc_...",
  "type": "filter" | "write" | "merge" | "recall",
  "payload": { ... }
}
```

`id` 为 `evt_` 加 `event_log` 自增 id；`since` 游标是该自增 id。

payload 按类型：

```
filter → { "decision": "accept"|"reject"|"uncertain", "score": 0–1, "reason": string,
           "source": "ambient_audio"|"ambient_image", "input_preview": string }

write  → { "raw": string, "speaker": "user"|"assistant",
           "facts": [{ "id": string, "text": string, "entities": string[], "valid_from": iso }],
           "dropped_spans": string[] }

merge  → { "result_id": string, "result_text": string,
           "absorbed": string[], "invalidated": [{ "id": string, "valid_to": iso }] }

recall → { "query": string,
           "plan": { "paths": ("semantic"|"lexical"|"symbolic")[], "depth": number, "rewritten": string },
           "hits": [{ "id": string, "path": string, "score": number }],
           "skipped_paths": string[], "tokens_injected": number, "cold_promoted": string[] }
```

### 被动采集

```
POST /ingest
Body: { "source": "ambient_audio"|"ambient_image", "blob_id": string, "captured_at": iso }
Response: { "trace_id": string, "decision": "accept"|"reject"|"uncertain" }
```

### 记忆库（用户可见层）

```
GET    /memories?layer=L0|L1|L2          → VisibleMemory[]
PATCH  /memories/{id}   Body: Partial<VisibleMemory>
DELETE /memories/{id}                    → 级联作废对应事实
```

```ts
interface VisibleMemory {
  id: string; layer: "L0"|"L1"|"L2"; content: string;
  source: "auto"|"manual"; enabled: boolean;
  fact_ids: string[]; updated_at: iso;
}
```

### 人格

```
GET  /persona              → { preset: PresetId|null, sliders: Sliders, learned: Learned, current: string }
PUT  /persona/preset       Body: { "preset": "warm"|"quiet"|"cute"|"sassy"|null }
PUT  /persona/sliders      Body: Sliders
POST /persona/reset-learned
```

```ts
type Sliders = { initiative: 0–100, verbosity: 0–100, emotion: 0–100, humor: 0–100 };
type Learned = { nickname?: string; humor_tolerance?: number; topics?: string[]; reply_length?: "short"|"medium"|"long" };
```

`preset: null` 表示真空——`sliders` 不注入 prompt。

### 语音

```
POST /voice/session   Body: { "session_id": string }
Response: { "voice_session_id": string, "mode": "cascade"|"realtime" }

WS /voice/stream?voice_session_id=<id>
上行：二进制帧，pcm16 单声道 16k
下行 JSON 帧：
  { "type": "partial", "role": "user", "text": string }
  { "type": "final",   "role": "user"|"assistant", "text": string }
  { "type": "audio",   "pcm_b64": string, "sample_rate": number, "rms": 0–1 }    仅 realtime
  { "type": "turn_end" }
  { "type": "error",   "code": string, "message": string, "hint": string }
```

级联：前端收到 `final(role=user)` 后自行 `POST /chat`，回复与 TTS 走 SSE。端到端：回复文字与音频都从这条连接下行，`final(role=assistant)` 即回复全文，后端按 role 各调一次 `ingest()`。

### 其他

```
GET  /config/thresholds   PUT /config/thresholds
GET  /providers  POST /current-model
POST /blobs  (multipart)   → { "blob_id": string }
GET  /health
```

## 2 · Electron IPC

`preload.js` 经 `contextBridge` 暴露 `window.qiuqiu`：

```ts
interface QiuqiuBridge {
  // 窗口
  openMain(): void; hideMain(): void; hidePet(): void; resetPet(): void; focusPet(): void; quit(): void;
  dragPet(dx: number, dy: number): void;
  // 主窗口 → 桌宠：回复流转发（主窗口是唯一 SSE 持有者）
  forwardDelta(sessionId: string, text: string): void;
  forwardDone(sessionId: string): void;
  // 主窗口 → 桌宠：状态与表情
  setPetState(state: "idle"|"listening"|"thinking"|"speaking", emotionId?: string): void;
  // 桌宠 → 主窗口：内联输入条提交
  submitFromPet(text: string): void;
  // 订阅
  onDelta(cb: (sessionId: string, text: string) => void): void;
  onPetState(cb: (state: string, emotionId?: string) => void): void;
}
window.__QIUQIU_API__ = "http://127.0.0.1:8000";
```

## 3 · MemoryFacade（Python）

`packages/memory/qiuqiu_memory/facade.py`。服务层只能调这五个方法。

```python
class Source(Enum):
    DIALOGUE = "dialogue"          # 用户或 AI 说的，跳过筛选
    JOURNAL = "journal"            # 日记随笔，跳过筛选，另出摘要
    AMBIENT_AUDIO = "ambient_audio"
    AMBIENT_IMAGE = "ambient_image"

@dataclass
class IngestResult:
    trace_id: str
    accepted: list[FactId]
    rejected: list[Rejection]      # Rejection = { reason, score, preview }
    merged: list[MergeOp]

@dataclass
class Budget:
    max_items: int = 12
    max_tokens: int = 2048
    paths: set[str] | None = None  # None = 交给规划器

@dataclass
class RecallResult:
    items: list[Hit]               # Hit = { id, text, path, score, valid_from }
    paths_used: list[str]
    plan: RetrievalPlan
    cold_promoted: list[FactId]

class MemoryFacade:
    def ingest(self, text: str, *, source: Source, speaker: str, ts: datetime,
               blob_id: str | None = None) -> IngestResult: ...
    def recall(self, query: str, *, budget: Budget,
               now: datetime | None = None) -> RecallResult: ...   # now 缺省为当前时间，场景回放传偏移后的时间
    def list_visible(self, layer: str | None = None) -> list[VisibleMemory]: ...
    def edit_visible(self, mid: str, **fields) -> VisibleMemory: ...
    def subscribe(self) -> AsyncIterator[MemoryEvent]: ...
```

人格相关另在 `qiuqiu_memory/persona.py`：

```python
class PersonaService:
    def current(self) -> str                     # 读热存储快照，拼好的 prompt 片段
    def set_preset(self, preset: str | None): ... # 触发快照重算
    def set_sliders(self, sliders: Sliders): ...
    def run_consolidation(self) -> Learned       # 性格沉淀：读 SQLite 原始会话，归纳，写冷存储，重算快照
```

## 4 · 模型适配接口（Python）

`packages/models/qiuqiu_models/`。每个能力一个抽象基类，供应商实现放 `providers/`。

```python
class ChatModel(Protocol):
    async def stream(self, messages: list[Message], *, temperature: float = 0.7) -> AsyncIterator[str]: ...
    async def complete(self, messages: list[Message]) -> str: ...

class VisionModel(Protocol):
    async def describe(self, image: bytes | str, prompt: str) -> str: ...   # bytes 或 URL

class ASR(Protocol):
    def transcribe(self, pcm16k: bytes) -> Transcript: ...                   # { text, lang, confidence }
    def stream(self, chunks: Iterator[bytes]) -> Iterator[PartialTranscript]: ...

class VAD(Protocol):
    def evaluate(self, pcm16k: bytes) -> VadResult: ...                       # { has_speech, energy, confidence }

class TTS(Protocol):
    async def synthesize(self, text: str, *, voice: str) -> AsyncIterator[AudioChunk]: ...  # chunk 含 pcm 与 rms

class RealtimeVoice(Protocol):
    """端到端语音对话。一次会话一个连接；send 推用户音频，events 收模型输出。"""
    async def open(self, *, system_prompt: str, voice: str) -> None: ...
    async def send(self, pcm16k: bytes) -> None: ...
    async def interrupt(self) -> None: ...                                   # 用户开口打断
    def events(self) -> AsyncIterator[RealtimeEvent]: ...
    async def close(self) -> None: ...

# RealtimeEvent 三类：
#   { "type": "audio", "pcm": bytes, "rms": float }              模型输出音频，rms 驱动口型
#   { "type": "transcript", "role": "user"|"assistant", "text": str, "final": bool }
#   { "type": "turn_end" }
```

调用方只 import 抽象类，实现由 `qiuqiu_models.registry.get("chat")` 按 `.env` 返回。

## 5 · 数据模型

### LanceDB · `facts`（热表与冷表同 schema）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 事实主键 |
| `text` | string | 自包含事实 |
| `vector` | float32[1024] | 语义路 |
| `tokens` | string[] | 字面路 |
| `entities` | string[] | 标签路 |
| `speaker` | string | 归属人 |
| `source` | string | 来源 Source |
| `valid_from` | timestamp | |
| `valid_to` | timestamp? | 空 = 当前有效 |
| `superseded_by` | string? | 被哪条取代 |
| `last_hit_at` | timestamp | 冷热调度依据 |
| `blob_id` | string? | 指向原图 / 原文 / 音频 |

### SQLite

```sql
sessions(id, title, archived, created_at, updated_at)
messages(id, session_id, role, content, model, favorite, created_at)      -- 原始会话，性格沉淀读这里
visible_memory(id, layer, content, source, enabled, fact_ids_json, updated_at)
event_log(id, ts, trace_id, type, payload_json)
persona_learned(id, version, learned_json, consolidated_at)                -- 性格档案历史版本
settings(key, value)                                                       -- preset、sliders、thresholds
providers(id, name, base_url, api_key, models_json, enabled)
run_metrics(trace_id, stage, tokens_in, tokens_out, latency_ms, ts)
```

## 6 · 表情映射

丘丘用 Emotion Ball 的 `emotionId`。映射由 `packages/character` 维护，`design/` 定规范。

| 触发 | emotionId | Emotion Ball 名 |
|---|---|---|
| 状态 idle | `02` | 待机放空 |
| 状态 listening | `35` | 等待输入 |
| 状态 thinking | `30` | 思考中 |
| 状态 speaking | `39` | 输出回复 |
| 事件 filter.reject | 不切换 | — |
| 事件 filter.uncertain | `11` | 疑惑 |
| 事件 write | `10` | 开心 |
| 事件 merge | `19` | 满意 |
| 事件 recall（命中） | `37` | 复述回忆 |
| 事件 recall（下探冷存储） | `40` | 检索资料 |
| 回复含拒绝 | `38` | 拒绝/受限 |
| 请求出错 | `34` | 出错 |

情绪推断（回复文本 → `10–21` 区间）由 `packages/character/emotion.ts` 负责，规则见 `design/emotion-rules.md`。

## 7 · 人格合成规则

```
prompt_persona = boundary_block
               + (preset_block(sliders) if preset is not None else "")
               + learned_block(learned)
```

- `boundary_block` 是常量，永远在最前，内容见 `packages/memory/persona.py::BOUNDARY`
- `preset is None` 时不生成 `preset_block`，**不是**生成一个「中等」块
- `learned_block` 覆盖 `preset_block` 里的同名维度（例如 learned 里有 `reply_length`，就覆盖 sliders.verbosity 的描述）
- 合成结果写热存储 `persona_snapshot`，`PersonaService.current()` 只读快照

## 8 · 版本与兼容

契约文件顶部维护版本号。破坏性改动升主版本，各分支在 PR 描述里声明依赖的契约版本。

当前：**v0.1.2**（契约地位说明；`/chat` 增 `audio` 事件；增 `/voice/session` 与 `WS /voice/stream`；事件 `id` 与游标的对应；`recall()` 增 `now`）
