/**
 * `/events` 的断线续传。
 *
 * 验收里明写：「断网重连后 `/events` 从上次游标续传，侧栏不丢事件」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openEventStream, setFetchImpl, type MemoryEventEnvelope } from '../src/api.js';
import { fakeSseBackend, makeEvent, resetEventSeq } from './helpers.js';

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('openEventStream', () => {
  beforeEach(() => {
    resetEventSeq();
  });

  afterEach(() => {
    setFetchImpl(null);
    vi.useRealTimers();
  });

  it('首次连接不带 since，收到的事件按信封原样交出来', async () => {
    const backend = fakeSseBackend();
    setFetchImpl(backend.fetchImpl);
    const got: MemoryEventEnvelope[] = [];
    const stream = openEventStream({ onEvent: (e) => got.push(e) });

    await tick();
    expect(backend.last().url).not.toContain('since=');

    backend
      .last()
      .send(
        'message',
        makeEvent('write', { raw: '', speaker: 'user', facts: [], dropped_spans: [] })
      );
    await tick();

    expect(got).toHaveLength(1);
    expect(got[0].type).toBe('write');
    expect(stream.cursor()).toBe(1);
    stream.close();
  });

  it('断线后按 since=<最后一条 id> 续传，事件不丢', async () => {
    vi.useFakeTimers();
    const backend = fakeSseBackend();
    setFetchImpl(backend.fetchImpl);
    const got: MemoryEventEnvelope[] = [];
    const statuses: string[] = [];
    const stream = openEventStream({
      onEvent: (e) => got.push(e),
      onStatus: (s) => statuses.push(s)
    });

    await vi.advanceTimersByTimeAsync(0);
    backend.last().send('message', makeEvent('filter', { decision: 'accept', score: 0.9 }));
    backend.last().send('message', makeEvent('filter', { decision: 'reject', score: 0.1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.cursor()).toBe(2);

    // 掐断
    backend.last().close();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toContain('reconnecting');

    // 退避 1 s 之后重连，URL 上带着游标
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.connections).toHaveLength(2);
    expect(backend.last().url).toContain('since=2');

    // 补齐的事件照常追加
    backend.last().send('message', makeEvent('merge', { result_id: 'x', result_text: '并了' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveLength(3);
    expect(stream.cursor()).toBe(3);
    stream.close();
  });

  it('连不上时退避 1s / 2s / 4s / 8s，之后一直 8s', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    setFetchImpl(async () => {
      attempts += 1;
      throw new Error('ECONNREFUSED');
    });
    const stream = openEventStream({ onEvent: () => {} });

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    for (const wait of [1000, 2000, 4000, 8000, 8000]) {
      const before = attempts;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(attempts).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(before + 1);
    }
    stream.close();
  });

  it('连上过一次就把退避清零，下次断线还是 1 s', async () => {
    vi.useFakeTimers();
    const backend = fakeSseBackend();
    setFetchImpl(backend.fetchImpl);
    const stream = openEventStream({ onEvent: () => {} });

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
      backend.last().close();
      await vi.advanceTimersByTimeAsync(0);
      const before = backend.connections.length;
      await vi.advanceTimersByTimeAsync(999);
      expect(backend.connections.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(backend.connections.length).toBe(before + 1);
    }
    stream.close();
  });

  it('半条 JSON 不推进游标，重连时不会跳过它', async () => {
    const backend = fakeSseBackend();
    setFetchImpl(backend.fetchImpl);
    const got: MemoryEventEnvelope[] = [];
    const stream = openEventStream({ onEvent: (e) => got.push(e) });
    await tick();

    backend.last().raw('event: message\ndata: {"id":"evt_9","ts":"x","trace_id":"t","type":"wri');
    await tick();
    expect(got).toHaveLength(0);
    expect(stream.cursor()).toBeNull();

    backend.last().raw('te","payload":{"facts":[]}}\n\n');
    await tick();
    expect(got).toHaveLength(1);
    expect(stream.cursor()).toBe(9);
    stream.close();
  });

  it('「重试」立刻重连，不等退避', async () => {
    vi.useFakeTimers();
    const backend = fakeSseBackend();
    setFetchImpl(backend.fetchImpl);
    const stream = openEventStream({ onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    backend.last().close();
    await vi.advanceTimersByTimeAsync(0);

    stream.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.connections).toHaveLength(2);
    stream.close();
  });

  it('close 之后不再重连', async () => {
    vi.useFakeTimers();
    const backend = fakeSseBackend();
    setFetchImpl(backend.fetchImpl);
    const stream = openEventStream({ onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    stream.close();
    backend.last().close();
    await vi.advanceTimersByTimeAsync(30000);
    expect(backend.connections).toHaveLength(1);
    expect(stream.status()).toBe('closed');
  });
});
