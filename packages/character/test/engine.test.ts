/**
 * 引擎封装：`createQiuqiu` / `setEmotion` / `destroy` / 鼠标注视 / 发声脉动写 CSS 变量。
 *
 * `EmotionBall` 全局用 stub，不真跑 canvas / SVG。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createQiuqiu,
  getEmotionBall,
  normalizeEmotionId,
  GAZE_RADIUS_PX,
  IDLE_DEFAULT,
  PRESETS
} from '../src/engine.js';
import { EVENT_EMOTION_MS, MIN_DWELL_MS } from '../src/state-machine.js';
import { FALLBACK_EMOTION } from '../src/types.js';
import { makeStubEmotionBall, type StubEmotionBall } from './helpers/stub-engine.js';

let host: HTMLDivElement;
let eb: StubEmotionBall;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  eb = makeStubEmotionBall();
});

afterEach(() => {
  host.remove();
  vi.useRealTimers();
});

function make(opts: Parameters<typeof createQiuqiu>[1] = {}) {
  return createQiuqiu(host, { engine: eb, ...opts });
}

describe('createQiuqiu', () => {
  it('插入 qq-stage / qq-ball 两层，引擎挂在 qq-ball 上', () => {
    const qq = make();
    const stage = host.querySelector('.qq-stage') as HTMLElement;
    const ball = host.querySelector('.qq-ball') as HTMLElement;
    expect(stage).toBeTruthy();
    expect(ball).toBeTruthy();
    expect(ball.parentElement).toBe(stage);
    expect(qq.stage).toBe(stage);
    expect(qq.mount).toBe(ball);
    qq.destroy();
  });

  it('舞台自带脉动用的 transform 与 --qq-voice，宿主不用额外引 CSS', () => {
    const qq = make();
    expect(qq.stage.style.transform).toContain('var(--qq-voice)');
    expect(qq.stage.style.transformOrigin).toBe('50% 62%');
    expect(qq.stage.style.getPropertyValue('--qq-voice')).toBe('0');
    qq.destroy();
  });

  it('形态是 blob，fallbackId 是 02，初始表情 02', () => {
    const qq = make();
    const o = eb.lastCreateOptions!;
    expect(o.shape).toBe('blob');
    expect(o.fallbackId).toBe(FALLBACK_EMOTION);
    expect(o.emotion).toBe(FALLBACK_EMOTION);
    expect(qq.getState()).toBe('idle');
    qq.destroy();
  });

  it('三处预设的尺寸 / eyeScale / lite / idle 与 design/character.md § 3 一致', () => {
    // 闲置推进开在主窗口、关在桌宠：表情只有一个来源，桌宠跟着镜像走（AD-5b）。
    // 反过来的话桌宠会照自己的计时器睡过去，而主窗口那只还醒着
    expect(PRESETS.pet).toEqual({ size: 200, eyeScale: 1, lite: false, idle: false });
    expect(PRESETS.main).toEqual({ size: 120, eyeScale: 1.5, lite: true, idle: IDLE_DEFAULT });
    expect(PRESETS.web).toEqual({ size: 160, eyeScale: 1.2, lite: false, idle: IDLE_DEFAULT });
    expect(IDLE_DEFAULT).toEqual({
      standbyAfter: 90000,
      sleepAfter: 300000,
      standbyId: '04',
      sleepId: '00'
    });
  });

  it('preset=main 开闲置，preset=pet 关闲置', () => {
    // 桌宠不自己推进闲置：开着的话它会照自己的计时器睡过去，
    // 而主窗口那只还醒着，两个窗口两张脸
    const pet = make({ preset: 'pet' });
    expect(eb.lastCreateOptions!.idle).toBe(false);
    expect(eb.lastCreateOptions!.eyeScale).toBe(1);
    expect(eb.lastCreateOptions!.lite).toBe(false);
    pet.destroy();

    const main = make({ preset: 'main' });
    expect(eb.lastCreateOptions!.idle).toEqual(IDLE_DEFAULT);
    expect(eb.lastCreateOptions!.eyeScale).toBe(1.5);
    expect(eb.lastCreateOptions!.lite).toBe(true);
    main.destroy();
  });

  it('container 不是元素时抛带 hint 的错', () => {
    expect(() => createQiuqiu(null as unknown as HTMLElement, { engine: eb })).toThrow(
      /container 必须是一个已挂载的 HTMLElement/
    );
  });

  it('拿不到全局 EmotionBall 时抛带下一步做什么的错', () => {
    expect(() => getEmotionBall()).toThrow(/rings\.js、emotions\.js、ball\.js、engine\.js/);
  });
});

describe('setEmotion 与未知 ID 回退', () => {
  it('切合法 ID', () => {
    const qq = make();
    qq.setEmotion('30');
    expect(qq.getEmotion()).toBe('30');
    qq.destroy();
  });

  it('未知 ID 回退 02 并 warn 一次（同一个 ID 不重复刷屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeEmotionId('99')).toBe(FALLBACK_EMOTION);
    expect(normalizeEmotionId('99')).toBe(FALLBACK_EMOTION);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('未知 emotionId "99"');

    const qq = make();
    qq.setEmotion('50');
    expect(qq.getEmotion()).toBe(FALLBACK_EMOTION);
    qq.destroy();
    warn.mockRestore();
  });
});

describe('状态与事件走到真实实例上', () => {
  beforeEach(() => vi.useFakeTimers());

  it('setState("thinking") 切 30，setState("speaking") 切 39', () => {
    const qq = make();
    qq.setState('thinking');
    expect(qq.getEmotion()).toBe('30');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    qq.setState('speaking');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    expect(qq.getEmotion()).toBe('39');
    qq.destroy();
  });

  it('write 事件切 10，1600 ms 后回 02', () => {
    const qq = make();
    qq.applyEvent({ type: 'write', payload: { facts: [{ id: 'f', text: '喜欢美式' }] } });
    expect(qq.getEmotion()).toBe('10');
    vi.advanceTimersByTime(EVENT_EMOTION_MS);
    expect(qq.getEmotion()).toBe('02');
    qq.destroy();
  });

  it('applyError 切 34，applyReply 跑拒绝式与情绪推断', () => {
    const qq = make();
    qq.applyError();
    expect(qq.getEmotion()).toBe('34');
    vi.advanceTimersByTime(EVENT_EMOTION_MS);

    qq.applyReply('这类问题我不便回答。');
    expect(qq.getEmotion()).toBe('38');
    vi.advanceTimersByTime(EVENT_EMOTION_MS);

    qq.applyReply('太好了，那这周就照这个节奏来。');
    expect(qq.getEmotion()).toBe('10');
    qq.destroy();
  });

  it('setActive / resetIdle 透传给引擎', () => {
    const qq = make();
    const engine = eb.instances.at(-1)!;
    qq.setActive(false);
    expect(engine.active).toBe(false);
    const before = engine.idleResets;
    qq.resetIdle();
    expect(engine.idleResets).toBe(before + 1);
    qq.destroy();
  });
});

describe('发声脉动写 --qq-voice', () => {
  beforeEach(() => vi.useFakeTimers());

  it('speaking 期间喂 rms，CSS 变量跟着涨；停喂后落回 0', () => {
    const qq = make();
    qq.setState('thinking');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    qq.setState('speaking');

    for (let i = 0; i < 30; i++) {
      qq.feedEnvelope(0.35);
      vi.advanceTimersByTime(16);
    }
    const peak = Number(qq.stage.style.getPropertyValue('--qq-voice'));
    expect(peak).toBeGreaterThan(0.8);

    // 停喂：静音看门狗 250 ms 后目标归零，再靠 130 ms 释放常数落回
    vi.advanceTimersByTime(2000);
    expect(Number(qq.stage.style.getPropertyValue('--qq-voice'))).toBe(0);
    qq.destroy();
  });

  it('不在 speaking 时喂进来的 rms 被丢弃', () => {
    const qq = make();
    for (let i = 0; i < 20; i++) {
      qq.feedEnvelope(0.35);
      vi.advanceTimersByTime(16);
    }
    expect(Number(qq.stage.style.getPropertyValue('--qq-voice'))).toBe(0);
    qq.destroy();
  });

  it('speaking 期间切事件表情，脉动照跑（两条独立通路）', () => {
    const qq = make();
    qq.setState('thinking');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    qq.setState('speaking');
    for (let i = 0; i < 20; i++) {
      qq.feedEnvelope(0.3);
      vi.advanceTimersByTime(16);
    }
    qq.applyEvent({ type: 'write', payload: { facts: [{ id: 'f', text: 'x' }] } });
    expect(qq.getEmotion()).toBe('10');
    for (let i = 0; i < 5; i++) {
      qq.feedEnvelope(0.3);
      vi.advanceTimersByTime(16);
    }
    expect(Number(qq.stage.style.getPropertyValue('--qq-voice'))).toBeGreaterThan(0.5);
    qq.destroy();
  });
});

describe('鼠标注视跟随', () => {
  it('pointermove 换算成 setGaze，坐标归一化到 [-1, 1]', () => {
    const qq = make();
    const engine = eb.instances.at(-1)!;
    // jsdom 里 getBoundingClientRect 恒为 0，手动兜一个
    qq.mount.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 200, height: 200 }) as DOMRect;

    document.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 200 + GAZE_RADIUS_PX, clientY: 200 })
    );
    expect(engine.gaze.at(-1)).toEqual([1, 0]);

    document.dispatchEvent(new MouseEvent('pointerleave'));
    expect(engine.gaze.at(-1)).toEqual([0, 0]);
    qq.destroy();
  });

  it('gaze: false 时不挂监听', () => {
    const qq = make({ gaze: false });
    const engine = eb.instances.at(-1)!;
    qq.mount.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    expect(engine.gaze).toEqual([]);
    qq.destroy();
  });

  it('destroy 之后 pointermove 不再喂给引擎', () => {
    const qq = make();
    const engine = eb.instances.at(-1)!;
    qq.mount.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    qq.destroy();
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    expect(engine.gaze).toEqual([]);
  });
});

describe('destroy', () => {
  it('销毁引擎、摘掉 DOM、重复调用安全', () => {
    const qq = make();
    const engine = eb.instances.at(-1)!;
    qq.destroy();
    expect(engine.destroyed).toBe(true);
    expect(host.querySelector('.qq-stage')).toBeNull();
    expect(() => qq.destroy()).not.toThrow();
  });
});
