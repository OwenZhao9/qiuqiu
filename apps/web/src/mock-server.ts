/**
 * 本地 mock 后端。
 *
 * `backend` 分支正在并行实现 `services/api`，前端不等它、也不读它——
 * 契约就是接口。本文件按 `docs/CONTRACTS.md` § 1 造出全部路由与两条 SSE，
 * 供 vitest 与手工联调用（开发时地址栏加 `?mock=1`）。
 *
 * 它替换的是 `api.ts` 里注入的 fetch，**不是**真起一个服务。
 */

import {
  setFetchImpl,
  type FilterDecision,
  type MemoryEventEnvelope,
  type Persona,
  type ProviderInfo,
  type ScenarioInfo,
  type SessionInfo,
  type StoredMessage,
  type Thresholds,
  type VisibleMemory
} from './api.js';

/* ------------------------------------------------------------------ *
 * 造一个最小的 Response
 * ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null
  } as unknown as Response;
}

function errorResponse(status: number, code: string, message: string, hint: string): Response {
  return jsonResponse({ error: { code, message, hint } }, status);
}

interface StreamHandle {
  send(event: string, data: unknown): void;
  close(): void;
  closed: boolean;
}

function sseResponse(signal: AbortSignal | null | undefined): {
  response: Response;
  handle: StreamHandle;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const handle: StreamHandle = {
    closed: false,
    send(event, data) {
      if (handle.closed || !controller) return;
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      if (handle.closed) return;
      handle.closed = true;
      try {
        controller?.close();
      } catch {
        /* 已经关了 */
      }
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      handle.closed = true;
    }
  });
  signal?.addEventListener('abort', () => handle.close(), { once: true });
  return {
    response: {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: stream,
      json: async () => ({}),
      text: async () => ''
    } as unknown as Response,
    handle
  };
}

/* ------------------------------------------------------------------ *
 * 假数据
 * ------------------------------------------------------------------ */

const REPLY_POOL = [
  '记住了，我把这条放进近况那一层。有变化再跟我说。',
  '你上次提过这件事，我翻了一下，找到三条相关的。',
  '好，我先按你说的来。要是不合适，随时喊停。',
  '这件事我这边帮不上，得你自己去办一趟。'
];

/** 事件 id 生成器。每个 mock 实例一份，测试之间不串号。 */
type NextId = () => string;

function createIdGen(): NextId {
  let seq = 0;
  return () => {
    seq += 1;
    return 'evt_' + seq;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function traceId(): string {
  return 'trc_' + Math.random().toString(36).slice(2, 10);
}

/** 一轮对话会带出来的四类事件，正好把侧栏四种卡都画一遍。 */
function turnEvents(query: string, trace: string, nextEventId: NextId): MemoryEventEnvelope[] {
  return [
    {
      id: nextEventId(),
      ts: nowIso(),
      trace_id: trace,
      type: 'recall',
      payload: {
        query,
        plan: { paths: ['semantic', 'lexical'], depth: 2, rewritten: query + '（近三个月）' },
        hits: [
          { id: 'fact_9a13c2f0', text: '他上周搬到了深圳', path: 'semantic', score: 0.83 },
          { id: 'fact_2b77de41', text: '他喜欢在周末逛旧书店', path: 'lexical', score: 0.61 }
        ],
        skipped_paths: ['symbolic'],
        tokens_injected: 184,
        cold_promoted: ['fact_2b77de41']
      }
    },
    {
      id: nextEventId(),
      ts: nowIso(),
      trace_id: trace,
      type: 'write',
      payload: {
        raw: query,
        speaker: 'user',
        facts: [
          {
            id: 'fact_' + Math.random().toString(16).slice(2, 10),
            text: query.slice(0, 40),
            entities: ['时间', '地点', '人物', '习惯'],
            valid_from: nowIso()
          }
        ],
        dropped_spans: ['嗯……', '就是那个']
      }
    },
    {
      id: nextEventId(),
      ts: nowIso(),
      trace_id: trace,
      type: 'merge',
      payload: {
        result_id: 'fact_merged_01',
        result_text: '他现在住在深圳，之前在北京',
        absorbed: [{ id: 'fact_9a13c2f0', text: '他上周搬到了深圳' }],
        invalidated: [{ id: 'fact_0011aabb', text: '他住在北京', valid_to: nowIso() }]
      }
    }
  ];
}

function ambientEvent(score: number, nextEventId: NextId): MemoryEventEnvelope {
  const decision: FilterDecision =
    score >= 0.72 ? 'accept' : score >= 0.45 ? 'uncertain' : 'reject';
  return {
    id: nextEventId(),
    ts: nowIso(),
    trace_id: traceId(),
    type: 'filter',
    payload: {
      decision,
      score,
      reason:
        decision === 'reject'
          ? '寒暄与环境噪音，没有可提取的事实'
          : decision === 'uncertain'
            ? '像是安排，但时间与对象都缺'
            : '包含明确的时间与地点',
      source: 'ambient_audio',
      input_preview: '……那个，明天下午要不要一起去看看那家新开的店……'
    }
  };
}

/* ------------------------------------------------------------------ *
 * mock server
 * ------------------------------------------------------------------ */

/** 只有女声，与后端 `qiuqiu_models.voices` 同一份表（契约 v0.1.10 § 1）。 */
const VOICES = [
  { id: 'vivi', label: 'Vivi', blurb: '活泼灵动，分享欲强', realtime_supported: true },
  { id: 'xiaohe', label: '小何', blurb: '甜美活泼，带台湾口音', realtime_supported: true },
  {
    id: 'linjianvhai',
    label: '邻家女孩',
    blurb: '自然亲切，像住隔壁的朋友',
    realtime_supported: false
  },
  { id: 'qingxin', label: '清新女声', blurb: '干净清爽，不腻', realtime_supported: false },
  {
    id: 'tianmeixiaoyuan',
    label: '甜美小源',
    blurb: '甜而不腻，语速偏慢',
    realtime_supported: false
  },
  { id: 'tianmeitaozi', label: '甜美桃子', blurb: '偏少女，尾音上扬', realtime_supported: false },
  {
    id: 'shuangkuaisisi',
    label: '爽快思思',
    blurb: '干脆利落，不拖泥带水',
    realtime_supported: false
  },
  { id: 'cancan', label: '知性灿灿', blurb: '沉稳知性，适合长句', realtime_supported: false },
  {
    id: 'gaolengyujie',
    label: '高冷御姐',
    blurb: '冷淡疏离，配「毒舌」预设',
    realtime_supported: false
  },
  {
    id: 'sajiaoxuemei',
    label: '撒娇学妹',
    blurb: '黏人，配「可爱」预设',
    realtime_supported: false
  }
] as const;

/** 当前音色。**每次 `installMockServer()` 都重置**——模块级可变状态不重置的话，
 *  上一条用例改过的值会漏进下一条，表现是「点了没反应」，很难查。 */
let voice = 'vivi';

export interface MockServer {
  /** 手动推一条事件进 `/events`。 */
  push(ev: MemoryEventEnvelope): void;
  /** 造一条被动采集的 `filter` 事件。 */
  pushAmbient(score: number): void;
  /** 掐断当前的 `/events` 连接，用来验断线续传。 */
  dropEventStream(): void;
  /** 已经发出去的全部事件，`since` 续传从这里补。 */
  log(): MemoryEventEnvelope[];
  thresholds(): Thresholds;
  stop(): void;
}

export interface MockOptions {
  /** 每个 delta 之间的间隔，毫秒。测试传 0。 */
  deltaMs?: number;
  /** 被动采集自动打点的间隔，毫秒；`0` 关掉。 */
  ambientMs?: number;
  /** 固定回复，缺省从池子里挑。 */
  reply?: string;
}

export function installMockServer(opts: MockOptions = {}): MockServer {
  voice = 'vivi';
  const deltaMs = opts.deltaMs ?? 60;
  const nextEventId = createIdGen();
  const eventLog: MemoryEventEnvelope[] = [];
  const listeners = new Set<StreamHandle>();
  let thresholds: Thresholds = { accept: 0.72, uncertain: 0.45 };
  let persona: Persona = {
    preset: 'warm',
    sliders: { initiative: 60, verbosity: 45, emotion: 70, humor: 50 },
    learned: { nickname: '老张', reply_length: 'short', topics: ['旧书店', '爵士乐'] },
    current: '（人格快照由 memory 合成，前端只读不拼）'
  };
  const memories: VisibleMemory[] = [
    {
      id: 'vm_01',
      layer: 'L0',
      content: '叫他老张，1990 年生，做后端开发',
      source: 'auto',
      enabled: true,
      fact_ids: ['fact_a1', 'fact_a2'],
      updated_at: nowIso()
    },
    {
      id: 'vm_02',
      layer: 'L1',
      content: '喜欢逛旧书店，讨厌被催',
      source: 'auto',
      enabled: true,
      fact_ids: ['fact_b1'],
      updated_at: nowIso()
    },
    {
      id: 'vm_03',
      layer: 'L2',
      content: '上周从北京搬到深圳',
      source: 'manual',
      enabled: true,
      fact_ids: ['fact_c1'],
      updated_at: nowIso()
    }
  ];

  function broadcast(ev: MemoryEventEnvelope): void {
    eventLog.push(ev);
    for (const h of listeners) h.send('message', ev);
  }

  let ambientTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.ambientMs) {
    ambientTimer = setInterval(() => {
      broadcast(ambientEvent(Math.random(), nextEventId));
    }, opts.ambientMs);
  }

  // 契约 v0.1.8 § 1：会话与历史。`/chat` 往里记，`GET /sessions*` 读出来——
  // 这两条收编的理由就是「刷新一次历史全丢」，mock 不落库就测不出这件事。
  const sessions: SessionInfo[] = [];
  const storedMessages: StoredMessage[] = [];

  const scenarios: ScenarioInfo[] = [
    { name: 'ambient-noise', title: '99% 是废话' },
    { name: 'time-jump', title: '过了三个月' },
    { name: 'multi-person', title: '客厅里有三个人' },
    { name: 'cost-compare', title: '成本对照' }
  ];

  function remember(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    attachments: string[] = []
  ): void {
    const at = nowIso();
    if (!sessions.some((x) => x.id === sessionId)) {
      sessions.unshift({
        id: sessionId,
        title: content.slice(0, 20),
        archived: false,
        created_at: at,
        updated_at: at
      });
    } else {
      const row = sessions.find((x) => x.id === sessionId)!;
      row.updated_at = at;
    }
    storedMessages.push({
      id: String(storedMessages.length + 1),
      session_id: sessionId,
      role,
      content,
      model: role === 'assistant' ? 'mock-chat' : null,
      favorite: false,
      attachments,
      created_at: at
    });
  }

  const providers: ProviderInfo[] = [
    {
      capability: 'chat',
      provider: 'mock',
      model: 'mock-chat',
      base_url: null,
      has_key: false,
      available: true,
      local: true
    },
    {
      capability: 'vision',
      provider: 'deepseek',
      model: 'deepseek-vl',
      base_url: 'https://api.deepseek.com',
      has_key: true,
      available: true,
      local: false
    },
    {
      capability: 'tts',
      provider: 'edge',
      model: null,
      base_url: null,
      has_key: false,
      available: false,
      local: true,
      hint: 'M5 才接入，先在 .env 里留空'
    },
    {
      capability: 'realtime',
      provider: 'doubao',
      model: null,
      base_url: null,
      has_key: false,
      available: false,
      local: false,
      hint: '填 DOUBAO_API_KEY 后可用',
      voice_mode: 'cascade'
    }
  ];

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(url, 'http://mock.local');
    const path = u.pathname.replace(/^\/api/, '');
    const signal = init?.signal as AbortSignal | undefined;

    if (path === '/health') return jsonResponse({ status: 'ok' });

    if (path === '/chat' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        content?: string;
        session_id?: string;
        attachments?: { blob_id: string }[];
      };
      const query = body.content ?? '';
      const sessionId = body.session_id || 'default';
      const shots = (body.attachments ?? []).map((a) => a.blob_id);
      const reply = opts.reply ?? REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)];
      const trace = traceId();
      const { response, handle: h } = sseResponse(signal);
      void (async () => {
        const events = turnEvents(query, trace, nextEventId);
        h.send('meta', {
          model: 'mock-chat',
          memory_used: true,
          recall_ids: ['fact_9a13c2f0', 'fact_2b77de41']
        });
        broadcast(events[0]);
        for (const ch of [...reply]) {
          if (h.closed) return;
          if (deltaMs > 0) await new Promise((r) => setTimeout(r, deltaMs));
          h.send('delta', { text: ch });
        }
        h.send('done', {
          message_id: 'msg_' + Math.random().toString(36).slice(2, 8),
          tokens_in: 128,
          tokens_out: reply.length,
          latency_ms: 420
        });
        // AD-6：用户那句和 AI 那句都要落库，`GET /sessions/{id}/messages` 才读得回两条
        remember(sessionId, 'user', query, shots);
        remember(sessionId, 'assistant', reply);
        h.close();
        broadcast(events[1]);
        broadcast(events[2]);
      })();
      return response;
    }

    if (path === '/events' && method === 'GET') {
      const since = u.searchParams.get('since');
      const { response, handle: h } = sseResponse(signal);
      listeners.add(h);
      signal?.addEventListener('abort', () => listeners.delete(h), { once: true });
      if (since !== null) {
        const from = Number(since);
        // 断线续传：把游标之后的事件按 id 升序补齐
        for (const ev of eventLog) {
          const n = Number(ev.id.replace('evt_', ''));
          if (n > from) h.send('message', ev);
        }
      }
      return response;
    }

    if (path === '/voices' && method === 'GET') return jsonResponse(VOICES);

    if (path === '/config/voice') {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { voice?: string };
        if (!VOICES.some((v) => v.id === body.voice)) {
          return errorResponse(
            400,
            'voice.unknown',
            `没有这个音色：${String(body.voice)}。`,
            '先 GET /voices 看可选项，用返回的 id。'
          );
        }
        voice = String(body.voice);
      }
      return jsonResponse({ voice });
    }

    if (path === '/config/thresholds') {
      if (method === 'PUT') {
        thresholds = JSON.parse(String(init?.body ?? '{}')) as Thresholds;
      }
      return jsonResponse(thresholds);
    }

    if (path === '/persona' && method === 'GET') return jsonResponse(persona);
    if (path === '/persona/preset' && method === 'PUT') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { preset: Persona['preset'] };
      persona = { ...persona, preset: body.preset };
      return jsonResponse({});
    }
    if (path === '/persona/sliders' && method === 'PUT') {
      persona = { ...persona, sliders: JSON.parse(String(init?.body ?? '{}')) };
      return jsonResponse({});
    }
    if (path === '/persona/reset-learned' && method === 'POST') {
      persona = { ...persona, learned: {} };
      return jsonResponse({});
    }

    if (path === '/memories' && method === 'GET') {
      const layer = u.searchParams.get('layer');
      return jsonResponse(layer ? memories.filter((m) => m.layer === layer) : memories);
    }
    if (path.startsWith('/memories/')) {
      const id = decodeURIComponent(path.slice('/memories/'.length));
      const idx = memories.findIndex((m) => m.id === id);
      if (idx === -1) {
        return errorResponse(404, 'not_found', '没有这条记忆', '刷新记忆库再试');
      }
      if (method === 'PATCH') {
        memories[idx] = {
          ...memories[idx],
          ...(JSON.parse(String(init?.body ?? '{}')) as Partial<VisibleMemory>),
          updated_at: nowIso()
        };
        return jsonResponse(memories[idx]);
      }
      if (method === 'DELETE') {
        // AD-9：不删行，只置 enabled=false
        memories[idx] = { ...memories[idx], enabled: false, updated_at: nowIso() };
        return jsonResponse({}, 204);
      }
    }

    if (path === '/providers' && method === 'GET') return jsonResponse(providers);

    // 契约 v0.1.8：`{ capability, model }` 进，`{ capability, model, provider }` 出。
    if (path === '/current-model' && method === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        capability?: string;
        model?: string;
      };
      const provider = providers.find((p) => p.capability === sent.capability) ?? providers[0];
      return jsonResponse({
        capability: sent.capability ?? 'chat',
        model: sent.model ?? '',
        provider
      });
    }

    // 契约 v0.1.8 § 1 收编的三条只读路由。
    if (path === '/scenarios' && method === 'GET') return jsonResponse(scenarios);
    if (path === '/sessions' && method === 'GET') return jsonResponse(sessions);
    {
      const m = /^\/sessions\/([^/]+)\/messages$/.exec(path);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        if (!sessions.some((x) => x.id === id)) {
          return errorResponse(
            404,
            'session_not_found',
            `没有这个会话：${id}。`,
            '会话由 POST /chat 自动创建；先发一句话，或用 GET /sessions 看现有的。'
          );
        }
        return jsonResponse(storedMessages.filter((x) => x.session_id === id));
      }
    }
    if (path === '/blobs' && method === 'POST') {
      return jsonResponse({ blob_id: 'image/' + Math.random().toString(16).slice(2, 18) });
    }
    if (path === '/ingest' && method === 'POST') {
      const ev = ambientEvent(Math.random(), nextEventId);
      broadcast(ev);
      return jsonResponse({
        trace_id: ev.trace_id,
        decision: ev.type === 'filter' ? ev.payload.decision : 'reject'
      });
    }
    if (/^\/scenario\/[^/]+\/play$/.test(path) && method === 'POST') {
      const trace = traceId();
      for (const ev of turnEvents('回放：过了三个月', trace, nextEventId)) broadcast(ev);
      return jsonResponse({ trace_id: trace });
    }
    if (path === '/voice/session' && method === 'POST') {
      return jsonResponse({ voice_session_id: 'vs_mock', mode: 'cascade' });
    }

    return errorResponse(
      404,
      'no_route',
      `mock 没实现 ${method} ${path}`,
      '按契约 § 1 补进 mock-server.ts'
    );
  }

  setFetchImpl((input, init) => handle(input, init));

  return {
    push: broadcast,
    pushAmbient(score) {
      broadcast(ambientEvent(score, nextEventId));
    },
    dropEventStream() {
      for (const h of [...listeners]) {
        listeners.delete(h);
        h.close();
      }
    },
    log: () => [...eventLog],
    thresholds: () => thresholds,
    stop() {
      if (ambientTimer) clearInterval(ambientTimer);
      for (const h of [...listeners]) h.close();
      listeners.clear();
      setFetchImpl(null);
    }
  };
}
