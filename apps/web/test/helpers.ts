/** 测试用的假 SSE 后端与桥。 */

import type { MemoryEventEnvelope } from '../src/api.js';
import { createMemoryBridge, type QiuqiuBridgeExt } from '../src/bridge.js';

export interface FakeConnection {
  url: string;
  send(event: string, data: unknown): void;
  raw(chunk: string): void;
  close(): void;
  closed: boolean;
}

export interface FakeSseBackend {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  connections: FakeConnection[];
  last(): FakeConnection;
}

/** 每次请求开一条可以手动喂数据、手动掐断的 SSE 连接。 */
export function fakeSseBackend(): FakeSseBackend {
  const connections: FakeConnection[] = [];
  const encoder = new TextEncoder();

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const conn: FakeConnection = {
      url: input,
      closed: false,
      raw(chunk) {
        if (conn.closed) return;
        controller?.enqueue(encoder.encode(chunk));
      },
      send(event, data) {
        conn.raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close() {
        if (conn.closed) return;
        conn.closed = true;
        try {
          controller?.close();
        } catch {
          /* 已经关了 */
        }
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        conn.closed = true;
      }
    });
    (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => conn.close(), {
      once: true
    });
    connections.push(conn);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
      json: async () => ({}),
      text: async () => ''
    } as unknown as Response;
  };

  return {
    fetchImpl,
    connections,
    last: () => connections[connections.length - 1]
  };
}

let seq = 0;

/** 造一条事件信封，字段名与 `docs/CONTRACTS.md` § 1 一致。 */
export function makeEvent(
  type: MemoryEventEnvelope['type'],
  payload: unknown,
  id?: string
): MemoryEventEnvelope {
  seq += 1;
  return {
    id: id ?? 'evt_' + seq,
    ts: '2026-09-05T10:20:3' + (seq % 10) + '.000Z',
    trace_id: 'trc_test',
    type,
    payload
  } as MemoryEventEnvelope;
}

export function resetEventSeq(): void {
  seq = 0;
}

export interface RecordingBridge extends QiuqiuBridgeExt {
  calls: Array<[string, ...unknown[]]>;
}

/** 记下每一次调用，用来验 AD-5 的转发。 */
export function recordingBridge(): RecordingBridge {
  const base = createMemoryBridge();
  const calls: Array<[string, ...unknown[]]> = [];
  const wrapped = { calls } as RecordingBridge;
  for (const key of Object.keys(base) as Array<keyof QiuqiuBridgeExt>) {
    const fn = base[key] as (...a: unknown[]) => unknown;
    (wrapped as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
      calls.push([key as string, ...args]);
      return fn(...args);
    };
  }
  return wrapped;
}
