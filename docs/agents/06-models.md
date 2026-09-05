# 模型 Agent · `models`

模型能力的统一适配层。上层只 import 抽象接口，供应商实现可替换。

## 目录

`packages/models/`，包名 `qiuqiu_models`。

## 先读

- `docs/ARCHITECTURE.md` § 3 系统边界、§ 4 模型选型表
- `docs/CONTRACTS.md` § 4 模型适配接口

## 功能清单

### 抽象接口（`qiuqiu_models/base.py`）

- [ ] `ChatModel` `VisionModel` `ASR` `VAD` `TTS` 五个 Protocol，签名严格按 CONTRACTS § 4
- [ ] `Message` `Transcript` `PartialTranscript` `VadResult` `AudioChunk` 数据类

### 注册表（`qiuqiu_models/registry.py`）

- [ ] `get(capability: str)` 按 `.env` 返回实现实例，单例
- [ ] `list_providers()` 供 `/providers` 路由
- [ ] 每个实现记录调用次数、token、延迟到 `run_metrics`

### 供应商实现（`qiuqiu_models/providers/`）

**Chat · DeepSeek**（`deepseek_chat.py`）
- [ ] OpenAI 兼容 `/chat/completions`，流式与非流式
- [ ] 模型 `deepseek-v4-flash`，可配
- [ ] 重试与超时，429 退避
- [ ] 计量 `usage` 字段

**Vision · DeepSeek**（`deepseek_vision.py`）
- [ ] 模型 `deepseek-v4-flash-vision-exp`
- [ ] 接受 bytes（转 base64 data URL）或 http(s) URL
- [ ] `describe(image, prompt)` 返回中文描述

**ASR · SenseVoice**（`sensevoice.py`）
- [ ] 基于 sherpa-onnx Python 绑定，模型 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09`
- [ ] 首次运行自动下载到 `SENSEVOICE_MODEL_DIR`，校验 sha256
- [ ] `transcribe(pcm16k)` 离线整段；`stream(chunks)` 流式，每段返回 partial
- [ ] 输出 `lang` 与 `confidence`

**VAD · silero**（`silero_vad.py`）
- [ ] ONNX 模型，16k 采样
- [ ] `evaluate(pcm16k)` 返回 `has_speech` `energy` `confidence`
- [ ] 阈值从 `/config/thresholds` 读，热更新

**TTS · Azure**（`azure_tts.py`）**已完成**
- [x] Azure 语音服务 REST 接口，端点 `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`
- [x] 输出 `raw-16khz-16bit-mono-pcm`，裸 PCM 直接就是 `AudioChunk` 要的形状，不用解码
- [x] `synthesize()` 返回 `AudioChunk` 流，上游分片重切成 20ms 定长块（不重切的话 rms 会抖）
- [x] 默认音色 `zh-CN-XiaoxiaoNeural`，`AZURE_TTS_VOICE` 可换
- [x] SSML 转义用户文本；错误按状态码给不同 hint

音色与 Edge 朗读同一批——`zh-CN-XiaoxiaoNeural` 本来就是 Azure 的音色名，Edge 背后调的
就是这个服务。这里走官方接口带自己的订阅密钥，可用于产品。F0 档每月 50 万字符免费。

**换别家 TTS**（可选）
- [ ] 火山、阿里等只是多一个 `<vendor>_tts.py`，`TTS` 协议不变
- [ ] 由 `TTS_PROVIDER` 选，缺 key 时 registry 抛带 hint 的错（AD-16，不静默换 mock）

**Image Gen · Seedream**（`seedream.py`，可选）
- [ ] 火山方舟 `/images/generations`
- [ ] 只在 `VOLC_ARK_API_KEY` 存在时注册

**RealtimeVoice · 豆包**（`doubao_realtime.py`，可选）
- [ ] 火山引擎端到端实时语音 WebSocket 接入，签名按 CONTRACTS § 4 `RealtimeVoice`
- [ ] `open()` 时把系统提示（含人格与召回）传入；`events()` 分发 audio / transcript / turn_end
- [ ] `interrupt()` 发打断信号并清空本地播放队列
- [ ] 只在 `VOLC_ARK_API_KEY` 存在且 `VOICE_MODE=realtime` 时注册
- [ ] 计量音频 token 到 `run_metrics`

**Mock**（`mock.py`）
- [ ] 六种能力各一个 mock，固定输出，零延迟；`RealtimeVoice` 的 mock 把输入音频原样回放并给固定转写
- [ ] `MODELS_MOCK=1` 时 `registry` 全部返回 mock，供其他分支离线开发

## 约束

- 上层不能 import `providers/` 下任何东西，只能经 `registry`
- `VOICE_MODE=cascade` 时 `registry.get("realtime")` 返回 None，编排走级联
- 真实供应商测试标 `@pytest.mark.live`，CI 不跑
- 密钥只从环境变量读，不写日志
- ASR 与 VAD 必须能完全离线运行

## 验收

- `MODELS_MOCK=1` 下五种能力 `registry.get()` 都返回 mock，调用不出网
- 真实 key 下 `ChatModel.stream()` 首字 < 1s
- SenseVoice 识别 10 秒中文音频，字准率 > 90%（用公开测试集一段）
- silero 对 1 秒静音返回 `has_speech=False`，对 1 秒人声返回 `True`
- Azure 合成 20 字中文，`AudioChunk` 的 `rms` 序列非零且随语音起伏
- `pytest` 通过

## 受哪些 AD 约束

AD-8、AD-13、AD-16

## 未解决的问题

**开工前必须定**：
- mock 是否记 `run_metrics`。已定：记，`provider` 字段为 `mock`
- 权重下载源。已定：SenseVoice 与 silero 各自从 GitHub releases 下载，校验 sha256

**边做边定，定完回报**：
- SenseVoice 流式分段长度
- 长文本要不要切句并行合成（现在是整段一次请求）

## 与其他分支

- `memory` 用 Chat
- `backend` 用全部能力
- `data` 无依赖
