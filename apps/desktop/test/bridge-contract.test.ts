/**
 * `window.qiuqiu` 的契约测试：签名与通道要与 `docs/CONTRACTS.md` § 2 逐字对上。
 *
 * preload 只是把这个工厂的产物 `exposeInMainWorld`，所以喂一个假 ipcRenderer 就能全测。
 */

import { describe, expect, it, vi } from 'vitest';
import { createQiuqiuBridge, type IpcLike } from '../src/bridge-factory.js';
import { TO_MAIN, TO_RENDERER } from '../src/channels.js';

type Listener = (event: unknown, ...args: unknown[]) => void;

function fakeIpc() {
  const sent: Array<[string, ...unknown[]]> = [];
  // 一条通道可以有多个监听——「订两份收两份」正是要测的那个 bug
  const handlers = new Map<string, Listener[]>();
  const ipc: IpcLike = {
    send: (channel, ...args) => sent.push([channel, ...args]),
    on: (channel, listener) => handlers.set(channel, [...(handlers.get(channel) ?? []), listener]),
    removeListener: (channel, listener) =>
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((l) => l !== listener)
      )
  };
  return {
    ipc,
    sent,
    emit(channel: string, ...args: unknown[]) {
      for (const l of [...(handlers.get(channel) ?? [])]) l({}, ...args);
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
  'forwardReply',
  'forwardDone',
  'setPetState',
  'submitFromPet',
  'callFromPet',
  'onReply',
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

  it('AD-5：forwardReply / forwardDone / setPetState 是主窗口往桌宠的单向通道', () => {
    const f = fakeIpc();
    const b = createQiuqiuBridge(f.ipc);
    b.forwardReply('s1', '你好');
    b.forwardDone('s1');
    b.setPetState('speaking', '39');
    b.setPetState('idle');
    expect(f.sent).toEqual([
      [TO_MAIN.forwardReply, 's1', '你好'],
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

  it('onReply 收主进程转发来的 (sessionId, 这一轮的全文)', () => {
    const f = fakeIpc();
    const cb = vi.fn();
    createQiuqiuBridge(f.ipc).onReply(cb);
    f.emit(TO_RENDERER.reply, 's1', '一');
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

describe('订阅要能退订', () => {
  /**
   * 只订不退是这个项目栽过三次的坑：React 的 effect 在开发模式下跑两遍、
   * 组件随页面切换重挂，监听就越攒越多。桌宠气泡里一条 delta 被拼两遍，
   * 回复就成了「好好问题问题」那样每个字重复。
   */
  const SUBSCRIBERS = [
    'onReply',
    'onDone',
    'onPetState',
    'onSubmitFromPet',
    'onCallFromPet',
    'onPetFocus',
    'onAmbientToggle',
    'onSkin',
    'onPoke'
  ] as const;

  it('每个 onX 都返回退订函数，调了就真的不再收', () => {
    for (const name of SUBSCRIBERS) {
      const { ipc, emit } = fakeIpc();
      const bridge = createQiuqiuBridge(ipc);
      const seen: number[] = [];
      const off = (bridge[name] as (cb: () => void) => () => void)(() => seen.push(1));
      expect(typeof off, `${name} 应该返回退订函数`).toBe('function');

      const channel = Object.entries(TO_RENDERER).find(([k]) =>
        name.toLowerCase().endsWith(k.toLowerCase())
      )?.[1];
      expect(channel, `${name} 找不到对应通道`).toBeTruthy();

      emit(channel!, 'x', 'y');
      expect(seen.length, `${name} 订了应该收得到`).toBe(1);
      off();
      emit(channel!, 'x', 'y');
      expect(seen.length, `${name} 退订之后不该再收`).toBe(1);
    }
  });

  it('订两份就收两份——这正是气泡里每个字重复的成因', () => {
    const { ipc, emit } = fakeIpc();
    const bridge = createQiuqiuBridge(ipc);
    let n = 0;
    const a = bridge.onReply(() => void n++);
    const b = bridge.onReply(() => void n++);
    emit(TO_RENDERER.reply, 's', '你');
    expect(n).toBe(2);
    a();
    b();
    emit(TO_RENDERER.reply, 's', '好');
    expect(n).toBe(2);
  });
});
