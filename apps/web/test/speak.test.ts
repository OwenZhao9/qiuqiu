/**
 * TTS 播放。后端每轮都在合成、按帧推过来，前端原来收到就丢——合成的钱照花，
 * 声音一次没响过。这里守住「收到就播、排队接上、停就停干净」。
 */

import { describe, expect, it, vi } from 'vitest';
import { BUFFER_MS, LEAD_MS, base64ToPcm16, createSpeaker } from '../src/speak.js';

/** 假的 AudioContext，只记下发生了什么。 */
function fakeCtx() {
  const started: { at: number; length: number; rate: number }[] = [];
  const stopped: number[] = [];
  let closed = false;
  const ctx = {
    currentTime: 0,
    createBuffer(_ch: number, length: number, rate: number) {
      return {
        length,
        duration: length / rate,
        getChannelData: () => new Float32Array(length),
        _rate: rate
      };
    },
    createBufferSource() {
      let buffer: { length: number; duration: number; _rate: number } | null = null;
      const src = {
        get buffer() {
          return buffer;
        },
        set buffer(b) {
          buffer = b;
        },
        connect() {},
        start(at: number) {
          started.push({ at, length: buffer!.length, rate: buffer!._rate });
        },
        stop() {
          stopped.push(started.length);
        },
        onended: null as null | (() => void)
      };
      return src;
    },
    destination: {},
    close: vi.fn(async () => {
      closed = true;
    })
  };
  return { ctx, started, stopped, isClosed: () => closed };
}

/** n 个采样的静音，编成 base64。 */
function silence(n: number): string {
  const bytes = new Uint8Array(n * 2);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe('base64ToPcm16', () => {
  it('字节数是奇数时丢掉半个采样，不让整个缓冲错位', () => {
    const bin = String.fromCharCode(1, 2, 3);
    expect(base64ToPcm16(btoa(bin)).length).toBe(1);
  });

  it('空串给空数组', () => {
    expect(base64ToPcm16('').length).toBe(0);
  });
});

describe('createSpeaker', () => {
  it('攒够一段再排，接在上一段后面，中间不留缝', () => {
    const f = fakeCtx();
    const s = createSpeaker({ makeContext: () => f.ctx as unknown as AudioContext });
    s.push(silence(16000), 16000); // 1 秒，超过 240ms 的门槛，立刻排
    s.push(silence(8000), 16000); // 0.5 秒
    // 首段垫 180ms，第二段紧接其后
    expect(f.started.map((x) => x.at)).toEqual([LEAD_MS / 1000, LEAD_MS / 1000 + 1]);
  });

  it('不足一段的帧先攒着，不一帧一个节点', () => {
    // 一帧 20ms。一帧一个 AudioBuffer 的话，16k 到 48k 的重采样一秒要接五十次缝，
    // 听上去就是持续的电流声——开头最吵，等队列跑到前面去了才好
    const f = fakeCtx();
    const s = createSpeaker({ makeContext: () => f.ctx as unknown as AudioContext });
    for (let i = 0; i < 5; i += 1) s.push(silence(320), 16000); // 共 100ms
    expect(f.started).toHaveLength(0);

    for (let i = 0; i < 8; i += 1) s.push(silence(320), 16000); // 累计 260ms，过门槛
    expect(f.started).toHaveLength(1);
    expect(f.started[0]!.length).toBeGreaterThanOrEqual((16000 * BUFFER_MS) / 1000);
  });

  it('空帧不建节点', () => {
    const f = fakeCtx();
    const s = createSpeaker({ makeContext: () => f.ctx as unknown as AudioContext });
    s.push('', 16000);
    expect(f.started).toHaveLength(0);
  });

  it('采样率给 0 时按 16k 兜底，不让 createBuffer 抛', () => {
    const f = fakeCtx();
    const s = createSpeaker({ makeContext: () => f.ctx as unknown as AudioContext });
    s.push(silence(16000), 0); // 够一段，立刻排
    expect(f.started[0]!.rate).toBe(16000);
  });

  it('stop 立刻掐掉所有还在播的，并把队列时间归零', () => {
    const f = fakeCtx();
    const s = createSpeaker({ makeContext: () => f.ctx as unknown as AudioContext });
    s.push(silence(16000), 16000);
    s.push(silence(16000), 16000);
    s.stop();
    expect(f.stopped).toHaveLength(2);
    expect(f.isClosed()).toBe(true);

    // 停完再来一轮，从头排，不接着上一轮的时间
    const g = fakeCtx();
    const s2 = createSpeaker({ makeContext: () => g.ctx as unknown as AudioContext });
    s2.push(silence(16000), 16000);
    expect(g.started[0]!.at).toBe(LEAD_MS / 1000);
  });

  it('重复 stop 不炸', () => {
    const f = fakeCtx();
    const s = createSpeaker({ makeContext: () => f.ctx as unknown as AudioContext });
    s.push(silence(16000), 16000);
    s.stop();
    expect(() => s.stop()).not.toThrow();
  });
});
