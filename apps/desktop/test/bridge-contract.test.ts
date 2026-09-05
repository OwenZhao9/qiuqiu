/**
 * `window.qiuqiu` 的契约测试：签名与通道要与 `docs/CONTRACTS.md` § 2 逐字对上。
 *
 * preload 只是把这个工厂的产物 `exposeInMainWorld`，所以喂一个假 ipcRenderer 就能全测。
 */

import { describe, expect, it, vi } from 'vitest';
import { createQiuqiuBridge, type IpcLike } from '../src/bridge-factory.js';
import { TO_MAIN, TO_RENDERER } from '../src/channels.js';

function fakeIpc() {
  const sent: Array<[string, ...unknown[]]> = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const ipc: IpcLike = {
    send: (channel, ...args) => sent.push([channel, ...args]),
    on: (channel, listener) => handlers.set(channel, listener)
  };
  return {
    ipc,
    sent,
    emit(channel: string, ...args: unknown[]) {
      handlers.get(channel)?.({}, ...args);
    }
  };
}

/** 契约 § 2 一字不差列出来的十三个成员。 */
const CONTRACT_MEMBERS = [
  'openMain',
  'hideMain',
  'hidePet',
  'resetPet',
  'focusPet',
  'quit',
  'dragPet',
  'forwardDelta',
  'forwardDone',
  'setPetState',
  'submitFromPet',
  'callFromPet',
  'onDelta',
  'onPetState'
] as const;

describe('createQiuqiuBridge · 契约 § 2', () => {
  it('契约 § 2 列的成员一个不少，全是函数', () => {
    const b = createQiuqiuBridge(fakeIpc().ipc) as unknown as Record<string, unknown>;
    for (const key of CONTRACT_MEMBERS) {
      expect(typeof b[key], key).toBe('function');
    }
  });

  it('六个窗口方法各发一条自己的消息，不带参数', () => {
    const f = fakeIpc();
    const b = createQiuqiuBridge(f.ipc);
    b.openMain();
    b.hideMain();
    b.hidePet();
    b.resetPet();
    b.focusPet();
    b.quit();
    expect(f.sent).toEqual([
      [TO_MAIN.openMain],
      [TO_MAIN.hideMain],
      [TO_MAIN.hidePet],
      [TO_MAIN.resetPet],
      [TO_MAIN.focusPet],
      [TO_MAIN.quit]
    ]);
  });

  it('dragPet 把 dx / dy 原样带过去', () => {
    const f = fakeIpc();
    createQiuqiuBridge(f.ipc).dragPet(-4, 12);
    expect(f.sent).toEqual([[TO_MAIN.dragPet, -4, 12]]);
  });

  it('AD-5：forwardDelta / forwardDone / setPetState 是主窗口往桌宠的单向通道', () => {
    const f = fakeIpc();
    const b = createQiuqiuBridge(f.ipc);
    b.forwardDelta('s1', '你好');
    b.forwardDone('s1');
    b.setPetState('speaking', '39');
    b.setPetState('idle');
    expect(f.sent).toEqual([
      [TO_MAIN.forwardDelta, 's1', '你好'],
      [TO_MAIN.forwardDone, 's1'],
      [TO_MAIN.setPetState, 'speaking', '39'],
      [TO_MAIN.setPetState, 'idle', undefined]
    ]);
  });

  it('submitFromPet 是桌宠往主窗口的那一条', () => {
    const f = fakeIpc();
    createQiuqiuBridge(f.ipc).submitFromPet('从桌宠发的');
    expect(f.sent).toEqual([[TO_MAIN.submitFromPet, '从桌宠发的']]);
  });

  it('callFromPet 只发信号，会话跑在主窗口', () => {
    // 麦克风与音频播放只该有一份，两个窗口各开一个会互相抢（AD-5 同理）
    const f = fakeIpc();
    createQiuqiuBridge(f.ipc).callFromPet();
    expect(f.sent).toEqual([[TO_MAIN.callFromPet]]);
  });

  it('onCallFromPet 收主进程转来的通话请求', () => {
    const f = fakeIpc();
    const cb = vi.fn();
    createQiuqiuBridge(f.ipc).onCallFromPet(cb);
    f.emit(TO_RENDERER.callFromPet);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('onDelta 收主进程转发来的 (sessionId, text)', () => {
    const f = fakeIpc();
    const cb = vi.fn();
    createQiuqiuBridge(f.ipc).onDelta(cb);
    f.emit(TO_RENDERER.delta, 's1', '一');
    expect(cb).toHaveBeenCalledWith('s1', '一');
  });

  it('onPetState 的 emotionId 可缺省，缺省时给 undefined 不给 "undefined"', () => {
    const f = fakeIpc();
    const cb = vi.fn();
    createQiuqiuBridge(f.ipc).onPetState(cb);
    f.emit(TO_RENDERER.petState, 'thinking');
    expect(cb).toHaveBeenCalledWith('thinking', undefined);
    f.emit(TO_RENDERER.petState, 'speaking', '39');
    expect(cb).toHaveBeenLastCalledWith('speaking', '39');
  });
});

describe('createQiuqiuBridge · 契约之外的扩展', () => {
  it('onDone 与 onSubmitFromPet 补上了契约里有发无收的两条', () => {
    const f = fakeIpc();
    const b = createQiuqiuBridge(f.ipc);
    const done = vi.fn();
    const submit = vi.fn();
    b.onDone(done);
    b.onSubmitFromPet(submit);
    f.emit(TO_RENDERER.done, 's1');
    f.emit(TO_RENDERER.submitFromPet, '桌宠说的');
    expect(done).toHaveBeenCalledWith('s1');
    expect(submit).toHaveBeenCalledWith('桌宠说的');
  });

  it('透明窗口要的三件事各有自己的通道', () => {
    const f = fakeIpc();
    const b = createQiuqiuBridge(f.ipc);
    b.setPetPassthrough(false);
    b.setPetExpanded(true);
    b.popupPetMenu({ ambientPaused: true });
    expect(f.sent).toEqual([
      [TO_MAIN.setPetPassthrough, false],
      [TO_MAIN.setPetExpanded, true],
      [TO_MAIN.popupPetMenu, { ambientPaused: true }]
    ]);
  });

  it('platform 报 desktop，网页端的同签名实现报 web', () => {
    expect(createQiuqiuBridge(fakeIpc().ipc).platform()).toBe('desktop');
  });
});

describe('通道名', () => {
  it('两个方向的通道名不重叠，避免自己收到自己发的', () => {
    const toMain = new Set(Object.values(TO_MAIN));
    const toRenderer = new Set(Object.values(TO_RENDERER));
    for (const name of toMain) expect(toRenderer.has(name as never)).toBe(false);
    expect(toMain.size).toBe(Object.values(TO_MAIN).length);
    expect(toRenderer.size).toBe(Object.values(TO_RENDERER).length);
  });
});
