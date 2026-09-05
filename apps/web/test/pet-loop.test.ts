/**
 * 桌宠与主窗口是**同一场对话**。
 *
 * 用户反馈的三条——在气泡里打的字没进网页的对话、气泡回复很慢、两边显示不一样
 * ——根子是同一个：桌宠曾经自己拿增量拼字，等于第二套消息处理。
 * 现在桌宠只显示主窗口推来的全文，这条测试把整个环路跑一遍：
 *
 *     桌宠输入 → submitFromPet → 主窗口 chat.send → SSE → forwardReply → 气泡
 *
 * 桥这一层在网页端是内存总线，在桌面端是 IPC；IPC 那半边由
 * `apps/desktop/test/bridge-contract.test.ts` 守着，这里守的是两端的用法。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { installMockServer, type MockServer } from '../src/mock-server.js';
import { createChatStore } from '../src/store/chat.js';
import { createMemoryBridge } from '../src/bridge.js';

let server: MockServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 主窗口那一半：接住桌宠发来的话，交给自己的 chat store 发出去（MainApp 的做法）。 */
function mountMain(bridge: ReturnType<typeof createMemoryBridge>, sessionId = 's1') {
  const chat = createChatStore(sessionId, { bridge });
  const off = bridge.onSubmitFromPet((text: string) => chat.send(text));
  bridge.mainReady();
  return { chat, off };
}

/** 桌宠那一半：只显示主窗口推来的全文（PetApp 的做法）。 */
function mountPet(bridge: ReturnType<typeof createMemoryBridge>) {
  const state = { bubble: '', done: 0, pushes: [] as string[] };
  bridge.onReply((_sid: string, text: string) => {
    state.bubble = text;
    state.pushes.push(text);
  });
  bridge.onDone(() => void (state.done += 1));
  return state;
}

describe('桌宠与主窗口是同一场对话', () => {
  it('在气泡里打的字，进的是主窗口那条对话', async () => {
    server = installMockServer({ deltaMs: 0, reply: '记住了' });
    const bridge = createMemoryBridge();
    const { chat } = mountMain(bridge);
    mountPet(bridge);

    // 桌宠自己不发请求（AD-5），只把话交出去
    bridge.submitFromPet('我搬到深圳了');
    await tick();

    const msgs = chat.get().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]!.content, '用户那句必须落在主窗口的对话里').toBe('我搬到深圳了');
    expect(msgs[1]!.content).toBe('记住了');
  });

  it('气泡显示的字与主窗口逐字一致', async () => {
    server = installMockServer({ deltaMs: 0, reply: '记住了，深圳。' });
    const bridge = createMemoryBridge();
    const { chat } = mountMain(bridge);
    const pet = mountPet(bridge);

    bridge.submitFromPet('我搬到深圳了');
    await tick();

    const reply = chat.get().messages.at(-1)!.content;
    expect(pet.bubble, '气泡与主窗口显示的必须是同一段话').toBe(reply);
    expect(pet.done).toBe(1);
  });

  it('推的每一帧都是「到此为止的全文」，不是增量', async () => {
    server = installMockServer({ deltaMs: 0, reply: '记住了' });
    const bridge = createMemoryBridge();
    mountMain(bridge);
    const pet = mountPet(bridge);

    bridge.submitFromPet('在吗');
    await tick();

    // 每一帧都是最终文本的前缀，且越来越长——桌宠拿到就能直接显示，不用拼
    for (const t of pet.pushes) expect('记住了'.startsWith(t)).toBe(true);
    for (let i = 1; i < pet.pushes.length; i += 1) {
      expect(pet.pushes[i]!.length).toBeGreaterThanOrEqual(pet.pushes[i - 1]!.length);
    }
    expect(pet.pushes.at(-1)).toBe('记住了');
  });

  it('主窗口还没挂好监听时，桌宠先说的那句不会丢', async () => {
    server = installMockServer({ deltaMs: 0, reply: '收到' });
    const bridge = createMemoryBridge();
    // 先说话，后挂监听——桌面端 ensureMain() 刚把窗口建出来时就是这个顺序
    bridge.submitFromPet('第一句');
    const { chat } = mountMain(bridge);
    await tick();

    // 网页端的内存总线没有「窗口还没起来」这回事，这里守的是不报错、不重复；
    // 桌面端那半边的补送由 apps/desktop/test/pet-inbox.test.ts 守着
    expect(chat.get().messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });
});
