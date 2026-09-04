# 后端 Agent · `backend`

FastAPI 服务：路由、对话编排、SSE、事件总线出口、被动采集入口。

## 目录

`services/api/`。

## 先读

- `docs/ARCHITECTURE.md` § 3 对话编排、§ 8 输入、「一次对话的完整链路」
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
- [ ] 有 TTS 时并行合成，音量包络经 `meta` 之外的 `audio` 事件推给前端
- [ ] 每次调用记 `run_metrics`

### 事件总线出口

- [ ] 订阅 `MemoryFacade.subscribe()`，每条事件写 `event_log` 并广播到所有 `/events` 连接
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

## 与其他分支

- 依赖 `memory` 的 `MemoryFacade` 与 `PersonaService`
- 依赖 `models` 的 `registry`
- `frontend` 依赖你的路由与事件格式，改格式先改 CONTRACTS
