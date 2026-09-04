# 记忆 Agent · `memory`

记忆中间件与人格层。核心引用 [SimpleMem](https://github.com/aiming-lab/SimpleMem)（MIT，`pip install simplemem`），在它之上加：事件总线、主动/被动双路径、冷热联动、性格沉淀、人格合成。

## 目录

`packages/memory/`，包名 `qiuqiu_memory`。

## 先读

- `docs/ARCHITECTURE.md` § 4 记忆中间件、§ 7 人格
- `docs/CONTRACTS.md` § 3 MemoryFacade、§ 5 数据模型、§ 7 人格合成
- SimpleMem 的 `docs/text-memory.md` 与 `simplemem/multimodal/triggers/`
- `packages/data` 的接口

## 功能清单

### MemoryFacade（`qiuqiu_memory/facade.py`）

五个方法签名严格按 CONTRACTS § 3。

- [ ] `ingest()`：按 `source` 分流——`DIALOGUE` / `JOURNAL` 跳过筛选直接压缩；`AMBIENT_*` 先过筛选
- [ ] `recall()`：调检索规划 → 先热后冷 → 命中冷条目调 `data.tiering.promote()` → 返回 `cold_promoted`
- [ ] `list_visible / edit_visible`：读写 SQLite `visible_memory`，删除级联 `mark_superseded`
- [ ] `subscribe()`：异步生成器，从事件总线取

### 六个环节（`qiuqiu_memory/pipeline/`）

- [ ] `filter.py`：封装 SimpleMem 的 `AudioEntropyTrigger` / `VisualEntropyTrigger` / Jaccard 去重；输出统一 `FilterDecision { decision, score, reason }`；**每次判断发 `filter` 事件**
- [ ] `compress.py`：调 SimpleMem 压缩（代词解析、时间绝对化、拆原子事实）；`JOURNAL` 额外生成一段摘要；记录 `dropped_spans`；**发 `write` 事件**
- [ ] `synthesize.py`：同义合并，旧事实写 `valid_to` 与 `superseded_by`；**发 `merge` 事件**
- [ ] `retrieve.py`：检索规划器（调 Chat 判断意图、选路径、定深度）→ 三路并行 → 并集去重 → 按 `Budget` 截断；**发 `recall` 事件**，含 `skipped_paths`
- [ ] `tiering.py`：`recall` 命中冷条目时调 `data.promote`；暴露 `nightly()` 给调度器
- [ ] `consolidate.py`：性格沉淀，见下

### 事件总线（`qiuqiu_memory/bus.py`）

- [ ] 进程内 `asyncio.Queue`，`publish(event)` 不阻塞主流程
- [ ] 每条事件同时写 `data.sqlite.event_log`
- [ ] 信封与 payload 格式严格按 CONTRACTS § 1

### 人格（`qiuqiu_memory/persona.py`）

- [ ] `BOUNDARY` 常量：三条安全边界的 prompt 文本
- [ ] `PRESETS`：四个预设对应的滑块值（CONTRACTS § 7 表）
- [ ] `PersonaService.current()`：读热存储 `persona_snapshot`，没有则合成一次并缓存
- [ ] `set_preset(None)` 时 `preset_block` 为空字符串，**不是**中等值
- [ ] `learned_block` 覆盖同名维度
- [ ] `run_consolidation()`：性格沉淀

### 性格沉淀（`qiuqiu_memory/pipeline/consolidate.py`）

- [ ] 输入：`data.sqlite.messages` 最近 N 轮（默认 50）原始会话，**不读 facts 表**
- [ ] 调 Chat 归纳四个维度 + 称呼习惯 + 话题偏好，输出 `Learned`
- [ ] 与上一版 `persona_learned.latest()` 做增量合并（新值覆盖，缺失沿用）
- [ ] 写 `persona_learned` 新版本，写冷存储性格档案
- [ ] 触发 `PersonaService` 重算快照
- [ ] 触发条件：累积对话轮数达阈值（`settings.consolidate_every`，默认 20）

## 约束

- 主动输入（`DIALOGUE` `JOURNAL`）**不进筛选**
- 性格沉淀**只读 `messages` 表**，不读记忆库
- 不物理删除任何事实
- 所有调模型的地方经 `qiuqiu_models.registry.get("chat")`，不直接 import 供应商
- 不在这一层碰 HTTP、SSE、IPC

## 验收

- 「我叫赵宁，我喜欢喝美式咖啡。用一句话介绍你自己。」→ `ingest` 产出两条事实（名字、偏好），`dropped_spans` 含指令部分，`write` 事件字段完整
- 三条碎片「想喝咖啡」「喜欢燕麦奶」「喜欢热的」→ `synthesize` 合成一条，旧三条 `valid_to` 非空，`merge` 事件正确
- 「我搬到深圳了」→ 旧的「住北京」事实被 `superseded_by`，`recall("周末去哪")` 只回深圳
- 环境音喂 10 段（8 段静音 2 段说话）→ 8 个 `filter.reject` 带 `Silence detected` 理由
- 50 轮对话后 `run_consolidation()` 产出 `Learned`，快照重算，`current()` 输出变化
- `pytest` 通过，含 CONTRACTS 契约测试

## 与其他分支

- 依赖 `data` 全部接口、`models` 的 Chat 与 Vision
- `backend` 依赖你的 `MemoryFacade` 与 `PersonaService`
