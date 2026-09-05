/**
 * AD-1（状态机本地切换，不等后端）与 AD-5（主窗口是唯一 SSE 持有者，delta 经 IPC 转发）。
 *
 * 迁移编号对着 `design/state-machine.md` § 2。
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatHandlers, ChatRequest, ChatStream } from '../src/api.js';
import { createChatStore } from '../src/store/chat.js';
import { recordingBridge } from './helpers.js';

/** 手动驱动的假 `/chat` 流。 */
function fakeChat() {
  const seen: Array<{ req: ChatRequest; handlers: ChatHandlers; aborted: boolean }> = [];
  const impl = (req: ChatRequest, handlers: ChatHandlers = {}): ChatStream => {
    const entry = { req, handlers, aborted: false };
    seen.push(entry);
    return {
      abort: () => {
        entry.aborted = true;
      },
      finished: new Promise<void>(() => {
        /* 由测试自己驱动，永不 resolve */
      })
    };
  };
  return { impl: impl as unknown as typeof import('../src/api.js').postChat, seen };
}

function setup() {
  const bridge = recordingBridge();
  const chat = fakeChat();
  const states: string[] = [];
  const store = createChatStore('s1', {
    bridge,
    chat: chat.impl,
    onCharacterState: (s) => states.push(s)
  });
  return { bridge, chat, store, states };
}

describe('createChatStore · 本地状态机', () => {
  it('T1：提交立刻进 thinking，不等后端的第一个字节', () => {
    const { store, states, chat } = setup();
    expect(store.get().character).toBe('idle');
    store.send('在吗');
    expect(store.get().character).toBe('thinking');
    expect(states).toEqual(['thinking']);
    // 请求这时候才刚发出去，状态已经切了
    expect(chat.seen).toHaveLength(1);
    expect(chat.seen[0].req).toMatchObject({ session_id: 's1', content: '在吗' });
  });

  it('T5：本轮首个非空 delta 进 speaking', () => {
    const { store, chat } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '' });
    expect(store.get().character).toBe('thinking'); // 空 delta 不算
    chat.seen[0].handlers.onDelta?.({ text: '在' });
    expect(store.get().character).toBe('speaking');
  });

  it('T7：done 回 idle，消息不再是流式', () => {
    const { store, chat } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在的' });
    chat.seen[0].handlers.onDone?.({
      message_id: 'm1',
      tokens_in: 1,
      tokens_out: 2,
      latency_ms: 3
    });
    expect(store.get().character).toBe('idle');
    const reply = store.get().messages.at(-1);
    expect(reply?.content).toBe('在的');
    expect(reply?.streaming).toBe(false);
  });

  it('T6：done 先于任何 delta 到达也回 idle', () => {
    const { store, chat, states } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDone?.({
      message_id: 'm1',
      tokens_in: 1,
      tokens_out: 0,
      latency_ms: 3
    });
    expect(store.get().character).toBe('idle');
    expect(states).toEqual(['thinking', 'idle']); // 没经过 speaking
  });

  it('T6 / T7：error 事件回 idle，并把带 hint 的错误挂在这条回复上', () => {
    const onStreamError = vi.fn();
    const bridge = recordingBridge();
    const chat = fakeChat();
    const store = createChatStore('s1', { bridge, chat: chat.impl, onStreamError });
    store.send('在吗');
    chat.seen[0].handlers.onError?.({
      code: 'upstream_down',
      message: '模型没回',
      hint: '换一个供应商'
    });
    expect(store.get().character).toBe('idle');
    expect(store.get().messages.at(-1)?.error).toMatchObject({ hint: '换一个供应商' });
    expect(onStreamError).toHaveBeenCalledOnce();
  });

  it('T8：回复途中再次提交，先中止当前流，再回到 thinking', () => {
    const { store, chat } = setup();
    store.send('第一句');
    chat.seen[0].handlers.onDelta?.({ text: '嗯' });
    expect(store.get().character).toBe('speaking');

    store.send('第二句');
    expect(chat.seen[0].aborted).toBe(true);
    expect(store.get().character).toBe('thinking');
    expect(chat.seen).toHaveLength(2);
  });

  it('用户点停止：中止流并回 idle', () => {
    const { store, chat } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在' });
    store.stop();
    expect(chat.seen[0].aborted).toBe(true);
    expect(store.get().character).toBe('idle');
    expect(store.get().busy).toBe(false);
  });

  it('空内容不发，也不报错', () => {
    const { store, chat } = setup();
    store.send('   ');
    expect(chat.seen).toHaveLength(0);
    expect(store.get().messages).toHaveLength(0);
    expect(store.get().character).toBe('idle');
  });
});

describe('createChatStore · AD-5 转发', () => {
  it('每个 delta 都经 forwardDelta 转发给桌宠，done 转 forwardDone', () => {
    const { store, chat, bridge } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在' });
    chat.seen[0].handlers.onDelta?.({ text: '的' });
    chat.seen[0].handlers.onDone?.({ message_id: 'm', tokens_in: 0, tokens_out: 0, latency_ms: 0 });

    const deltas = bridge.calls.filter((c) => c[0] === 'forwardDelta');
    expect(deltas).toEqual([
      ['forwardDelta', 's1', '在'],
      ['forwardDelta', 's1', '的']
    ]);
    expect(bridge.calls.filter((c) => c[0] === 'forwardDone')).toHaveLength(1);
  });

  it('每次状态切换都 setPetState 一次，桌宠不自己推断', () => {
    const { store, chat, bridge } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在' });
    chat.seen[0].handlers.onDone?.({ message_id: 'm', tokens_in: 0, tokens_out: 0, latency_ms: 0 });
    expect(bridge.calls.filter((c) => c[0] === 'setPetState').map((c) => c[1])).toEqual([
      'thinking',
      'speaking',
      'idle'
    ]);
  });
});

describe('createChatStore · meta 与回复完成', () => {
  it('meta.recall_ids 挂到这条回复上，给「参考了 N 条记忆」用', () => {
    const { store, chat } = setup();
    store.send('上次说的那事');
    chat.seen[0].handlers.onMeta?.({
      model: 'mock-chat',
      memory_used: true,
      recall_ids: ['fact_a', 'fact_b']
    });
    expect(store.get().messages.at(-1)?.recallIds).toEqual(['fact_a', 'fact_b']);
    expect(store.get().messages.at(-1)?.memoryUsed).toBe(true);
  });

  it('done 之后把全文交出去跑拒绝式与情绪推断', () => {
    const onReplyComplete = vi.fn();
    const bridge = recordingBridge();
    const chat = fakeChat();
    const store = createChatStore('s1', { bridge, chat: chat.impl, onReplyComplete });
    store.send('帮我改一下');
    chat.seen[0].handlers.onDelta?.({ text: '这个我做不了' });
    chat.seen[0].handlers.onDone?.({ message_id: 'm', tokens_in: 0, tokens_out: 0, latency_ms: 0 });
    expect(onReplyComplete).toHaveBeenCalledWith('这个我做不了', '帮我改一下');
  });

  it('audio 事件收到就丢弃（TTS 推迟到 M5），不影响状态', () => {
    const { store, chat } = setup();
    store.send('念一遍');
    chat.seen[0].handlers.onDelta?.({ text: '好' });
    chat.seen[0].handlers.onAudio?.({ pcm_b64: 'AAA=', sample_rate: 16000, rms: 0.4 });
    expect(store.get().character).toBe('speaking');
  });

  it('发过的话进 outbox，供输入框的 ↑ 往前翻', () => {
    const { store } = setup();
    store.send('第一句');
    store.send('第二句');
    expect(store.get().outbox).toEqual(['第一句', '第二句']);
  });
});
