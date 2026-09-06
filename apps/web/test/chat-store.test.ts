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

function setup(extra: Partial<Parameters<typeof createChatStore>[1]> = {}) {
  const bridge = recordingBridge();
  const chat = fakeChat();
  const states: string[] = [];
  const store = createChatStore('s1', {
    bridge,
    chat: chat.impl,
    onCharacterState: (s) => states.push(s),
    ...extra
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

  it('T7：声音还在响就不回 idle——`done` 是文字流完了，不是丘丘闭嘴', () => {
    let voice = true;
    const { store, chat, states } = setup({ speechActive: () => voice });
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在的' });
    chat.seen[0].handlers.onDone?.({
      message_id: 'm1',
      tokens_in: 1,
      tokens_out: 2,
      latency_ms: 3
    });
    // 这一句正是录屏里看到的毛病：丘丘还在出声，窗口上写着「丘丘待机」
    expect(store.get().character).toBe('speaking');
    expect(store.get().busy).toBe(false); // 流结束了，能接着打字

    voice = false;
    store.noteSpeechDrained();
    expect(store.get().character).toBe('idle');
    expect(states).toEqual(['thinking', 'speaking', 'idle']);
  });

  it('T7：没有语音时 done 当场回 idle（网页端、静音都走这条）', () => {
    const { store, chat } = setup({ speechActive: () => false });
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在的' });
    chat.seen[0].handlers.onDone?.({
      message_id: 'm1',
      tokens_in: 1,
      tokens_out: 2,
      latency_ms: 3
    });
    expect(store.get().character).toBe('idle');
    // 没在等语音的时候，排空通知不该把状态再动一次
    store.noteSpeechDrained();
    expect(store.get().character).toBe('idle');
  });

  it('等语音期间用户又发一句：不等排空，直接进 thinking', () => {
    const { store, chat, states } = setup({ speechActive: () => true });
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在的' });
    chat.seen[0].handlers.onDone?.({
      message_id: 'm1',
      tokens_in: 1,
      tokens_out: 2,
      latency_ms: 3
    });
    store.send('再说一句');
    expect(store.get().character).toBe('thinking');
    // 迟到的排空通知不能把正在思考的这一轮打回 idle
    store.noteSpeechDrained();
    expect(store.get().character).toBe('thinking');
    expect(states.at(-1)).toBe('thinking');
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
  it('转给桌宠的是这一轮的全文，不是增量', () => {
    const { store, chat, bridge } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在' });
    chat.seen[0].handlers.onDelta?.({ text: '的' });
    chat.seen[0].handlers.onDone?.({ message_id: 'm', tokens_in: 0, tokens_out: 0, latency_ms: 0 });

    const sent = bridge.calls.filter((c) => c[0] === 'forwardReply').map((c) => c[2] as string);
    // 中间几帧发几次不定（按帧合并），但每一次都必须是「到此为止的全文」，
    // 而且最后一次是完整的。桌宠只负责显示，不自己拼字
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.at(-1)).toBe('在的');
    for (const t of sent) expect('在的'.startsWith(t), `「${t}」不是全文的前缀`).toBe(true);
    expect(bridge.calls.filter((c) => c[0] === 'forwardDone')).toHaveLength(1);
  });

  it('同一段文字不会重复发——桌宠那边每收一次都要量一次布局', () => {
    const { store, chat, bridge } = setup();
    store.send('在吗');
    chat.seen[0].handlers.onDelta?.({ text: '在' });
    chat.seen[0].handlers.onDone?.({ message_id: 'm', tokens_in: 0, tokens_out: 0, latency_ms: 0 });
    const sent = bridge.calls.filter((c) => c[0] === 'forwardReply').map((c) => c[2]);
    expect(new Set(sent).size).toBe(sent.length);
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

describe('createChatStore · 边说边换表情', () => {
  /**
   * 情绪推断原来只在 done 之后跑一次：整段回复期间丘丘都是「说话中」那一个表情，
   * 末尾才闪 1.6 秒真正的情绪——问它「你喜欢我吗」，害羞那个表情基本看不到。
   */
  it('流的过程中就把到此为止的全文交出去，不用等 done', () => {
    const seen: string[] = [];
    const { store, chat } = setup({ onReplyPartial: (t: string) => void seen.push(t) });
    store.send('你喜欢我吗');
    chat.seen[0].handlers.onDelta?.({ text: '这个嘛' });
    expect(seen.at(-1), '第一段就该给一次').toBe('这个嘛');
  });

  it('节流：同一帧连着来好几段，只推断一次', () => {
    const seen: string[] = [];
    const { store, chat } = setup({ onReplyPartial: (t: string) => void seen.push(t) });
    store.send('在吗');
    for (const t of ['一', '二', '三', '四']) chat.seen[0].handlers.onDelta?.({ text: t });
    expect(seen.length, '600 ms 内只该跑一次').toBe(1);
  });

  it('每一轮重新计时，下一轮第一段照样立刻推断', () => {
    const seen: string[] = [];
    const { store, chat } = setup({ onReplyPartial: (t: string) => void seen.push(t) });
    store.send('第一句');
    chat.seen[0].handlers.onDelta?.({ text: 'A' });
    chat.seen[0].handlers.onDone?.({ message_id: 'm', tokens_in: 0, tokens_out: 0, latency_ms: 0 });
    store.send('第二句');
    chat.seen[1].handlers.onDelta?.({ text: 'B' });
    expect(seen).toEqual(['A', 'B']);
  });
});

describe('createChatStore · 历史与朗读', () => {
  const rows = [
    {
      id: 'm1',
      session_id: 's1',
      role: 'user' as const,
      content: '我住深圳',
      model: null,
      favorite: false,
      attachments: ['image/abc123'],
      created_at: '2026-09-05T10:00:00.000Z'
    },
    {
      id: 'm2',
      session_id: 's1',
      role: 'assistant' as const,
      content: '记住了',
      model: 'deepseek',
      favorite: false,
      attachments: [],
      created_at: '2026-09-05T10:00:01.000Z'
    }
  ];

  /**
   * 后端一直把消息存着，下一轮也会喂给模型——丘丘记得。界面不读的话重启就一片
   * 空白：问它「刚才我说啥」它答得出，屏幕上什么都没有。
   */
  it('hydrate 把历史铺进来，时间与模型跟着走', () => {
    const { store } = setup();
    store.hydrate(rows);
    expect(store.get().messages.map((m) => m.content)).toEqual(['我住深圳', '记住了']);
    expect(store.get().messages[1]!.model).toBe('deepseek');
    expect(store.get().messages[0]!.streaming).toBe(false);
    // 发过的图也要回来：只留一行「带了 1 张图」等于图丢了
    expect(store.get().messages[0]!.attachments).toEqual([
      { type: 'image', blob_id: 'image/abc123' }
    ]);
  });

  it('已经聊上了就不铺，免得把当前这一轮冲掉', () => {
    const { store } = setup();
    store.send('在吗');
    store.hydrate(rows);
    expect(store.get().messages.map((m) => m.content)).toEqual(['在吗', '']);
  });

  it('空历史什么也不做', () => {
    const { store } = setup();
    store.hydrate([]);
    expect(store.get().messages).toHaveLength(0);
  });

  it('audio 帧交给上层去播，不再默默丢掉', () => {
    const heard: [string, number][] = [];
    const { store, chat } = setup({ onAudio: (b: string, r: number) => void heard.push([b, r]) });
    store.send('念一遍');
    chat.seen[0].handlers.onAudio?.({ pcm_b64: 'AAA=', sample_rate: 24000, rms: 0.4 });
    expect(heard).toEqual([['AAA=', 24000]]);
  });

  it('采样率缺失时按 16k 兜底', () => {
    const heard: number[] = [];
    const { store, chat } = setup({ onAudio: (_b: string, r: number) => void heard.push(r) });
    store.send('念一遍');
    chat.seen[0].handlers.onAudio?.({ pcm_b64: 'AAA=', sample_rate: 0, rms: 0 });
    expect(heard).toEqual([16000]);
  });

  it('点停止与开新一轮都要让上一轮闭嘴', () => {
    let ends = 0;
    const { store, chat } = setup({ onSpeechEnd: () => void (ends += 1) });
    store.send('第一句');
    expect(ends, '开第一轮时也报一次，幂等').toBe(1);
    chat.seen[0].handlers.onDelta?.({ text: '嗯' });
    store.stop();
    expect(ends).toBe(2);
    store.send('第二句');
    expect(ends).toBe(3);
  });
});
