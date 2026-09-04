# 后端 Agent · `backend`

FastAPI 服务：路由、对话编排、SSE、事件总线出口、被动采集入口。

## 目录

`services/api/`。

## 先读

- `docs/ARCHITECTURE.md` § 3 系统边界、§ 4 解决方案策略、§ 6 运行时视图、§ 8 架构决策
- `docs/CONTRACTS.md` § 1 全部、§ 3 MemoryFacade、§ 4 模型接口
- `packages/memory` 与 `packages/models` 的导出（等它们合并后；之前用 mock）

## 功能清单

### 路由（`services/api/routes/`）

- [ ] `POST /chat` SSE，事件 `meta / delta / done / error` 严格按契约
- [ ] `GET /events` SSE，`since` 游标续传，多客户端广播
- [ ] `POST /ingest` 被动采集入口，返回 `trace_id` 与筛选决策
- [ ] `/memories` CRUD，删除级联作废事实
- [ ] `/persona` 四条
- [ ] `/config/thresholds` 读写，热生效
- [ ] `/providers` `/current-model`，密钥不回传
- [ ] `POST /blobs` 文件上传，返回 `blob_id`
- [ ] `/scenario/{name}/play` 按脚本时间轴回放
- [ ] `/compare` 同一 query 跑两条配置，返回 token 与延迟对照
- [ ] `/health`

### 对话编排（`services/api/orchestrator.py`）

- [ ] 拼 prompt：`PersonaService.current()` + `MemoryFacade.recall()` + 本会话最近 N 条
- [ ] 调 `ChatModel.stream()`，逐 delta 转发
- [ ] `done` 后调 `MemoryFacade.ingest()` 两次：用户原话（`speaker=user`）、AI 回复（`speaker=assistant`），`source=DIALOGUE`
- [ ] 附件处理：`image` 类型先调 `VisionModel.describe()` 得描述，描述与原话一起进 prompt 和 ingest
- [ ] 有 TTS 时并行合成，音频块与 `rms` 经 SSE `audio` 事件推给前端
- [ ] 每次调用记 `run_metrics`
- [ ] 语音：`POST /voice/session` 按 `VOICE_MODE` 返回 `mode`，`WS /voice/stream` 上行 pcm，格式按 CONTRACTS § 1。级联：VAD → ASR 流式，下行 `partial` 与 `final`，前端拿 `final` 自行 `POST /chat`。端到端：人格与召回拼进 `system_prompt` 开 `RealtimeVoice`，下行 `final`（两路 role）、`audio`、`turn_end`，收到 `final` 时按 role 各调一次 `ingest()`

### 定时任务（`services/api/scheduler.py`）

- [ ] 每日调 `qiuqiu_memory` 暴露的 `tiering.nightly()` 执行降冷
- [ ] 每次 `ingest()` 后累计对话轮数，达到 `settings.consolidate_every` 时后台调 `PersonaService.run_consolidation()`
- [ ] 场景回放：`clock_offset_days` 转成偏移后的时间，传给 `ingest()` 的 `ts` 与 `recall()` 的 `now`，不改系统时钟

### 事件总线出口

- [ ] 订阅 `MemoryFacade.subscribe()`，广播到所有 `/events` 连接；`event_log` 由中间件的事件总线写，后端不重复写
- [ ] 游标是 `event_log.id`，客户端断线用 `since` 补发

### 被动采集

- [ ] `/ingest` 收到 `ambient_audio`：读 blob → `VAD.evaluate()` → 有语音则 `ASR.transcribe()` → `MemoryFacade.ingest(source=AMBIENT_AUDIO)`
- [ ] `ambient_image`：`VisionModel.describe()` → `ingest(source=AMBIENT_IMAGE)`
- [ ] 常开麦克风的分段：前端切 3 秒片段上传，后端按片段处理

## 约束

- 编排是唯一调 `ChatModel.stream()` 生成回复的地方
- 不在路由里写记忆逻辑，全部经 `MemoryFacade`
- 不在路由里写模型细节，全部经 `qiuqiu_models.registry`
- 所有错误响应带 `hint`

## 验收

- 用 mock 模型：发一句话，SSE 三类事件按序到达，`ingest` 被调两次
- 用真实 DeepSeek：首字延迟 < 1.5s（本地网络）
- `/events` 两个客户端同时连，事件不重不漏；一个断线 30s 后重连，补发无遗漏
- `pytest` 通过，每条路由有冒烟测试

## 受哪些 AD 约束

AD-3、AD-5、AD-6、AD-7、AD-8、AD-13、AD-14、AD-15、AD-16

## 未解决的问题

**开工前必须定**：
- 级联语音的 pcm 上传通道。已定：`WS /voice/stream`，双向，见 CONTRACTS § 1
- 场景回放的 `clock_offset_days` 怎么生效。已定：传偏移后的时间给 `ingest()` 的 `ts` 与 `recall()` 的 `now`，不改系统时钟
- 谁写 `event_log`。已定：中间件事件总线写，后端只读并广播

**边做边定，定完回报**：
- `/compare` 两条配置的参数形式
- 被动采集 3 秒切片的重叠量

## 与其他分支

- 依赖 `memory` 的 `MemoryFacade` 与 `PersonaService`
- 依赖 `models` 的 `registry`
- 依赖 `data` 的 `sqlite.py`：`sessions` `messages` `settings` `providers` `run_metrics` 直接读写，`event_log` 只读
- `frontend` 依赖你的路由与事件格式，改格式先改 CONTRACTS
