# 阶段一：按架构文档规范重排文档

你是 docs/agents/00-orchestrator.md 里的主调度 Agent，在仓库根目录工作。这一阶段只改文档，不写代码。

## 先读

docs/ARCHITECTURE-STANDARD.md（规范）、docs/ARCHITECTURE.md、docs/CONTRACTS.md、docs/CONVENTIONS.md、README.md、docs/agents/*.md、docs/PROGRESS.md、.env.example、scenarios/README.md。

## 若已完成

先检查 git log 是否已有提交信息含「按架构文档规范重排」，且 docs/ARCHITECTURE.md 已有「## 8 · 架构决策」节。已完成就只确认七个分支与 main 一致，然后 `mkdir -p .run && touch .run/01-restructure.done` 并退出。

## 已定的事，照做，不重新讨论

1. 质量属性排序（规范第 1 节）：记忆过程看得见 > 首字延迟 > 成本 > 断网能用。
2. 契约与快照（规范第 4 节）：本项目七个分支并行开发，跨块共享的接口签名与数据表字段属于契约，不属于快照；全部分支合入 main 之前以 docs/CONTRACTS.md 为准。快照标注只加在：README 技术栈表、README 目录树、ARCHITECTURE.md 第 4 节的模型选型表。把这条写进 docs/ARCHITECTURE-STANDARD.md 第四节，替换原来把接口签名和数据表字段列为快照的说法。
3. 构建块（规范第 5 节）按分支分：design / frontend / backend / data / memory / models / character 七块，每块一个条目，用规范第五节模板，一栏不省。人格并入 memory 条目，输入（被动采集）并入 backend 条目。design 的「对外接口」是它交付的文档。原来的八层划分挪到第 4 节解决方案策略，控制在一页，每层标注落在哪个块。docs/product-map.html 与 docs/architecture.html 不改。
4. 第 5 节配一张 mermaid 依赖方向图，与 00-orchestrator.md 的依赖图一致；00-orchestrator.md 里的图也改成同一张 mermaid。
5. 架构决策编号固定如下，写法按规范第三节（约束范围 / 防止的分歧 / 规则 / 状态：已采纳），不写理由：
   - AD-1 状态机切换不经过后端
   - AD-2 当前人格读热存储快照，不在请求路径合成
   - AD-3 主动输入跳过筛选仍压缩，被动采集必筛
   - AD-4 性格沉淀读 SQLite 原始会话，不读记忆库
   - AD-5 桌面端只有主窗口持有 SSE，桌宠窗口经 IPC 收转发
   - AD-6 AI 回复也写入记忆
   - AD-7 记忆读写只经 MemoryFacade 五个方法与 PersonaService，服务层不碰存储
   - AD-8 模型调用只经 qiuqiu_models.registry，上层不 import providers
   - AD-9 事实不物理删除，作废写 valid_to 与 superseded_by
   - AD-10 冷热分层按访问频率与时效，30 天未命中降冷，冷命中整体回热
   - AD-11 预设为空是真空，不注入任何滑块值
   - AD-12 人格合成顺序预设打底 → 相处覆盖 → 边界否决，边界是代码常量
   - AD-13 语音模式由编排选路，记忆中间件不感知 cascade 与 realtime 差异
   - AD-14 记忆各环节的判断以事件外发，事件是界面可见性的唯一数据源，前端不自行推断
   - AD-15 图片描述由后端调 Vision 生成，进入中间件的只有文本与 blob 指针
   - AD-16 出网调用失败返回带 hint 的错误，不静默降级为 mock

   现有六条决策的理由移到新文件 docs/DECISION-LOG.md，一行一条：AD 编号、理由。其余 AD 理由不编，不写。
6. 第 3 节系统边界，出网依赖全列，每条写调用方与失败处理：
   - DeepSeek Chat：调用方 编排、记忆中间件。失败重试 2 次（1s、4s）；编排仍失败 → SSE error 带 hint；中间件仍失败 → 本次 ingest 返回空 accepted，记 run_metrics，原始消息仍在 messages 表，不重试。
   - DeepSeek Vision：调用方 后端（编排处理附件、/ingest 处理 ambient_image）。主动附件失败 → 不生成描述，原话照常进 prompt 与 ingest，blob_id 保留；被动图片失败 → /ingest 返回 error 带 hint。
   - Seedream：调用方 编排。失败 → 回复文字说明本次画不了，不重试。
   - 豆包端到端实时语音：调用方 编排。连接失败或中断 → /voice/session 返回 error 带 hint，前端提示切文字。
   - edge-tts（speech.platform.bing.com）：调用方 编排。失败 → 无语音，口型不动，文字照常，本次不重试。
   - 模型权重下载（HuggingFace 的 Qwen/Qwen3-Embedding-0.6B；GitHub k2-fsa 的 SenseVoice；silero-vad）：调用方 models 注册表初始化与 memory 嵌入初始化，只在首次运行。embedding 缺失 → 后端启动失败，hint 给 HF_ENDPOINT 镜像与手动放置路径；ASR 或 VAD 缺失 → 语音输入不可用，其余照常，/health 报告缺失项。
   - Emotion Ball 四个 JS 文件 vendor 进仓库，不出网。LanceDB、SQLite、磁盘文件在系统内。

   同时改掉 ARCHITECTURE.md 现有「唯一出网的是模型调用」这句；改掉模型表里 Vision 的调用方（是后端，不是中间件）；改掉 docs/agents/06-models.md 与 05-memory.md 里「memory 用 Vision」的说法（memory 只用 Chat）。
7. 第 6 节运行时视图五条链路，只写跨块步骤：
   - 一次文本对话：沿用现有 11 步。
   - 语音输入级联：按住说话 → 前端切 pcm → 后端 VAD → ASR 流式 partial → final 进编排 → 同文本对话 → TTS chunk → rms 经 audio 事件 → 桌宠口型。
   - 被动采集环境音：前端 3 秒切片 POST /blobs → POST /ingest → VAD → ASR → ingest(AMBIENT_AUDIO) → filter 事件；reject 侧栏打灰且丘丘不切表情；accept 继续压缩合成 → write 事件 → 表情 10。
   - 三个月后问旧事：clock_offset → 检索规划 → 热未命中 → 下探冷 → promote → recall 事件 cold_promoted 非空 → 表情 40 → 回复引用。
   - 性格沉淀：轮数达阈值 → 读 messages → Chat 归纳 → 写 persona_learned 与冷存储 → 快照重算 → 下一轮 prompt 人格段变化。
8. 第 7 节跨领域概念只写这几项：错误格式 {error:{code,message,hint}} 全局统一；trace_id 从 /chat 贯穿 ingest、事件、run_metrics；事件信封；配置只从 .env 读，阈值热更新经 /config/thresholds 存 settings；密钥不进日志不回传前端；每次模型调用记 run_metrics；时间戳 ISO 8601 UTC；数据归属表（每张表或存储：写入方、读取方）：facts_hot/facts_cold 写 memory 读 memory；blobs 写 backend 读 backend 与 memory；sessions/messages 写 backend 读 backend 与 memory；visible_memory 写 memory 读 backend；event_log 写 memory 读 backend；persona_learned 写 memory 读 memory；settings 写 backend 读 backend 与 memory；providers 写 backend 读 backend；run_metrics 写 models 与 backend 读 backend；persona_snapshot 写 memory 读 memory。
9. 第 8 节末尾「已推迟」，每条写为什么能等：火山 TTS 替换 edge-tts（TTS 接口已定，demo 不需正式音色）；Seedream（不在任何演示场景必经路径）；端到端实时语音供应商（RealtimeVoice 接口已定，级联满足 demo）；Windows 打包（开发在 macOS，M6 前验证）；多用户与多设备同步（单机单用户）；嵌入模型替换（契约只定 1024 维）；网页端桌宠窗口形态（网页端丘丘嵌页面）；event_log 清理策略（demo 周期内不触发）。
10. 规范第 2 节要求每条约束注明来源：授权类写许可证，隐私与成本类写「自己定的」，平台类写「平台限制」。
11. docs/agents/01 到 07 各加两节：「受哪些 AD 约束」列编号；「未解决的问题」分「开工前必须定」与「边做边定，定完回报」两档。「开工前必须定」的问题你就是主调度，当场定，把结论写进任务书或 CONTRACTS.md，任务书里保留问题与结论。
12. docs/agents/00-orchestrator.md：冲突仲裁改为按 AD 编号裁决；加一条职责「AD 编号唯一维护者，编号永不重编，废弃留空号」。
13. docs/CONTRACTS.md：顶部加一段契约地位说明（第 2 条的内容），版本升到 v0.1.2。docs/PROGRESS.md：契约版本改成一致；各分支当前里程碑改为 M2、状态未开始；加「下一步」一节，内容「M2 骨架可跑」。
14. docs/CONVENTIONS.md「文档同步」节加两条：AD 编号永不重编；快照表格上方必须有「快照：写于日期，代码存在后以代码为准」标注。
15. README.md 的「先读」顺序改为：ARCHITECTURE.md 第 4、5 节 → CONTRACTS.md → 自己的任务书。

## 写法约束

只写设计，不写评价、不写过程、不写谁决定的，不写「薄」「简单」「可最后做」之类的判断。引用外部来源只写链接。中文。规范里没列的节不新增。ARCHITECTURE.md 节标题用「## 1 · 目标与质量属性」到「## 8 · 架构决策」。

## 完成动作

一次提交，信息「docs: 按架构文档规范重排架构文档、任务书与契约」，不署名 AI。推 main，然后把 design、frontend、backend、data、memory、models、character 七个分支强制对齐到 main（git branch -f 与 git push -f origin）。最后 `mkdir -p .run && touch .run/01-restructure.done`。
