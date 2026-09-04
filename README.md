# 丘丘 · 桌面 AI 桌宠

一个常驻桌面的 AI 伙伴：会记住你说过的话、性格随相处慢慢长出来、每一次「记住 / 没记 / 想起来」都让你看得见。

角色形象引用自 [Emotion Ball](https://github.com/sam70361/aora-bot)；记忆层按 [Omni-SimpleMem](https://arxiv.org/abs/2604.01007) 实现。

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
| 语音合成 | edge-tts（demo）→ 火山引擎（正式） |
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
pnpm dev                    # 同时起后端 8000、前端 5173、Electron
```

## 授权约束

丘丘的**视觉形象**引用自 Emotion Ball，仅供个人学习研究，**禁止商业用途且永不提供商业授权**。表情引擎代码与配置数据为双许可（非商业免费，商业可授权）。本项目当前为非商业 demo；若转为产品，形象必须替换，引擎需另行取得授权。详见 [docs/ARCHITECTURE.md § 2 约束](docs/ARCHITECTURE.md#2--约束)。
