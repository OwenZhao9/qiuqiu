/**
 * 后端契约的唯一出入口。
 *
 * `docs/CONTRACTS.md` § 1（HTTP 与 SSE），契约版本 **v0.1.10**。
 *
 * 组件只调本文件导出的函数与类型，**组件里不许出现 `fetch`、`EventSource`、路径字符串**。
 * 契约升版本时改动只落在这一个文件里。
 *
 * 后端此刻还在并行实现中，本文件按契约写，不按实现写。自测走 `src/mock-server.ts`。
 */

/* ------------------------------------------------------------------ *
 * 基础
 * ------------------------------------------------------------------ */

/** Electron 注入的后端地址；网页端走同源 `/api` 反代（`design/interaction.md` § 4）。 */
export function apiBase(): string {
  const injected = (globalThis as { __QIUQIU_API__?: unknown }).__QIUQIU_API__;
  if (typeof injected === 'string' && injected.length > 0) return injected.replace(/\/+$/, '');
  return '/api';
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let currentFetch: FetchLike | null = null;

/** 注入 fetch 实现。`src/mock-server.ts` 与单测用；生产路径不调。 */
export function setFetchImpl(impl: FetchLike | null): void {
  currentFetch = impl;
}

/** 当前生效的 fetch。测试里要在已有实现之上再包一层时用得着。 */
export function getFetchImpl(): FetchLike {
  return currentFetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
}

/** 带上 base 与注入的 fetch。`voice.ts` 也用它，所以导出。 */
export function doFetch(path: string, init?: RequestInit): Promise<Response> {
  const f = currentFetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
  if (!f) throw new ApiError('no_fetch', '当前环境没有 fetch', '在 Node 18+ 或浏览器里运行前端');
  return f(apiBase() + path, init);
}

/** 统一错误体 `{ code, message, hint }`（契约 § 1）。`hint` 必须给出下一步能做什么。 */
export class ApiError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly status: number;

  constructor(code: string, message: string, hint: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = 'http_' + res.status;
  let message = res.statusText || '请求失败';
  let hint = '确认后端已经在 ' + apiBase() + ' 上启动';
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; hint?: string };
    };
    if (body && body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      hint = body.error.hint ?? hint;
    }
  } catch {
    /* 响应体不是 JSON，保留兜底文案 */
  }
  return new ApiError(code, message, hint, res.status);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await doFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ *
 * 契约 § 1 的数据类型
 * ------------------------------------------------------------------ */

export type PresetId = 'warm' | 'quiet' | 'cute' | 'sassy';

export interface Sliders {
  initiative: number;
  verbosity: number;
  emotion: number;
  humor: number;
}

export interface Learned {
  nickname?: string;
  humor_tolerance?: number;
  topics?: string[];
  reply_length?: 'short' | 'medium' | 'long';
}

export interface Persona {
  preset: PresetId | null;
  sliders: Sliders;
  learned: Learned;
  current: string;
}

/** 筛选阈值，0–1，默认 0.72 / 0.45。 */
export interface Thresholds {
  accept: number;
  uncertain: number;
}

/** 稳定度三层：L0 身份、L1 偏好、L2 近况（契约 § 1）。 */
export type MemoryLayer = 'L0' | 'L1' | 'L2';

export interface VisibleMemory {
  id: string;
  layer: MemoryLayer;
  content: string;
  source: 'auto' | 'manual';
  enabled: boolean;
  fact_ids: string[];
  updated_at: string;
}

export type Capability = 'chat' | 'vision' | 'asr' | 'vad' | 'tts' | 'realtime';

export interface ProviderInfo {
  capability: Capability;
  provider: string;
  model: string | null;
  base_url: string | null;
  /** 只报有没有 key，永远不回 key 本身。 */
  has_key: boolean;
  available: boolean;
  local: boolean;
  hint?: string;
  voice_mode?: 'cascade' | 'realtime';
}

export type AttachmentType = 'image' | 'audio';

export interface Attachment {
  type: AttachmentType;
  blob_id: string;
}

export interface ChatRequest {
  session_id: string;
  content: string;
  attachments?: Attachment[];
}

/* ---- /chat 的 SSE 四类 payload ---- */

export interface ChatMeta {
  model: string;
  memory_used: boolean;
  recall_ids: string[];
}

export interface ChatDelta {
  text: string;
}

export interface ChatDone {
  message_id: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
}

/** 有 TTS 时才发。**M5 才解码播放**，本轮收到即丢弃。 */
export interface ChatAudio {
  pcm_b64: string;
  sample_rate: number;
  rms: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  hint: string;
}

/* ---- /events 的事件信封 ---- */

export type MemoryEventType = 'filter' | 'write' | 'merge' | 'recall';

export type FilterDecision = 'accept' | 'reject' | 'uncertain';

export interface FilterPayload {
  decision: FilterDecision;
  score: number;
  reason: string;
  source: 'ambient_audio' | 'ambient_image';
  input_preview: string;
}

export interface WriteFact {
  id: string;
  text: string;
  entities: string[];
  valid_from: string;
}

export interface WritePayload {
  raw: string;
  speaker: 'user' | 'assistant';
  facts: WriteFact[];
  dropped_spans: string[];
}

export interface MergePayload {
  result_id: string;
  result_text: string;
  absorbed: Array<{ id: string; text: string }>;
  invalidated: Array<{ id: string; text: string; valid_to: string }>;
}

export type RecallPath = 'semantic' | 'lexical' | 'symbolic';

export interface RecallPayload {
  query: string;
  plan: { paths: RecallPath[]; depth: number; rewritten: string };
  hits: Array<{ id: string; text: string; path: RecallPath; score: number }>;
  skipped_paths: RecallPath[];
  tokens_injected: number;
  cold_promoted: string[];
}

interface EnvelopeBase {
  id: string;
  ts: string;
  trace_id: string;
}

export type MemoryEventEnvelope = EnvelopeBase &
  (
    | { type: 'filter'; payload: FilterPayload }
    | { type: 'write'; payload: WritePayload }
    | { type: 'merge'; payload: MergePayload }
    | { type: 'recall'; payload: RecallPayload }
  );

/* ------------------------------------------------------------------ *
 * SSE 解析
 * ------------------------------------------------------------------ */

export interface SseFrame {
  /** `event:` 行，缺省 `message`。 */
  event: string;
  /** 多行 `data:` 用 `\n` 拼接后的原文。 */
  data: string;
  /** `id:` 行，可选。 */
  id?: string;
}

/**
 * 增量 SSE 解析器。
 *
 * 按 W3C 的行规则实现：`\r\n` / `\n` / `\r` 都算换行，空行派发一帧，
 * 冒号后的单个空格要吃掉，`:` 开头是注释。跨 chunk 的半行留在缓冲里。
 */
export function createSseParser(): {
  feed(chunk: string): SseFrame[];
  flush(): SseFrame[];
} {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let lastId: string | undefined;

  function takeFrame(out: SseFrame[]): void {
    if (dataLines.length === 0 && eventName === '') return;
    out.push({ event: eventName || 'message', data: dataLines.join('\n'), id: lastId });
    eventName = '';
    dataLines = [];
  }

  function consumeLine(line: string, out: SseFrame[]): void {
    if (line === '') {
      takeFrame(out);
      return;
    }
    if (line.startsWith(':')) return; // 注释 / 心跳
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') lastId = value;
    // retry 与未知字段按规范忽略
  }

  return {
    feed(chunk: string): SseFrame[] {
      const out: SseFrame[] = [];
      buffer += chunk;
      // 末尾未闭合的一行留在 buffer 里等下一个 chunk
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line, out);
      return out;
    },
    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer !== '') {
        consumeLine(buffer, out);
        buffer = '';
      }
      takeFrame(out);
      return out;
    }
  };
}

function parseData<T>(frame: SseFrame): T | null {
  if (frame.data === '') return null;
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    console.warn(
      '[qiuqiu] SSE 帧的 data 不是 JSON，已丢弃：',
      frame.event,
      frame.data.slice(0, 120)
    );
    return null;
  }
}

/** 把 `Response.body` 按 SSE 拆帧喂给回调。流结束或被 abort 时 resolve。 */
async function pumpSse(res: Response, onFrame: (f: SseFrame) => void): Promise<void> {
  const body = res.body;
  if (!body) throw new ApiError('no_stream', '响应没有可读流', '确认后端返回 text/event-stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) onFrame(frame);
    }
    for (const frame of parser.flush()) onFrame(frame);
  } finally {
    reader.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * POST /chat —— 一轮对话的 SSE
 * ------------------------------------------------------------------ */

export interface ChatHandlers {
  onMeta?(meta: ChatMeta): void;
  onDelta?(delta: ChatDelta): void;
  onDone?(done: ChatDone): void;
  /** M5 才接 TTS 播放；本轮收到即丢弃，类型先定好。 */
  onAudio?(audio: ChatAudio): void;
  onError?(err: ErrorPayload): void;
}

export interface ChatStream {
  /** 中止本轮（用户点「停止」、或 T8 途中再次提交）。 */
  abort(): void;
  /** 流跑完（或被中止）时 resolve；网络层失败时 reject。 */
  finished: Promise<void>;
}

/**
 * 发起一轮对话。
 *
 * `EventSource` 只能 GET，`/chat` 是 POST，所以走 `fetch` + `ReadableStream` 自己拆帧。
 * 状态机的切换由调用方按 AD-1 本地完成，本函数不碰状态。
 */
export function postChat(req: ChatRequest, handlers: ChatHandlers = {}): ChatStream {
  const controller = new AbortController();

  const finished = (async () => {
    let res: Response;
    try {
      res = await doFetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(req),
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      throw new ApiError(
        'chat_unreachable',
        '连不上后端：' + (err instanceof Error ? err.message : String(err)),
        '确认后端已经在 ' + apiBase() + ' 上启动，再重发这句话'
      );
    }
    if (!res.ok) throw await toApiError(res);

    try {
      await pumpSse(res, (frame) => {
        switch (frame.event) {
          case 'meta': {
            const p = parseData<ChatMeta>(frame);
            if (p) handlers.onMeta?.(p);
            break;
          }
          case 'delta': {
            const p = parseData<ChatDelta>(frame);
            if (p && typeof p.text === 'string') handlers.onDelta?.(p);
            break;
          }
          case 'done': {
            const p = parseData<ChatDone>(frame);
            if (p) handlers.onDone?.(p);
            break;
          }
          case 'audio': {
            const p = parseData<ChatAudio>(frame);
            if (p) handlers.onAudio?.(p);
            break;
          }
          case 'error': {
            const p = parseData<ErrorPayload>(frame);
            if (p) handlers.onError?.(p);
            break;
          }
          default:
            break; // 契约之外的事件名一律忽略，不报错
        }
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      throw err;
    }
  })();

  return {
    abort: () => controller.abort(),
    finished
  };
}

/* ------------------------------------------------------------------ *
 * GET /events —— 记忆事件流，带 since 游标断线续传
 * ------------------------------------------------------------------ */

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** `id` 是 `evt_` 加 `event_log` 自增 id；`since` 游标就是那个自增 id（契约 § 1）。 */
export function cursorOf(eventId: string): number | null {
  const m = /^evt_(\d+)$/.exec(eventId);
  if (m) return Number(m[1]);
  const n = Number(eventId);
  return Number.isFinite(n) ? n : null;
}

export interface EventStreamOptions {
  /** 从哪条之后开始拉。首次连接缺省不传，后端给全部（或最近的）。 */
  since?: number | null;
  onEvent(ev: MemoryEventEnvelope): void;
  onStatus?(status: StreamStatus, detail?: ApiError): void;
  /** 重连退避序列，毫秒。缺省 1s / 2s / 4s / 8s，之后一直 8s。 */
  backoffMs?: readonly number[];
  /** 注入定时器，测试用。 */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

export interface EventStream {
  /** 当前游标，断线续传就靠它。 */
  cursor(): number | null;
  status(): StreamStatus;
  /** 立刻重连一次（侧栏的「重试」按钮）。 */
  retryNow(): void;
  close(): void;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000] as const;

/**
 * 订阅 `/events`。
 *
 * 断线后按退避序列重连，并把 `since` 设成**最后一条成功收到的事件 id**，
 * 后端从那条之后补齐（`design/memory-panel.md` § 4）。游标只在成功解析出
 * 一条事件之后才前进——半条 JSON 不推进游标，否则重连会丢事件。
 */
export function openEventStream(opts: EventStreamOptions): EventStream {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const later = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
  const cancel = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let cursor: number | null = opts.since ?? null;
  let status: StreamStatus = 'connecting';
  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let timer: unknown = null;

  function setStatus(next: StreamStatus, detail?: ApiError): void {
    if (status === next && !detail) return;
    status = next;
    opts.onStatus?.(next, detail);
  }

  function schedule(): void {
    if (closed) return;
    const wait = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    timer = later(() => {
      timer = null;
      void connect();
    }, wait);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    const query = cursor === null ? '' : '?since=' + encodeURIComponent(String(cursor));
    try {
      const res = await doFetch('/events' + query, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
      });
      if (!res.ok) throw await toApiError(res);
      attempt = 0;
      setStatus('open');
      await pumpSse(res, (frame) => {
        // /events 的信封是统一的一种，事件名后端可以写 message 也可以写 type，都收
        const env = parseData<MemoryEventEnvelope>(frame);
        if (!env || typeof env.id !== 'string' || typeof env.type !== 'string') return;
        const next = cursorOf(env.id);
        if (next !== null) cursor = cursor === null ? next : Math.max(cursor, next);
        opts.onEvent(env);
      });
      if (closed) return;
      // 后端主动关流也当断线处理，接着续传
      setStatus('reconnecting');
      schedule();
    } catch (err) {
      if (closed || controller?.signal.aborted) return;
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError(
              'events_unreachable',
              '记忆事件流断开：' + (err instanceof Error ? err.message : String(err)),
              '检查后端是否还活着；侧栏会自动重连，也可以点「重试」'
            );
      setStatus('reconnecting', apiErr);
      schedule();
    }
  }

  void connect();

  return {
    cursor: () => cursor,
    status: () => status,
    retryNow() {
      if (closed) return;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      controller?.abort();
      attempt = 0;
      setStatus('connecting');
      void connect();
    },
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
      controller?.abort();
      setStatus('closed');
    }
  };
}

/* ------------------------------------------------------------------ *
 * REST
 * ------------------------------------------------------------------ */

/** 记忆库（用户可见层）。 */
export function getMemories(layer?: MemoryLayer): Promise<VisibleMemory[]> {
  return json<VisibleMemory[]>('/memories' + (layer ? '?layer=' + layer : ''));
}

export function patchMemory(id: string, patch: Partial<VisibleMemory>): Promise<VisibleMemory> {
  return json<VisibleMemory>('/memories/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}

/** 级联作废对应事实，不删行（AD-9）。 */
export function deleteMemory(id: string): Promise<void> {
  return json<void>('/memories/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** 人格。 */
export function getPersona(): Promise<Persona> {
  return json<Persona>('/persona');
}

/**
 * 设预设。**AD-11：「不设」传 `null`，不是传一组中等值**——
 * `preset` 为 `null` 时后端不生成 `preset_block`，prompt 里不出现任何滑块描述。
 */
export function putPersonaPreset(preset: PresetId | null): Promise<void> {
  return json<void>('/persona/preset', { method: 'PUT', body: JSON.stringify({ preset }) });
}

export function putPersonaSliders(sliders: Sliders): Promise<void> {
  return json<void>('/persona/sliders', { method: 'PUT', body: JSON.stringify(sliders) });
}

/** 重置相处性格：写一版空的 learned，历史不删（AD-9）。 */
export function resetLearned(): Promise<Learned> {
  return json<Learned>('/persona/reset-learned', { method: 'POST' });
}

/** 筛选阈值。 */
export interface VoiceOption {
  /** 稳定短名，如 `vivi`。不是供应商音色 ID——同一个音色在级联与端到端两条链路上
   *  ID 不一样，映射收在后端，前端不碰。 */
  id: string;
  label: string;
  blurb: string;
  /** 为假时端到端链路会回退到默认音色。实时语音的精品音色只有四个。 */
  realtime_supported: boolean;
}

/** 可选音色。只有女声（契约 v0.1.10 § 1）。 */
export function getVoices(): Promise<VoiceOption[]> {
  return json<VoiceOption[]>('/voices');
}

export function getVoice(): Promise<{ voice: string }> {
  return json<{ voice: string }>('/config/voice');
}

export function putVoice(voice: string): Promise<{ voice: string }> {
  return json<{ voice: string }>('/config/voice', {
    method: 'PUT',
    body: JSON.stringify({ voice })
  });
}

export function getThresholds(): Promise<Thresholds> {
  return json<Thresholds>('/config/thresholds');
}

export function putThresholds(t: Thresholds): Promise<Thresholds> {
  return json<Thresholds>('/config/thresholds', { method: 'PUT', body: JSON.stringify(t) });
}

/** 供应商清单。`has_key` 只报有没有，前端永远拿不到 key 本身。 */
export function getProviders(): Promise<ProviderInfo[]> {
  return json<ProviderInfo[]>('/providers');
}

/**
 * 切当前模型。契约 v0.1.8 § 1 定形：`{ capability, model }` 进，
 * `{ capability, model, provider }` 出。
 *
 * `provider` 是**结果不是入参**——选路只看 `.env`（AD-8），这里不绕过。
 */
export function setCurrentModel(body: {
  capability: Capability;
  model: string;
}): Promise<{ capability: Capability; model: string; provider: ProviderInfo }> {
  return json<{ capability: Capability; model: string; provider: ProviderInfo }>('/current-model', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/* ---- 会话与历史（契约 v0.1.8 § 1）---- */

export interface SessionInfo {
  id: string;
  title: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  favorite: boolean;
  created_at: string;
}

/** 会话列表。契约 v0.1.8 § 1，只读；写入只经 `/chat`。 */
export function getSessions(archived = false): Promise<SessionInfo[]> {
  return json<SessionInfo[]>('/sessions?archived=' + String(archived));
}

/** 一个会话的历史消息，时间正序。契约 v0.1.8 § 1。 */
export function getSessionMessages(sessionId: string, limit = 200): Promise<StoredMessage[]> {
  return json<StoredMessage[]>(
    '/sessions/' + encodeURIComponent(sessionId) + '/messages?limit=' + String(limit)
  );
}

/** 上传附件，拿 `blob_id`。 */
export async function postBlob(file: Blob, filename = 'upload'): Promise<{ blob_id: string }> {
  const form = new FormData();
  form.append('file', file, filename);
  const res = await doFetch('/blobs', { method: 'POST', body: form });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { blob_id: string };
}

export function getHealth(): Promise<{ status?: string }> {
  return json<{ status?: string }>('/health');
}

/** 被动采集。前端切片后先 `postBlob` 再调这里。 */
export function postIngest(body: {
  source: 'ambient_audio' | 'ambient_image';
  blob_id: string;
  captured_at: string;
}): Promise<{ trace_id: string; decision: FilterDecision }> {
  return json<{ trace_id: string; decision: FilterDecision }>('/ingest', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/* ---- 语音：M5 才接，类型先定好 ---- */

export interface VoiceSession {
  voice_session_id: string;
  mode: 'cascade' | 'realtime';
}

/** M5 接入。本轮界面上的语音按钮点了只提示，不会调到这里。 */
export function postVoiceSession(sessionId: string): Promise<VoiceSession> {
  return json<VoiceSession>('/voice/session', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId })
  });
}

/** `WS /voice/stream` 的下行帧类型，M5 用。 */
export type VoiceFrame =
  | { type: 'partial'; role: 'user'; text: string }
  | { type: 'final'; role: 'user' | 'assistant'; text: string }
  | { type: 'audio'; pcm_b64: string; sample_rate: number; rms: number }
  | { type: 'turn_end' }
  | ({ type: 'error' } & ErrorPayload);

/** `WS /voice/stream` 的完整地址。M5 建连时用，本轮只导出不调。 */
export function voiceStreamUrl(voiceSessionId: string): string {
  const base = apiBase();
  const absolute = /^https?:/i.test(base)
    ? base
    : (globalThis.location?.origin ?? 'http://127.0.0.1:8000') + base;
  return (
    absolute.replace(/^http/i, 'ws') +
    '/voice/stream?voice_session_id=' +
    encodeURIComponent(voiceSessionId)
  );
}

/* ---- 场景控制台 ---- */

export interface ScenarioInfo {
  name: string;
  title: string;
}

/**
 * 列出可回放的场景。契约 v0.1.8 § 1 收编了 `GET /scenarios`，
 * 名字不再写死在前端。
 */
export function getScenarios(): Promise<ScenarioInfo[]> {
  return json<ScenarioInfo[]>('/scenarios');
}

/**
 * 场景名的兜底：后端还没放脚本时列表是空的，界面上至少显示这四个（点了会报没有脚本）。
 * 取自 `scenarios/README.md`，不是契约的一部分。
 */
export const FALLBACK_SCENARIOS: readonly ScenarioInfo[] = [
  { name: 'ambient-noise', title: '99% 是废话' },
  { name: 'time-jump', title: '过了三个月' },
  { name: 'multi-person', title: '客厅里有三个人' },
  { name: 'cost-compare', title: '成本对照' }
];

/** `POST /scenario/{name}/play`，路径取自 `scenarios/README.md`。 */
export function playScenario(name: string): Promise<{ trace_id?: string }> {
  return json<{ trace_id?: string }>('/scenario/' + encodeURIComponent(name) + '/play', {
    method: 'POST'
  });
}
