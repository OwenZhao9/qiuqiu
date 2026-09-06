# 丘丘 · 桌面 AI 桌宠

一个常驻桌面的 AI 伙伴：会记住你说过的话、性格随相处慢慢长出来、每一次「记住 / 没记 / 想起来」都让你看得见。

角色形象引用自 [Emotion Ball](https://github.com/sam70361/aora-bot)；记忆层按 [Omni-SimpleMem](https://arxiv.org/abs/2604.01007) 实现。

## 它能做什么

> 快照：写于 2026-09-06，代码存在后以代码为准。

**记住你说过的话。** 每一轮对话，你说的和丘丘答的都会被拆成一条条事实存下来；
下一次提问先去记忆里捞，捞到的塞进上下文再回答。三路并行检索：按意思（向量）、
按字面（BM25）、按标签。存储分热冷两层，冷的按需回热。

**记忆过程看得见。** 主窗口顶上那条图画的就是这套管线。发一句话，哪一段正在处理
哪一段就亮，走完就熄——检索、合并去重、按 token 预算截断、生成答案，然后是把这轮
对话记下来的那半截。数据全部来自后端发的事件，没发生的不会亮。

**装完就是可爱的。** 出厂皮肤是卡哇伊粉、出厂人格是 `cute` 预设（主动性 65、
话量 55、情绪浓度 80、幽默 75）。这不是硬编码在某个组件里的字面量，是一张
出厂表（`packages/character/src/defaults.ts` + `persona.py::FACTORY_PRESET`，
契约 § 9）：改一个值全栈跟着变，两边各有一条对着契约读的测试盯着不许飘。

出厂值是**种子不是兜底**——空库第一次启动种进去，之后你改成什么就是什么。
把人格清成真空（AD-11）它不会在下次启动偷偷变回可爱。

**一张会变的脸。** 32 个表情接了 23 个：待机、发呆、睡着、按下发送时点个头、
思考、说话、听你说、记住一条、想起旧事、翻冷存储、出错、拒绝。还会按回复内容
推断情绪——开心、害羞、生气、无奈、困惑等 9 种。身体也跟着动：说话时点头，
思考时左右晃，蝴蝶结慢半拍跟上。

**表情不经过模型。** 两个方向都断开：发给模型的 prompt 里没有任何表情信息
（它不知道脸上在演什么，也就无从配合着演）；模型也没有输出表情标记的口子，
它写的括号旁白在后端就被滤掉了。回复全文回来之后，由本地的两张规则表
（关键词表 + 记忆事件表）判出该演哪个表情。32 个表情的调度权整个在这套系统里，
模型只负责说话。

**常驻桌面。** 桌宠窗口鼠标穿透、可拖、眼球跟着光标转、球面高光跟着挪。
回复浮在它右上角的漫画对话框里。可以直接在桌宠上打字，话交给主窗口发。
`Cmd/Ctrl + Shift + E` 随时唤起。

**打电话。** 端到端实时语音，说话的同时它也能说，随时可以打断。点「通话」或者
同时按住 `C` 和 `A`。通话中它在听 / 在想 / 在说，脸上分得出来。

**发图片。** 拖进输入框、粘贴、或者点「图片」按钮，一条最多 4 张。发出去的图留在
聊天记录里，重开窗口还看得见。

**它会开口。** 打字聊天时后端顺手把回复合成成语音放出来，音色跟通话那条共用一份选择。

**说到一半可以喊停。** 回复途中按「停止」，字停在那里、声音同时闭嘴，
已经说出来的那半句照样留在记录里（但不进记忆——那是一句被人为掐断的话）。

**性格会长。** 四个预设加四个滑块（主动性、话密度、情绪浓度、幽默感）；
相处久了它会自己沉淀出一些相处习惯，覆盖预设里的对应项。

## 技术栈

> 快照：写于 2026-09-05，代码存在后以代码为准。

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron 33 |
| 前端 | React 18 · Vite 5 · TypeScript |
| 后端 | Python 3.12 · FastAPI |
| 记忆 | SimpleMem（pip 包）+ 自研事件总线与性格沉淀 |
| 存储 | LanceDB（事实与向量）· SQLite（会话与配置）· 磁盘文件（原图原文） |
| 对话模型 | DeepSeek `deepseek-v4-flash` |
| 图片理解 | DeepSeek `deepseek-v4-flash-vision-exp`（同一个 key） |
| 语音识别 | sherpa-onnx + SenseVoice（本地，离线） |
| 语音活动检测 | silero-vad（本地） |
| 语音合成 | 豆包语音合成 2.0 |
| 嵌入 | Qwen/Qwen3-Embedding-0.6B（本地，1024 维） |
| 实时语音（可选） | 豆包端到端实时语音 |
| 生图（可选） | Seedream |

## 目录

> 快照：写于 2026-09-05，代码存在后以代码为准。

```
qiuqiu/
├── docs/                 架构、契约、规范、各 Agent 任务书
├── design/               设计规范：视觉 · 交互 · 状态机 · 表情映射
├── apps/
│   ├── desktop/          Electron 主进程、preload、窗口管理
│   └── web/              React 前端：桌宠页 + 主窗口
├── services/
│   └── api/              FastAPI：路由、对话编排、SSE、事件总线
└── packages/
    ├── memory/           记忆中间件：MemoryFacade、筛选压缩合成检索、性格沉淀
    ├── data/             存储层：LanceDB + SQLite schema、冷热调度、迁移
    ├── models/           模型适配：Chat / Vision / ASR / VAD / TTS 统一接口
    └── character/        丘丘：Emotion Ball 封装、状态机、事件到表情映射
```

## 分支与分工

每个模块一个分支、一个 Agent，主调度 Agent 守 `main`。任务书在 [docs/agents/](docs/agents/)。

| 分支 | 目录 | Agent 任务书 |
|---|---|---|
| `main` | 集成 | [00-orchestrator.md](docs/agents/00-orchestrator.md) |
| `design` | `design/` | [01-design.md](docs/agents/01-design.md) |
| `frontend` | `apps/` | [02-frontend.md](docs/agents/02-frontend.md) |
| `backend` | `services/api/` | [03-backend.md](docs/agents/03-backend.md) |
| `data` | `packages/data/` | [04-data.md](docs/agents/04-data.md) |
| `memory` | `packages/memory/` | [05-memory.md](docs/agents/05-memory.md) |
| `models` | `packages/models/` | [06-models.md](docs/agents/06-models.md) |
| `character` | `packages/character/` | [07-character.md](docs/agents/07-character.md) |

先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 4、5 节看分层与自己的块，再读 [docs/CONTRACTS.md](docs/CONTRACTS.md) 看接口，最后读自己的任务书。

## 本地跑

```bash
cp .env.example .env        # 填 DEEPSEEK_API_KEY
uv sync                     # Python 依赖
pnpm install                # Node 依赖
pnpm dev                    # 同时起后端、前端 5173、Electron
```

后端默认 8000；这个端口本机最容易被别的项目占掉，占了就自动往后挪（8000–8020），
实际用哪个会打在 `[dev]` 那几行里，并通过 `QIUQIU_API` 传给 Electron。
想钉死端口用 `QIUQIU_PORT=8000 pnpm dev`，被占时直接报错退出。

## 授权约束

丘丘的**视觉形象**引用自 Emotion Ball，仅供个人学习研究，**禁止商业用途且永不提供商业授权**。表情引擎代码与配置数据为双许可（非商业免费，商业可授权）。本项目当前为非商业 demo；若转为产品，形象必须替换，引擎需另行取得授权。详见 [docs/ARCHITECTURE.md § 2 约束](docs/ARCHITECTURE.md#2--约束)。
