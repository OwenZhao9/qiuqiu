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

帧格式：**不写 `event:` 名**，全部走默认的 `message`；前端一个 `onmessage` 收下再按信封的
`type` 分发。`id:` 行写 `event_log` 的自增 id（纯数字，不带 `evt_` 前缀），浏览器 `EventSource`
断线重连会自动带 `Last-Event-ID` 头，后端认这个头，等同于 `?since=`。`?since=` 同时接受
`12` 与 `evt_12` 两种写法。游标是**严格大于**：`since=12` 返回 id 13 起，不含 12。

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

write  → { "raw": string, "speaker": "user"|"assistant"|"ambient",
           "facts": [{ "id": string, "text": string, "entities": string[], "valid_from": iso }],
           "dropped_spans": string[] }

merge  → { "result_id": string, "result_text": string,
           "absorbed": [{ "id": string, "text": string }],
           "invalidated": [{ "id": string, "text": string, "valid_to": iso }] }

recall → { "query": string,
           "plan": { "paths": ("semantic"|"lexical"|"symbolic")[], "depth": number, "rewritten": string },
           "hits": [{ "id": string, "text": string, "path": string, "score": number }],
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
DELETE /memories/{id}                    → VisibleMemory（级联作废对应事实，不删行）
```

```ts
interface VisibleMemory {
  id: string; layer: "L0"|"L1"|"L2"; content: string;
  source: "auto"|"manual"; enabled: boolean;
  fact_ids: string[]; updated_at: iso;
}
```

`layer` 是**稳定度**分层，不是重要度，也不是时间：

| layer | 含义 | 例子 |
|---|---|---|
| `L0` | 身份，几乎不变 | 名字、称呼、生日、职业 |
| `L1` | 偏好，变得慢 | 喜欢什么、讨厌什么、习惯怎样 |
| `L2` | 近况，变得快 | 最近发生的事、临时安排 |

归层规则在 `packages/memory/qiuqiu_memory/facade.py::layer_of`。前端按这三层分组显示。

`DELETE /memories/{id}` 在中间件侧落到 `edit_visible(mid, deleted=True)`：该条 `enabled` 置否并对 `fact_ids` 逐条 `mark_superseded`，**不删行**（AD-9）。

### 会话与历史

```
GET /sessions?archived=false             → Session[]
GET /sessions/{id}/messages?limit=&before=  → Message[]
```

```ts
interface Session  { id: string; title: string; archived: boolean; created_at: iso; updated_at: iso; }
interface Message  { id: string; session_id: string; role: "user"|"assistant";
                     content: string; model: string|null; favorite: boolean; created_at: iso; }
```

会话由 `POST /chat` 自动创建。这两条只读，前端用来渲染历史；写入始终经 `/chat`。

### 人格

```
GET  /persona              → { preset: PresetId|null, sliders: Sliders, learned: Learned, current: string }
PUT  /persona/preset       Body: { "preset": "warm"|"quiet"|"cute"|"sassy"|null }
PUT  /persona/sliders      Body: Sliders
POST /persona/reset-learned
```

三条写接口都返回与 `GET /persona` 同形的四字段对象，省前端一次回读。

```
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
POST /compare              Body: { "query": string, "session_id"?: string,
                                   "configs": [{ "name": string, "memory": boolean }] }
                           → { query, results: [{ name, text, tokens_in, tokens_out, latency_ms }], delta }
GET  /scenarios            → [{ "name": string, "title": string }]
POST /scenario/{name}/play Body: { "speed"?: number }   speed=1.0 原速，0 不等待

GET  /voices               → [{ "id": string, "label": string, "blurb": string,
                                  "realtime_supported": boolean }]
GET  /config/voice         → { "voice": string }
PUT  /config/voice         Body: { "voice": string }   → { "voice": string }

GET  /config/thresholds   PUT /config/thresholds
GET  /providers            → ProviderInfo[]（透传 registry.list_providers()）
POST /current-model        Body: { "capability": "chat"|"vision", "model": string }
                           → { capability, model, provider: ProviderInfo }
POST /blobs  (multipart)   → { "blob_id": string, "kind": "image"|"text"|"audio", "bytes": number }
GET  /health
```

`/config/thresholds` 的 body 是筛选阈值，读写同一形状：

```ts
type Thresholds = { accept: number; uncertain: number };   // 0–1，默认 0.72 / 0.45
```

判定：`score >= accept` 为 `accept`，`score >= uncertain` 为 `uncertain`，否则 `reject`。`PUT` 后热生效，落 SQLite `settings`。

`GET /providers` 直接透传 `qiuqiu_models.registry.list_providers()`，一个能力一项：

```ts
interface ProviderInfo {
  capability: "chat"|"vision"|"asr"|"vad"|"tts"|"realtime";
  provider: string;          // deepseek / edge / sensevoice / silero / volc / doubao / mock
  model: string | null;
  base_url: string | null;
  has_key: boolean;          // 只报有没有，永远不回 key 本身
  available: boolean;        // 现在能不能用
  local: boolean;            // 本地跑还是出网
  hint?: string;             // available 为 false 时说明下一步做什么
  voice_mode?: "cascade"|"realtime";   // 仅 capability=realtime
}
```

## 2 · Electron IPC

`preload.js` 经 `contextBridge` 暴露 `window.qiuqiu`：

```ts
interface QiuqiuBridge {
  // 窗口
  openMain(): void; hideMain(): void; hidePet(): void; resetPet(): void; focusPet(): void; quit(): void;
  dragPet(dx: number, dy: number): void;
  // 主窗口 → 桌宠：回复转发（主窗口是唯一 SSE 持有者）。
  // 推的是**这一轮到此为止的全文**，不是增量——桌宠只负责显示，不自己拼字。
  // 拼字等于第二套消息处理，漏一条两个窗口显示的就不一样；推全文还能按帧合并
  forwardReply(sessionId: string, text: string): void;
  forwardDone(sessionId: string): void;
  // 主窗口 → 桌宠：状态与表情
  // `emotionId` 不是可选装饰：桌宠不自己推断表情，主窗口每换一次表情就带上它发一次，
  // 只发 state 的话桌宠永远只有四个状态表情，事件表情与情绪推断的结果全丢
  setPetState(state: "idle"|"listening"|"thinking"|"speaking", emotionId?: string): void;
  // 桌宠 → 主窗口：内联输入条提交
  submitFromPet(text: string): void;
  callFromPet(): void;                          // 桌宠请求开 / 挂通话，会话跑在主窗口
  // 桌宠 → 主进程：窗口行为。透明窗口里这三件事渲染进程自己做不了
  setPetPassthrough(ignore: boolean): void;   // 鼠标穿透开关
  setPetExpanded(expanded: boolean): void;    // 展开输入条时改窗口尺寸，主进程保住球心
  popupPetMenu(state: { ambientPaused: boolean }): void;  // 原生右键菜单，HTML 菜单会被窗口边界裁掉
  setSkin(skin: string): void;                // 换皮肤，主进程转给另一个窗口
  setPetBubble(height: number): void;         // 气泡量出来多高。透明窗口画在窗口外的会被裁掉，窗口要先长出这块
  mainReady(): void;                          // 主窗口挂好监听了。在这之前桌宠发的话主进程攒着，不然会丢
  pokePet(): void;                            // 用户动了桌宠（点 / 拖 / 展开）。闲置计时在主窗口，它看不见这些动作
  // 订阅。**每个都返回退订函数**，组件必须在 effect 的清理里调它：
  // React 的 effect 开发模式下跑两遍、组件重挂还会再订，只订不退会越攒越多，
  // 一条 delta 被拼进气泡好几遍，回复变成每个字重复
  type Unsubscribe = () => void;
  onReply(cb: (sessionId: string, text: string) => void): Unsubscribe;
  onDone(cb: (sessionId: string) => void): Unsubscribe;
  onPetState(cb: (state: string, emotionId?: string) => void): Unsubscribe;
  onSubmitFromPet(cb: (text: string) => void): Unsubscribe;   // 主窗口收桌宠发的话，AD-5 链路靠它闭合
  onCallFromPet(cb: () => void): Unsubscribe;                 // 主窗口收桌宠按的通话和弦
  onPetFocus(cb: () => void): Unsubscribe;                    // 全局快捷键唤起后展开输入条
  onAmbientToggle(cb: (paused: boolean) => void): Unsubscribe; // 托盘与右键菜单共用的开关，两个渲染进程都要知道
  onSkin(cb: (skin: string) => void): Unsubscribe;            // 另一个窗口换了皮肤。收到只应用不再广播，否则来回弹
  onPetGaze(cb: (dx: number, dy: number) => void): Unsubscribe; // 光标相对球心的偏移，屏幕像素。桌宠窗口穿透且只有 200 px，自己拿不到窗口外的指针
  onPoke(cb: () => void): Unsubscribe;                 // 用户动了桌宠，主窗口据此复位闲置计时
}
window.__QIUQIU_API__ = "http://127.0.0.1:8000";
```

## 3 · MemoryFacade（Python）

`packages/memory/qiuqiu_memory/facade.py`。服务层只能调这七个方法。

```python
class Source(Enum):
    DIALOGUE = "dialogue"          # 用户或 AI 说的，跳过筛选
    JOURNAL = "journal"            # 日记随笔，跳过筛选，另出摘要
    AMBIENT_AUDIO = "ambient_audio"
    AMBIENT_IMAGE = "ambient_image"
    PERSONA = "persona"            # 性格沉淀写冷存储的性格档案；中间件内部用，调用方不传

@dataclass
class IngestResult:
    trace_id: str
    accepted: list[FactId]
    rejected: list[Rejection]      # Rejection = { reason, score, preview }
    merged: list[MergeOp]
    decision: str = "accept"       # accept / reject / uncertain，POST /ingest 直接透传
    summary: str | None = None     # 仅 JOURNAL，日记界面显示这段摘要

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
               blob_id: str | None = None, trace_id: str | None = None) -> IngestResult: ...
    def recall(self, query: str, *, budget: Budget, now: datetime | None = None,
               trace_id: str | None = None) -> RecallResult: ...   # now 缺省为当前时间，场景回放传偏移后的时间
    def list_visible(self, layer: str | None = None) -> list[VisibleMemory]: ...
    def edit_visible(self, mid: str, **fields) -> VisibleMemory: ...
    def subscribe(self) -> AsyncIterator[MemoryEvent]: ...
    def note_filter(self, *, decision: str, score: float, reason: str, source: Source,
                    input_preview: str, trace_id: str | None = None) -> str: ...
```

**`trace_id` 由调用方传。** ARCHITECTURE 第 7 节要求一条 `trace_id` 贯穿 `ingest`、事件信封与 `run_metrics`；`/chat` 与 `/ingest` 生成它，经这两个参数传进来，中间件发出的 `filter` `write` `merge` `recall` 事件都挂在同一条 trace 上。不传时中间件自己生成一条，返回值里照常带回。

**`uncertain` 只发事件，不落库。** 筛选判定为 `accept` 才继续压缩与写入；`uncertain` 与 `reject` 都到此为止，区别只在侧栏的呈现（§ 6 里 `uncertain` 切 `11`，`reject` 不切表情）。理由：错记一条要用户去记忆库里手动删，比漏记一条贵。

`ingest()` 与 `recall()` 是**同步方法**。后端在事件循环里调用要走 `await asyncio.to_thread(...)`。

`subscribe()` **在调用时同步完成注册**，不等第一次 `__anext__`。调用方可以紧接着按
`since` 补发历史而不丢中间的事件——注册与补发之间没有窗口。这是契约的一部分，实现不得
改成惰性注册。代价是它**必须在协程里调**：订阅要绑定调用方所在的事件循环，发布方
（同步的中间件）才能把事件投进去。

`note_filter()` 供后端记录**它自己做出的**筛选判断，典型是 VAD 判无人声、片段根本没
进中间件的情况。它只发一条 `filter` 事件（照常写 `event_log`），不做压缩也不写事实，
返回事件 id。有了它，被 VAD 拦下的片段在侧栏也留得下痕迹——「记忆过程看得见」是第一
质量属性，最常见的那类拒绝不能是空白。事件仍由中间件发布，AD-14 不破。

人格相关另在 `qiuqiu_memory/persona.py`：

```python
class PersonaService:
    def current(self) -> str                     # 读热存储快照，拼好的 prompt 片段
    def set_preset(self, preset: str | None): ... # 触发快照重算
    def set_sliders(self, sliders: Sliders): ...
    def run_consolidation(self) -> Learned       # 性格沉淀：读 SQLite 原始会话，归纳，写冷存储，重算快照
    def reset_learned(self) -> Learned           # POST /persona/reset-learned：写一版空的相处性格，历史不删（AD-9），重算快照
```

降冷的入口在 `qiuqiu_memory.pipeline.tiering.nightly(runtime)`，由后端定时任务调（AD-10：判断标准由 memory 定，执行由 data 做）。后端不直接调 `qiuqiu_data.tiering`。

**热存储 `persona_snapshot` 落在 SQLite `settings`** 的三个键上，memory 写 memory 读，后端不碰：`persona.snapshot`（合成好的 prompt 片段）、`persona.preset`、`persona.sliders`。

## 4 · 模型适配接口（Python）

`packages/models/qiuqiu_models/`。每个能力一个抽象基类，供应商实现放 `providers/`。

**异步形状。** `stream()` 与 `synthesize()` 是 **async 函数，返回异步迭代器**，不是 async generator。调用方必须先 `await` 再 `async for`：

```python
async for delta in await chat.stream(messages): ...
async for chunk in await tts.synthesize(text, voice=v): ...
async for ev in rv.events(): ...          # events() 是普通 def，不 await
```

```python
class ChatModel(Protocol):
    async def stream(self, messages: list[Message], *, temperature: float = 0.7) -> AsyncIterator[str]: ...
    async def complete(self, messages: list[Message]) -> str: ...

class VisionModel(Protocol):
    async def describe(self, image: bytes | str, prompt: str) -> str: ...   # bytes 或 URL

class ASR(Protocol):
    def transcribe(self, pcm16k: bytes) -> Transcript: ...
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

# RealtimeEvent 四类：
#   { "type": "audio", "pcm": bytes, "rms": float, "sample_rate": int }
#        模型输出音频，rms 驱动发声脉动。**sample_rate 必带**：端到端下行 24k，
#        级联 TTS 是 16k，前端按错的采样率播会又慢又闷
#   { "type": "transcript", "role": "user"|"assistant", "text": str, "final": bool }
#   { "type": "interrupt" }
#        用户开口了，前端立刻停播已缓冲的音频。端到端语音能打断是它相对级联的主要
#        优势，没有这个信号就用不上。级联链路不发这类事件
#   { "type": "turn_end" }
```

数据类字段：

```python
@dataclass
class Message:            role: str; content: str            # role: system / user / assistant

@dataclass
class Transcript:         text: str; lang: str; confidence: float

@dataclass
class PartialTranscript:  text: str; final: bool; lang: str; confidence: float

@dataclass
class VadResult:          has_speech: bool; energy: float; confidence: float

@dataclass
class AudioChunk:         pcm: bytes; rms: float; sample_rate: int = 16000

@dataclass
class RealtimeEvent:
    type: str                                    # audio / transcript / turn_end
    pcm: bytes | None = None                     # type=audio
    rms: float | None = None                     # type=audio
    sample_rate: int | None = None               # type=audio
    role: str | None = None                      # type=transcript
    text: str | None = None                      # type=transcript
    final: bool | None = None                    # type=transcript
```

`RealtimeEvent.to_dict()` 只输出非 `None` 字段，产出上面注释里的三种形状。

**错误。** 模型层异常统一带 `hint`，`to_dict()` 产出 § 1 的 `{ code, message, hint }`，上层可直接当错误体返回。key 在 `message` 与 `hint` 里必须已脱敏。

调用方只 import 抽象类，实现由 `qiuqiu_models.registry.get("chat")` 按 `.env` 返回。

## 5 · 数据模型

### LanceDB · `facts`（热表与冷表同 schema）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 事实主键 |
| `text` | string | 自包含事实 |
| `vector` | float32[1024] | 语义路。**维度是破坏性契约**，改维度要重建两张表并升主版本 |
| `tokens` | string[] | 字面路 |
| `entities` | string[] | 标签路 |
| `speaker` | string | 归属人，取值 `user` \| `assistant` \| `ambient`。`ambient` 表示从环境采集、说话人未知——被动采集一律用它，**不得记成 `user`**（`multi-person` 演示场景里客厅有三个人，全记成用户就是错的）。分辨环境里的不同人（说话人分离）推迟 |
| `source` | string | 来源，取值为 § 3 `Source` 枚举的 value：`dialogue` \| `journal` \| `ambient_audio` \| `ambient_image` \| `persona`（性格档案，只由性格沉淀写冷表） |
| `valid_from` | timestamp | |
| `valid_to` | timestamp? | 空 = 当前有效 |
| `superseded_by` | string? | 被哪条取代 |
| `last_hit_at` | timestamp | 冷热调度依据 |
| `blob_id` | string? | 指向原图 / 原文 / 音频 |

### SQLite

```sql
sessions(id, title, archived, created_at, updated_at)
messages(id, session_id, role, content, model, favorite, created_at)      -- 原始会话，性格沉淀读这里
visible_memory(id, layer, content, source, enabled, fact_ids_json, updated_at)  -- layer: L0|L1|L2；source: auto|manual
event_log(id, ts, trace_id, type, payload_json)
persona_learned(id, version, learned_json, consolidated_at)                -- 性格档案历史版本
settings(key, value)                                                       -- preset、sliders、thresholds
providers(id, name, base_url, api_key, models_json, enabled)
run_metrics(trace_id, stage, provider, tokens_in, tokens_out, latency_ms, ts)  -- provider 例如 mock / deepseek / edge
```

### 数据层接口 · `qiuqiu_data`

调用方 memory（全部）与 backend（只 `sqlite` 的后端归属表，见 ARCHITECTURE 第 7 节）。

```
lance    upsert / get / get_many / query_vector / query_fts / query_scalar
         mark_superseded(fact_id, superseded_by=None, valid_to=None, tier="hot") -> bool
                                                           一次一条，写 valid_to 与 superseded_by，不删行
         touch(fact_ids, at=None, tier="hot")              更新 last_hit_at
         delete_rows(fact_ids, tier)                       只给冷热搬运用，AD-9 允许的唯一删行场景
         count / ensure_indexes / optimize / table_names
sqlite   migrate() 幂等；八张表的读写；event_log 按自增 id 的 since 游标查询（events_since / latest_event_id）；
         latest_persona_learned()；record_metric(trace_id, stage, provider, ...)
         list_messages(session_id, limit=200, offset=0)    按 created_at 升序
         list_recent_messages(limit=50)                    跨会话、按 created_at 降序取最近 N 条，性格沉淀用
tiering  promote(fact_ids) / demote_stale(days=30) / nightly()，时钟可注入
blobs    put(bytes, kind) -> blob_id / get(blob_id) -> bytes / path(blob_id)
         blob_id 形如 "{kind}/{sha256}"，自带 kind；kind 取值 image | text | audio
init()   一次建齐目录、表与索引，可重复调用
```

`blob_id` 内容寻址，同字节重复 `put` 幂等。向量索引在热表条数不足 1 万时不建、全扫，过万后建，`query_vector` 对外行为不变。

## 6 · 表情映射

丘丘用 Emotion Ball 的 `emotionId`。映射由 `packages/character` 维护，`design/` 定规范。

### 状态表情

| 状态 | emotionId | Emotion Ball 名 |
|---|---|---|
| `idle` | `02` | 待机放空 |
| `listening` | `35` | 等待输入 |
| `thinking` | `30` | 思考中 |
| `speaking` | `39` | 输出回复 |

状态表情最短停留 **500 ms**，只约束表情不约束状态语义——气泡文字、音频播放、网络请求全部不等。

### 事件表情

事件表情**优先于状态表情**，持续 **1600 ms**，之后回到「当前」状态的表情（不是进入事件时的那个状态）。**不排队**：期间来新事件立即覆盖并重置计时；同一时刻到达多条取优先级最高的，相同优先级取后到的。

| 触发 | 判定 | emotionId | Emotion Ball 名 | 优先级 |
|---|---|---|---|---|
| 请求出错 | SSE / WS `error` 事件 | `34` | 出错 | 90 |
| 回复含拒绝 | `done` 后对全文跑 `design/emotion-rules.md` § 4 的拒绝式 | `38` | 拒绝/受限 | 80 |
| `recall`（下探冷存储） | `payload.cold_promoted.length > 0` | `40` | 检索资料 | 70 |
| `recall`（命中） | `payload.hits.length > 0` 且 `cold_promoted` 为空 | `37` | 复述回忆 | 60 |
| `merge` | `type === "merge"` | `19` | 满意 | 50 |
| `write` | `payload.facts.length > 0` | `10` | 开心 | 50 |
| `filter.uncertain` | `payload.decision === "uncertain"` | `11` | 疑惑 | 40 |
| 情绪推断 | `done` 后对全文跑 `design/emotion-rules.md` | `10`–`21` 之一 | — | 30 |
| `filter.reject` | `payload.decision === "reject"` | **不切换** | — | — |
| `filter.accept` | `payload.decision === "accept"` | **不切换** | — | — |
| `recall`（空命中） | `hits` 与 `cold_promoted` 都为空 | **不切换** | — | — |

三条「不切换」的事件仍然照常进记忆侧栏（`design/memory-panel.md`），只是不动丘丘的脸。

**「回复含拒绝」与情绪推断互斥。** 拒绝式命中时跳过情绪推断，不再叠一次表情。

### 引擎自驱

下面三个 ID 不由事件或状态触发，由 `packages/character` 的闲置策略驱动，阈值见 `design/character.md` § 4。列在这里是为了说明丘丘的表情不止上表 12 种。

| 时机 | emotionId | Emotion Ball 名 |
|---|---|---|
| `idle` 满 90 s | `04` | 发呆 |
| `idle` 满 300 s | `00` | 睡眠 |
| 从 `00` 离开 `idle` 的过场 | `01` | 唤醒 |

### 情绪推断

回复文本 → `10`–`21` 区间，由 `packages/character/src/emotion.ts` 负责，17 条规则见 `design/emotion-rules.md`，**无规则命中时回退 `02`**。

### 发声脉动

**`feedEnvelope(rms)` 驱动的是容器级「发声脉动」，不是嘴巴张合。** Emotion Ball 的形象没有嘴，引擎也不暴露逐帧姿态写入口；`design/state-machine.md` 给出的映射曲线作用在容器 `transform` 上。签名不变，语义以本条为准。

`packages/character` 把平滑后的包络值写进 stage 容器的 CSS 变量 **`--qq-voice`**，取值 `0`–`1`、三位小数。`apps/web` 要自定义脉动表现时读这个变量；宿主不引任何 CSS 也能跑，`createQiuqiu()` 造的 stage 元素自带必要内联样式。噪声门、伽马、起落时间常数与逐点取值表见 `design/state-machine.md` § 4。

### 主题色

**主题色不能走 `opts.color`。** 引擎每帧无条件覆写体色，会废掉 `21` 生气变红、`14` 害羞变粉、`34` 出错红白闪。改用公开 API `EmotionBall.config.register()` 打纯数据主题补丁，不改 `vendor/` 任何文件，补丁表见 `design/character.md`。

### 形象

`CharacterLook = 'warm' | 'anime'`，`createQiuqiu(el, { look })` 选一套，`instance.setLook(look)` 中途换、不重建实例。一套形象包含两件事：

| | 改什么 | 在哪 |
| --- | --- | --- |
| 配色 | 32 个表情的体色与眼色 | `EmotionBall.config.register()` 数据补丁 |
| 装扮 | 呆毛 · 蝴蝶结 · 腮红 · 眼高光 · 闪光 | 往引擎画好的 SVG 里插节点 |

两条硬约束：

1. **配色补丁读的是注册表里的 `raw`，也就是上一次补丁的产物，不是上游原文。** 所以每一处覆盖都必须无条件赋成本次的值；写成「原来没有才补」的话，换回上一套形象会留下上一套的颜色。
2. **装扮插在 `bodyG` 里面，不插在 SVG 根上。** 呼吸、点头、生气抖动都写在 `bodyG` 的 `transform` 上，当子节点就自动跟着动。跟眼睛走的两件（眼高光、腮红）每帧抄眼睛的 `transform`：高光整条抄（跟着眨眼一起压扁），腮红只抄平移（跟了缩放会在眨眼时压成一条线）。

页面皮肤（`data-skin`）与形象是两件事：皮肤只覆盖 CSS 令牌，管不到 SVG 里的丘丘。`apps/web/src/skin.ts` 里每个皮肤声明自己对应哪个 `look`。

## 7 · 人格合成规则

```
prompt_persona = identity_block
               + boundary_block
               + (preset_block(sliders) if preset is not None else "")
               + learned_block(learned)
```

- `identity_block` 是常量，**永远在最前**，内容见 `packages/memory/persona.py::IDENTITY`。它写明「你叫丘丘」。没有它，模型被问「你叫什么」只能现编——实测会把记忆里的用户名（「用户名叫赵宁」）改一改说成自己叫「阿宁」
- `boundary_block` 是常量，紧跟其后，内容见 `packages/memory/persona.py::BOUNDARY`
- `preset is None` 时不生成 `preset_block`，**不是**生成一个「中等」块
- `learned_block` 覆盖 `preset_block` 里的同名维度（例如 learned 里有 `reply_length`，就覆盖 sliders.verbosity 的描述）
- 合成结果写热存储 `persona_snapshot`，`PersonaService.current()` 只读快照
- 快照连同 `persona.snapshot_version` 一起存。它是**合成逻辑与固定文案的版本**（`persona.py::SNAPSHOT_VERSION`）：快照是「代码 + 设置」的物化结果，设置改了会重算，代码改了不会——改完 `IDENTITY` 的文案，老库里的快照还是旧的。版本对不上就重算。任何影响合成结果的代码改动都要把它 +1

## 8 · 版本与兼容

契约文件顶部维护版本号。破坏性改动升主版本，各分支在 PR 描述里声明依赖的契约版本。

当前：**v0.1.15**（表情只有一个来源）

v0.1.15 一条：**§ 2 增 `pokePet` 与 `onPoke`**。闲置推进从桌宠挪到主窗口（桌宠传 `idle: false`）——表情只能有一个来源，桌宠自己推进闲置的话它会照自己的计时器睡过去而主窗口那只还醒着。挪过去之后主窗口看不见「用户在动桌宠」，所以点 / 拖 / 展开都报一声，主窗口据此复位闲置计时。

v0.1.14（桌宠只显示，不自己拼字）

v0.1.14 三条：

- **§ 2 `forwardDelta` / `onDelta` 改为 `forwardReply` / `onReply`**，推**这一轮到此为止的全文**而不是增量。桌宠自己拼字等于第二套消息处理：漏一条、顺序错一次，两个窗口显示的话就不一样了。推全文还能按帧合并——原来一个字一条 IPC，桌宠每个字量一次气泡高度、主进程每个字 resize 一次窗口，回复一个字一个字地爬
- **§ 7 增 `identity_block`**，排在 `boundary_block` 之前，写明「你叫丘丘」
- **§ 2 增 `onPetGaze`**（见 v0.1.13 条目，补记）

v0.1.13（桌宠气泡与首句不丢）

v0.1.13 四条：

- **§ 2 增 `onPetGaze`**。桌宠的眼神跟随。桌宠窗口鼠标穿透且只有 200 px，渲染进程只在光标压在丘丘身上时才收得到 `pointermove`，「鼠标在屏幕另一头」它根本不知道。Electron 没有全局鼠标事件，只有 `screen.getCursorScreenPoint()` 这个同步查询，所以由主进程按 30 Hz 轮询、减去球心再推下来

以下三条都是修 bug 补的：

- **§ 2 所有 `onX` 改为返回退订函数**。只订不退，开发模式下 effect 跑两遍就订两份，桌宠气泡里一条 delta 拼两遍，回复成了每个字重复

- **§ 2 增 `setPetBubble`**。桌宠窗口透明无边框，画在窗口外的一律被裁掉；气泡钉在丘丘上方而收起态窗口只有 200 px 高、丘丘正好占满，于是气泡整块在窗口外，只在顶边露出一条。窗口高度必须由渲染进程量出的气泡高度撑开，球心保持不动
- **§ 2 增 `mainReady`**。`ensureMain()` 只是把主窗口建出来，渲染进程要几百毫秒后才挂上监听，在那之前 `webContents.send` 是丢的——桌宠里打的第一句话就这么没的。主进程攒着，等这一声再送

v0.1.12（形象与皮肤同步）

v0.1.12 两条：

- **§ 6 增「形象」小节**，定义 `CharacterLook` 与配色 / 装扮两层，以及重打补丁必须无条件覆盖这条硬约束
- **§ 2 增 `setSkin` 与 `onSkin`**。两个窗口是两个渲染进程，各自一份 `localStorage`，主窗口换了皮肤桌宠收不到，只能过主进程转

v0.1.11（IPC 增通话转发）

v0.1.11 一条：**§ 2 增 `callFromPet` 与 `onCallFromPet`**。

界面上「同时按住 C 和 A」拨通话。桌宠窗口按了这个和弦，不自己跑语音会话——
麦克风与音频播放只该有一份，两个窗口各开一个会互相抢。所以桌宠只发请求，
主窗口接住并真正开会话（与 `submitFromPet` 同一个道理，AD-5）。

和弦用 `KeyboardEvent.code` 判定，切输入法与大写锁定都不影响；焦点在输入框里
时不触发——拼音打「擦」「猜」都会让这两个键短暂同时按下。

v0.1.10（音色选择）

v0.1.10 一条：**增 `GET /voices` 与 `GET/PUT /config/voice`**，让用户在界面上选音色。

- 只列女声，丘丘的设定如此
- `id` 是**稳定短名**（`vivi`、`xiaohe`），不是供应商音色 ID。同一个音色在两条链路上
  ID 不一样（级联是 `*_uranus_bigtts`，端到端是 `*_jupiter_bigtts`），映射关系收在
  `qiuqiu_models.voices` 里，前端与契约都不碰供应商 ID
- `realtime_supported` 为假的音色，在端到端链路上回退默认音色——实时语音的精品音色
  只有四个，多数音色没有对应项
- 选中值存 SQLite `settings` 的 `voice` 键，归后端写（§ 7 数据归属表）

v0.1.9（`RealtimeEvent` 增 `interrupt` 类型与 `sample_rate` 字段）

v0.1.9 两条，都来自接豆包端到端实时语音时发现的缺口：

1. **`RealtimeEvent` 增 `interrupt` 类型**。真实协议里服务端用 `ASRInfo` 通知「听到用户首字」，客户端据此停播。契约原先只有客户端 → 服务端的 `interrupt()` 方法，没有反方向的信号。而**能打断正是端到端语音相对级联链路的主要优势**，缺了它这条链路就只剩延迟低一点
2. **`audio` 事件增 `sample_rate`**。端到端下行固定 24k，级联 TTS 是 16k。`AudioChunk` 本来就带这个字段，`RealtimeEvent` 漏了——前端拿 16k 去播 24k 的音频，声音会又慢又闷

v0.1.8（收编 `backend` 十三条与 `frontend` 十四条，去重合并为二十条）

v0.1.8 逐条裁决。**两条否掉了分支的权宜做法**，其余采纳：

**§ 1 路由与事件**

1. `/events` 的 SSE 帧不写 `event:` 名，`id:` 行写 `event_log` 自增 id。前端一个 `onmessage` 收下按 `type` 分发，比四次 `addEventListener` 省事；`id:` 让浏览器断线重连自动带 `Last-Event-ID`
2. 游标**严格大于**。两个分支各自猜了一种，不写死必然对不上
3. 补 `GET /sessions` 与 `GET /sessions/{id}/messages`。两个分支都报了同一条：`sessions` `messages` 表归后端写，前端却没有路由读，刷新就丢历史。只读，写入仍只经 `/chat`
4. `POST /current-model` 定为 `{ capability, model }` → `{ capability, model, provider }`。前端猜的是 `{ capability, provider, model? }`，以后端为准——选路只看 `.env`（AD-8），`provider` 是结果不是入参
5. `POST /compare` 定形。一条配置只有「带不带记忆与人格」一个旋钮，且**不 ingest 不落 messages**：同一句跑两遍写两次等于把它记重了
6. `GET /scenarios` 与 `POST /scenario/{name}/play` 收编进契约，加 `speed`。原先只在 `scenarios/README.md` 里，前端只能把四个场景名写死
7. `uncertain` 那张卡的「留下 / 丢掉」按钮**推迟到 M3**，本轮不定路由。`design/memory-panel.md` 要求这两个按钮，前端也画出来了；但 v0.1.7 第 3 条定的「`uncertain` 只发事件不落库」意味着事件里只剩 `input_preview`——80 字截断带省略号。照它「留下」，存进记忆的就是被截断的半句话，比按钮点不动更糟。真要做，得先定「拿不准的原文停在哪里等用户决定」，那是 M3 记忆闭环的事。这是 v0.1.7 第 3 条的连带后果，当时没追到底
8. `DELETE /memories/{id}` 与 persona 三条写接口都返回改完的完整对象，省前端一次回读
9. `POST /blobs` 的 `kind` 按 `Content-Type` 猜、表单可覆盖，响应加 `kind` 与 `bytes`

**§ 2 IPC——七条，不补桌宠跑不起来**

10. `onDone` `onSubmitFromPet` 补上。原先 `forwardDone` 与 `submitFromPet` 有发无收，**AD-5 的链路断在这里**：桌宠发的话主窗口接不住
11. `setPetPassthrough` `setPetExpanded` `popupPetMenu` 补上。鼠标穿透、改窗口尺寸、弹原生菜单，透明窗口里渲染进程自己都做不了
12. `onPetFocus` `onAmbientToggle` 补上。全局快捷键唤起后要展开输入条；被动采集的暂停开关托盘与右键菜单共用，两个渲染进程都要知道

**§ 3 门面——两条否掉分支的做法**

13. **否掉「环境音一律记成 `user`」**。`speaker` 取值增 `ambient`。`multi-person`（客厅里有三个人）是四个演示场景之一，把三个人的话都记成用户自己说的，记的就是错的。说话人分离推迟
14. **否掉「VAD 拦下的片段不发事件」**。补 `MemoryFacade.note_filter()`。VAD 在后端，被它拦下的片段中间件根本看不到，于是不发 `filter` 事件——可 `ambient-noise`（99% 是废话）这个演示要看的正是这些拒绝，侧栏会是空的。「记忆过程看得见」排第一质量属性，最常见的那类拒绝不能没有痕迹
15. `subscribe()` 改为**调用时同步注册**。原先注册发生在第一次 `__anext__`，后端只能靠 `await asyncio.sleep(0)` 让两次去等它，实测一次就够、两次是余量——但这把后端的正确性绑在中间件的内部实现上，正是契约要防的事。注册与补发之间有窗口就会**静默丢事件**

**其余**

16. `/ingest` 的 audio 附件失败与 Vision 对齐：不生成转写，原话照常进 prompt 与 ingest
17. `ingest()` 只收一个 `blob_id`，多附件挂第一个。收复数推迟
18. `/voice/session` 在级联能力缺失时仍返回成功与 `mode`，错误在 WS 上以 `error` 帧报出，`/health` 的 `missing` 里也看得到
19. `providers` 表本轮零读写。供应商配置住 `.env`，表保留，M5 接界面配置时再启用
20. 桌宠窗口位置属于**纯本地 UI 状态，不进后端**。写 Electron `userData`，不占 `settings` 表

历史：

- v0.1.6 — § 6 重写：事件表情表补判定条件列与优先级列，补 `filter.accept` 与 `recall` 空命中两行「不切换」，事件表情持续时间定为 1600 ms，写明拒绝式与情绪推断互斥、情绪推断无命中回退 `02`，补引擎自驱的 `01` `04` `00`，写明发声脉动的 CSS 变量名 `--qq-voice`

v0.1.7 十一条，全部来自 `memory` 分支报上来的缺口，逐条裁决：

1. **`ingest()` `recall()` 增 `trace_id`**。ARCHITECTURE 第 7 节要求一条 trace 贯穿 `ingest`、事件信封与 `run_metrics`，但 § 3 的签名里没有入口，中间件只能自己生成。后果是一次 `/chat` 与它触发的 `recall` / `write` / `merge` 事件挂在不同 trace 上，侧栏串不起「这一轮记了什么」——而「记忆过程看得见」是第一质量属性。缺省仍由中间件生成，不破坏现有调用
2. **`IngestResult` 增 `decision` 与 `summary`**。`POST /ingest` 的响应体要回 `decision`，契约的返回值里没有；`JOURNAL` 「另出摘要」也没有承载字段
3. **`uncertain` 只发事件不落库**。§ 1 定了三种 decision，但只有 `accept` 与 `reject` 写了后续行为。裁决理由写在 § 3：错记要用户手动删，比漏记贵
4. **`DELETE /memories/{id}` 落到 `edit_visible(mid, deleted=True)`**。§ 3 五个方法里没有删除，后端只能猜
5. **`persona_snapshot` 的落点**定为 SQLite `settings` 的 `persona.snapshot` / `persona.preset` / `persona.sliders` 三个键。ARCHITECTURE 第 7 节只说它是热存储，§ 5 的八张表里找不到它
6. **`visible_memory.layer` 的含义**定为稳定度三层：`L0` 身份 / `L1` 偏好 / `L2` 近况。原先只定了取值域，前端没法分组显示
7. **`PersonaService` 增 `reset_learned()`**。§ 1 有 `POST /persona/reset-learned` 路由，§ 3 没有对应方法
8. **降冷入口**定为 `qiuqiu_memory.pipeline.tiering.nightly(runtime)`。AD-10 说判断标准由 memory 定、执行由 data 做，但没写后端该调哪个
9. **`Source` 增 `PERSONA`**。性格沉淀要往冷表写一条性格档案，原四个取值都不合适，先前归到 `journal` 会污染日记。中间件内部用，调用方不传
10. **`lance.mark_superseded` 的签名以实现为准**：一次一条，`(fact_id, superseded_by=None, valid_to=None, tier="hot")`。文档原先写的是复数 `ids` 且参数顺序不同，批量作废在这一层没有真实需求，改文档对齐实现
11. **`sqlite` 增 `list_recent_messages(limit)`**。性格沉淀要跨会话的最近 N 条，现有 `list_messages` 按 `created_at` 升序且限定单会话，直接取会拿到最早 N 条，正好相反；中间件只能列全部会话各自翻到尾再滚窗口

另外把「`ingest()` 与 `recall()` 是同步方法、后端要 `asyncio.to_thread`」写进 § 3——三个分支都会踩。

- v0.1.5 — `recall.hits[]` 与 `merge.absorbed[]` `invalidated[]` 增 `text`，否则侧栏只能显示 id，「记忆过程看得见」这条第一质量属性落空；补 `/config/thresholds` 的 body schema；§ 6 写明 `feedEnvelope` 是容器脉动不是嘴巴，以及主题色不能走 `opts.color`

- v0.1.4 — 补齐 `facts` 的 `speaker` `source` 与 `visible_memory.layer` 取值域；点明向量维度是破坏性契约；新增「数据层接口」小节

- v0.1.3 — `run_metrics` 增 `provider` 列；补 `GET /providers` 响应体；§ 4 定死 `stream()` / `synthesize()` 的异步形状为「await 后 async for」；§ 4 补齐六个数据类的字段与错误约定
- v0.1.2 — 契约地位说明；`/chat` 增 `audio` 事件；增 `/voice/session` 与 `WS /voice/stream`；事件 `id` 与游标的对应；`recall()` 增 `now`
