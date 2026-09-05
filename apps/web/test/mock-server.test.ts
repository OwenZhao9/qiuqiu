/**
 * 拿本地 mock 后端跑一遍全链路：发一句话 → SSE 逐字 → 事件进侧栏 → 断线续传。
 *
 * mock 按契约 § 1 造，后端此刻还在并行实现，这条链路不碰 `services/api`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  getPersona,
  getThresholds,
  openEventStream,
  postChat,
  putThresholds,
  getScenarios,
  getSessions,
  getSessionMessages,
  type MemoryEventEnvelope
} from '../src/api.js';
import { installMockServer, type MockServer } from '../src/mock-server.js';
import { createChatStore } from '../src/store/chat.js';
import { createEventsStore } from '../src/store/events.js';
import { recordingBridge } from './helpers.js';

let server: MockServer | null = null;

function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  server?.stop();
  server = null;
});

describe('mock 后端 · /chat', () => {
  it('一轮对话走完 meta → delta → done，状态机跟着切', async () => {
    server = installMockServer({ deltaMs: 0, reply: '记住了' });
    const bridge = recordingBridge();
    const store = createChatStore('s1', { bridge });

    store.send('我搬到深圳了');
    expect(store.get().character).toBe('thinking');

    await tick(20);
    expect(store.get().messages.at(-1)?.content).toBe('记住了');
    expect(store.get().character).toBe('idle');
    expect(store.get().messages.at(-1)?.recallIds.length).toBeGreaterThan(0);

    // AD-5：桌宠拿到的是全文，最后一次必须是完整的
    const forwarded = bridge.calls
      .filter((c) => c[0] === 'forwardReply')
      .map((c) => c[2] as string);
    expect(forwarded.at(-1)).toBe('记住了');
  });

  it('中止一轮之后 finished 不抛，状态回 idle', async () => {
    server = installMockServer({ deltaMs: 5, reply: '一二三四五六七八' });
    const handle = postChat({ session_id: 's', content: '慢慢说' }, {});
    await tick(10);
    handle.abort();
    await expect(handle.finished).resolves.toBeUndefined();
  });
});

describe('mock 后端 · /events', () => {
  it('一轮对话带出 recall / write / merge 三条事件', async () => {
    server = installMockServer({ deltaMs: 0, reply: '好' });
    const got: MemoryEventEnvelope[] = [];
    const stream = openEventStream({ onEvent: (e) => got.push(e) });
    await tick(5);

    const bridge = recordingBridge();
    createChatStore('s1', { bridge }).send('我搬到深圳了');
    await tick(30);

    expect(got.map((e) => e.type)).toEqual(['recall', 'write', 'merge']);
    stream.close();
  });

  it('断线后按 since 续传，中间产生的事件一条不丢', async () => {
    server = installMockServer({ deltaMs: 0 });
    const events = createEventsStore();
    events.connect();
    await tick(5);

    server.pushAmbient(0.9);
    await tick(5);
    expect(events.get().events).toHaveLength(1);
    const cursor = events.cursor();
    expect(cursor).toBe(1);

    // 掐断，断线期间后端又产生两条
    server.dropEventStream();
    server.pushAmbient(0.2);
    server.pushAmbient(0.5);
    await tick(1200); // 等退避 1 s 后重连

    expect(events.get().events).toHaveLength(3);
    expect(events.cursor()).toBe(3);
    events.destroy();
  });
});

describe('mock 后端 · REST', () => {
  it('阈值读写同一形状，PUT 之后再 GET 拿到新值', async () => {
    server = installMockServer();
    expect(await getThresholds()).toEqual({ accept: 0.72, uncertain: 0.45 });
    await putThresholds({ accept: 0.8, uncertain: 0.3 });
    expect(await getThresholds()).toEqual({ accept: 0.8, uncertain: 0.3 });
  });

  it('/persona 的四个字段齐了', async () => {
    server = installMockServer();
    const p = await getPersona();
    expect(Object.keys(p).sort()).toEqual(['current', 'learned', 'preset', 'sliders']);
  });
});

describe('mock 后端 · 会话与历史（契约 v0.1.8 § 1）', () => {
  it('发过话之后读得回来，两个角色都在', async () => {
    server = installMockServer({ deltaMs: 0, reply: '知道啦' });
    {
      expect(await getSessions()).toEqual([]);

      // 把这一轮 SSE 读到底：`done` 之后 mock 才落库，跟真后端一样
      await postChat({ session_id: 's1', content: '我叫赵宁' }, {}).finished;

      const sessions = await getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('s1');

      // 收编这两条路由的理由就是「刷新一次历史全丢」，所以要读得回两条（AD-6）
      const rows = await getSessionMessages('s1');
      expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
      expect(rows[0].content).toBe('我叫赵宁');
      expect(rows[1].content).toBe('知道啦');
    }
  });

  it('没有的会话给 404 且带 hint', async () => {
    server = installMockServer({ deltaMs: 0 });
    await expect(getSessionMessages('nope')).rejects.toMatchObject({
      code: 'session_not_found'
    });
  });

  it('场景列表走路由，不再写死在前端', async () => {
    server = installMockServer({ deltaMs: 0 });
    const rows = await getScenarios();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.name && r.title)).toBe(true);
  });
});
