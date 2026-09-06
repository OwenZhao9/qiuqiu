/**
 * 状态机：四态迁移、500 ms 最短停留、1600 ms 事件表情、唤醒过场，
 * 以及 `feedEnvelope` 的包络曲线（逐行对着 `design/state-machine.md` § 4 的取值表）。
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CharacterMachine,
  canTransition,
  envelopeGate,
  envelopeLevel,
  smoothToward,
  voiceScale,
  voiceTranslateY,
  VoicePulse,
  EVENT_EMOTION_MS,
  MIN_DWELL_MS,
  REPLY_EMOTION_MS,
  STATE_EMOTION,
  VOICE_FALL_TAU,
  VOICE_RISE_TAU,
  VOICE_SILENCE_MS,
  type EmotionSink
} from '../src/state-machine.js';
import {
  applyEvent,
  applyError,
  applyReply,
  applyStop,
  applySubmit,
  SUBMIT_EMOTION_MS
} from '../src/event-map.js';
import type { CharacterState, EmotionId } from '../src/types.js';
import { fromRepo } from './helpers/paths.js';

/* ------------------------------------------------------------------ *
 * 假 sink
 * ------------------------------------------------------------------ */

interface Recorder extends EmotionSink {
  readonly log: EmotionId[];
  current: EmotionId | null;
  voiceOpen: boolean;
  idleResets: number;
}

function recorder(initial: EmotionId | null = '02'): Recorder {
  const log: EmotionId[] = [];
  const rec: Recorder = {
    log,
    current: initial,
    voiceOpen: false,
    idleResets: 0,
    setEmotion(id) {
      rec.current = id;
      log.push(id);
    },
    currentEmotion: () => rec.current,
    startVoice() {
      rec.voiceOpen = true;
    },
    stopVoice() {
      rec.voiceOpen = false;
    },
    resetIdle() {
      rec.idleResets += 1;
    }
  };
  return rec;
}

function machine(initialState: CharacterState = 'idle', sink = recorder()) {
  return { m: new CharacterMachine({ sink, initialState }), sink };
}

/* ------------------------------------------------------------------ *
 * 迁移表
 * ------------------------------------------------------------------ */

describe('迁移表 T1–T10（design/state-machine.md § 2）', () => {
  const allowed: Array<[CharacterState, CharacterState]> = [
    ['idle', 'thinking'], // T1
    ['idle', 'listening'], // T2
    ['listening', 'thinking'], // T3
    ['listening', 'idle'], // T4
    ['thinking', 'speaking'], // T5
    ['thinking', 'idle'], // T6
    ['speaking', 'idle'], // T7
    ['speaking', 'thinking'], // T8
    ['thinking', 'listening'], // T9
    ['speaking', 'listening'] // T9
  ];

  for (const [from, to] of allowed) {
    it(`允许 ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  it('挡下表里没有的组合：idle → speaking、listening → speaking', () => {
    expect(canTransition('idle', 'speaking')).toBe(false);
    expect(canTransition('listening', 'speaking')).toBe(false);
  });

  it('自己到自己不算迁移', () => {
    for (const s of ['idle', 'listening', 'thinking', 'speaking'] as CharacterState[]) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('非法迁移被忽略，不报错、不切表情', () => {
    const { m, sink } = machine('idle');
    expect(m.setState('speaking')).toBe(false);
    expect(m.getState()).toBe('idle');
    expect(sink.log).toEqual([]);
  });

  it('force 可以绕过迁移表', () => {
    const { m } = machine('idle');
    expect(m.setState('speaking', { force: true })).toBe(true);
    expect(m.getState()).toBe('speaking');
  });
});

/* ------------------------------------------------------------------ *
 * 状态 → 表情
 * ------------------------------------------------------------------ */

describe('setState 切到对应表情', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('任务书验收：thinking → 30，speaking → 39', () => {
    const { m, sink } = machine('idle');
    m.setState('thinking');
    expect(sink.current).toBe('30');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    m.setState('speaking');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    expect(sink.current).toBe('39');
  });

  it('listening → 35（打断恒为立即切）', () => {
    const { m, sink } = machine('idle');
    m.setState('listening');
    expect(sink.current).toBe('35');
  });

  it('回 idle → 02，并复位闲置计时', () => {
    const { m, sink } = machine('thinking');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    m.setState('idle');
    vi.advanceTimersByTime(MIN_DWELL_MS);
    expect(sink.current).toBe('02');
    expect(sink.idleResets).toBe(1);
  });

  it('STATE_EMOTION 与契约一致', () => {
    expect(STATE_EMOTION).toEqual({ idle: '02', listening: '35', thinking: '30', speaking: '39' });
  });
});

/* ------------------------------------------------------------------ *
 * 最短停留
 * ------------------------------------------------------------------ */

describe('500 ms 最短停留（只约束表情，不约束状态语义）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('不足 500 ms 时表情挂起，状态变量立即翻转', () => {
    const { m, sink } = machine('idle');
    m.setState('thinking');
    expect(sink.current).toBe('30');

    vi.advanceTimersByTime(100);
    m.setState('speaking');
    expect(m.getState()).toBe('speaking'); // 状态立即翻转
    expect(sink.current).toBe('30'); // 表情还挂着

    vi.advanceTimersByTime(MIN_DWELL_MS - 100);
    expect(sink.current).toBe('39');
  });

  it('挂起期间被覆盖时只切最后那一个，且只切一次', () => {
    const { m, sink } = machine('idle');
    m.setState('thinking');
    const before = sink.log.length;

    vi.advanceTimersByTime(50);
    m.setState('speaking');
    vi.advanceTimersByTime(50);
    m.setState('thinking');
    vi.advanceTimersByTime(MIN_DWELL_MS);

    expect(sink.log.slice(before)).toEqual(['30']);
    expect(sink.current).toBe('30');
  });

  it('immediate 跳过最短停留（T9 打断 / T10 断连）', () => {
    const { m, sink } = machine('idle');
    m.setState('thinking');
    vi.advanceTimersByTime(10);
    m.setState('idle', { immediate: true });
    expect(sink.current).toBe('02');
  });
});

/* ------------------------------------------------------------------ *
 * 事件表情
 * ------------------------------------------------------------------ */

describe('1600 ms 事件表情', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('任务书验收：write 事件切 10，1600 ms 后回 idle 的 02', () => {
    const { m, sink } = machine('idle');
    applyEvent(m, { type: 'write', payload: { facts: [{ id: 'f1', text: '喜欢美式' }] } });
    expect(sink.current).toBe('10');

    vi.advanceTimersByTime(EVENT_EMOTION_MS - 1);
    expect(sink.current).toBe('10');

    vi.advanceTimersByTime(1);
    expect(sink.current).toBe('02');
  });

  it('回到的是**当前**状态的表情，不是进入事件时的那个', () => {
    const { m, sink } = machine('idle');
    applyEvent(m, { type: 'merge', payload: { result_id: 'm1' } });
    expect(sink.current).toBe('19');

    m.setState('thinking'); // 事件表情期间状态变了
    expect(sink.current).toBe('19'); // 事件表情优先，压住状态表情

    vi.advanceTimersByTime(EVENT_EMOTION_MS);
    expect(sink.current).toBe('30');
  });

  it('事件表情压过最短停留，立即切', () => {
    const { m, sink } = machine('idle');
    m.setState('thinking');
    vi.advanceTimersByTime(10);
    applyError(m);
    expect(sink.current).toBe('34');
  });

  it('不排队：新的立即覆盖旧的并重置计时器', () => {
    const { m, sink } = machine('idle');
    applyEvent(m, { type: 'merge', payload: {} });
    vi.advanceTimersByTime(1000);
    applyEvent(m, {
      type: 'recall',
      payload: { hits: [{ id: 'h', text: 'x' }], cold_promoted: ['c'] }
    });
    expect(sink.current).toBe('40');

    vi.advanceTimersByTime(1000); // 距第一条已 2000 ms，但计时器重置过
    expect(sink.current).toBe('40');

    vi.advanceTimersByTime(EVENT_EMOTION_MS - 1000);
    expect(sink.current).toBe('02');
  });

  it('同一毫秒内多条取优先级最高，优先级相同取后到的', () => {
    const { m, sink } = machine('idle');
    m.applyEventEmotion('19', 50); // merge
    m.applyEventEmotion('34', 90); // error 更高
    expect(sink.current).toBe('34');
    m.applyEventEmotion('19', 50); // 更低，同一毫秒内被挡
    expect(sink.current).toBe('34');
    m.applyEventEmotion('37', 90); // 同优先级，后到的赢
    expect(sink.current).toBe('37');
  });

  it('filter.reject / filter.accept / 空 recall 不切表情', () => {
    const { m, sink } = machine('idle');
    expect(applyEvent(m, { type: 'filter', payload: { decision: 'reject' } })).toBeNull();
    expect(applyEvent(m, { type: 'filter', payload: { decision: 'accept' } })).toBeNull();
    expect(applyEvent(m, { type: 'recall', payload: { hits: [], cold_promoted: [] } })).toBeNull();
    expect(sink.log).toEqual([]);
  });

  it('recall 有 cold_promoted 用 40，否则命中用 37', () => {
    const { m } = machine('idle');
    expect(
      applyEvent(m, {
        type: 'recall',
        payload: { hits: [{ id: 'h', text: 'x' }], cold_promoted: ['c'] }
      })
    ).toBe('40');
    expect(
      applyEvent(m, {
        type: 'recall',
        payload: { hits: [{ id: 'h', text: 'x' }], cold_promoted: [] }
      })
    ).toBe('37');
  });

  it('done 之后：拒绝式命中用 38 并跳过情绪推断', () => {
    const { m, sink } = machine('speaking');
    expect(applyReply(m, '这类问题我不便回答，太好了这种词也不该让我变开心。')).toBe('38');
    expect(sink.current).toBe('38');
  });

  /**
   * 回复的情绪停 `REPLY_EMOTION_MS`，比记忆事件的 1600 ms 久。
   *
   * 记忆事件是一闪而过的提示，1.6 s 够；「这句回复的情绪」是这句话本身的表情，
   * 而回复要流十几秒、读还要更久。按 1.6 s 收掉的话，问它「表演个生气的」，
   * 脸上确实变过，只是没人赶得上看见。
   */
  it('done 之后：情绪推断结果作为优先级 30 的事件表情，停得比记忆事件久', () => {
    const { m, sink } = machine('speaking');
    expect(applyReply(m, '太好了，那这周就照这个节奏来。')).toBe('10');
    expect(sink.current).toBe('10');
    vi.advanceTimersByTime(EVENT_EMOTION_MS + 100);
    expect(sink.current, '记忆事件那个时长到了还不能收').toBe('10');
    vi.advanceTimersByTime(REPLY_EMOTION_MS - EVENT_EMOTION_MS);
    expect(sink.current).toBe('39'); // 回到 speaking 的表情
  });

  it('记忆事件仍然是 1600 ms，没被回复那条带长', () => {
    const { m, sink } = machine('idle');
    applyEvent(m, { type: 'write', payload: { facts: [{ id: 'f', text: 'x' }] } });
    expect(sink.current).toBe('10');
    vi.advanceTimersByTime(EVENT_EMOTION_MS);
    expect(sink.current).toBe('02');
  });

  it('情绪推断落回 02 时不切表情', () => {
    const { m, sink } = machine('speaking');
    expect(applyReply(m, '以下是三种可选方案。第一种……')).toBeNull();
    expect(sink.log).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 唤醒过场
 * ------------------------------------------------------------------ */

describe('唤醒过场（design/character.md § 4）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('当前是 00 睡眠时离开 idle 先切 01，引擎报 02 后补上当前状态的表情', () => {
    const sink = recorder('00');
    const m = new CharacterMachine({ sink, initialState: 'idle' });
    m.setState('thinking');
    expect(sink.current).toBe('01');
    expect(m.isWaking()).toBe(true);

    m.onEngineEmotion('02'); // 引擎的 settle: { next: '02' } 播完
    expect(m.isWaking()).toBe(false);
    expect(sink.current).toBe('30');
  });

  it('当前是 04 发呆时不走过场，直接切目标表情', () => {
    const sink = recorder('04');
    const m = new CharacterMachine({ sink, initialState: 'idle' });
    m.setState('thinking');
    expect(sink.current).toBe('30');
  });

  it('引擎不回调时有兜底超时', () => {
    const sink = recorder('00');
    const m = new CharacterMachine({ sink, initialState: 'idle' });
    m.setState('thinking');
    expect(sink.current).toBe('01');
    vi.advanceTimersByTime(3000);
    expect(sink.current).toBe('30');
  });
});

/* ------------------------------------------------------------------ *
 * 发声脉动曲线
 * ------------------------------------------------------------------ */

const DOC = readFileSync(fromRepo('design', 'state-machine.md'), 'utf8');

interface CurveRow {
  rms: number;
  u: number;
  level: number;
  scale: number;
  translateY: number;
}

/** 解析 § 4 的「曲线取值表」。 */
function parseCurve(): CurveRow[] {
  const start = DOC.indexOf('**曲线取值表**');
  expect(start, 'design/state-machine.md 里找不到曲线取值表').toBeGreaterThan(-1);
  const block = DOC.slice(start, DOC.indexOf('\n**第三步', start));
  const rows: CurveRow[] = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim().replace(/`/g, ''));
    if (cells.length !== 5) continue;
    const rms = Number(cells[0]);
    if (!Number.isFinite(rms)) continue; // 表头、分隔行、「≥ 0.35」那行
    rows.push({
      rms,
      u: Number(cells[1]),
      level: Number(cells[2]),
      scale: Number(cells[3]),
      // 表里是 U+2212 减号，不是 ASCII 连字符
      translateY: Number(cells[4]!.replace('px', '').replace('−', '-').trim())
    });
  }
  return rows;
}

describe('feedEnvelope 曲线逐行对着 design/state-machine.md § 4（容差 ±0.005）', () => {
  const rows = parseCurve();

  it('表里解析出 11 行', () => {
    expect(rows).toHaveLength(11);
  });

  for (const row of rows) {
    it(`rms=${row.rms} → u=${row.u} level=${row.level} scale=${row.scale} y=${row.translateY}px`, () => {
      expect(envelopeGate(row.rms)).toBeCloseTo(row.u, 2);
      expect(envelopeLevel(row.rms)).toBeCloseTo(row.level, 2);
      expect(voiceScale(envelopeLevel(row.rms))).toBeCloseTo(row.scale, 2);
      expect(voiceTranslateY(envelopeLevel(row.rms))).toBeCloseTo(row.translateY, 2);
      // 设计文档写的容差是 ±0.005
      expect(Math.abs(envelopeLevel(row.rms) - row.level)).toBeLessThanOrEqual(0.005);
    });
  }

  it('rms 超过 0.35 一律压到满幅', () => {
    expect(envelopeLevel(0.5)).toBe(1);
    expect(envelopeLevel(9)).toBe(1);
  });

  it('门限以下与非法输入都是 0', () => {
    expect(envelopeLevel(0)).toBe(0);
    expect(envelopeLevel(0.02)).toBe(0);
    expect(envelopeLevel(-1)).toBe(0);
    expect(envelopeLevel(Number.NaN)).toBe(0);
  });
});

describe('起落平滑', () => {
  it('60 fps 下起 k≈0.310、落 k≈0.121', () => {
    const dt = 1000 / 60;
    expect(smoothToward(0, 1, dt)).toBeCloseTo(1 - Math.exp(-dt / VOICE_RISE_TAU), 6);
    expect(smoothToward(0, 1, dt)).toBeCloseTo(0.31, 2);
    expect(1 - smoothToward(1, 0, dt)).toBeCloseTo(1 - Math.exp(-dt / VOICE_FALL_TAU), 6);
    expect(1 - smoothToward(1, 0, dt)).toBeCloseTo(0.121, 2);
  });

  it('30 fps 下起 k≈0.523、落 k≈0.226', () => {
    const dt = 1000 / 30;
    expect(smoothToward(0, 1, dt)).toBeCloseTo(0.523, 2);
    expect(1 - smoothToward(1, 0, dt)).toBeCloseTo(0.226, 2);
  });

  it('dt 钳在 [1, 50] ms，切回前台不会一帧跳变', () => {
    expect(smoothToward(0, 1, 5000)).toBeCloseTo(smoothToward(0, 1, 50), 10);
    expect(smoothToward(0, 1, 0)).toBeCloseTo(smoothToward(0, 1, 1), 10);
  });

  it('起快落慢', () => {
    const dt = 16;
    const rise = smoothToward(0.5, 1, dt) - 0.5;
    const fall = 0.5 - smoothToward(0.5, 0, dt);
    expect(rise).toBeGreaterThan(fall);
  });
});

describe('VoicePulse 生命周期', () => {
  it('喂正弦波后值会跟着起伏，静音看门狗到点归零', () => {
    const p = new VoicePulse();
    let t = 0;
    const peaks: number[] = [];
    for (let i = 0; i < 60; i++) {
      t += 16;
      p.feed(0.18 + 0.15 * Math.sin(i / 3), t);
      peaks.push(p.step(16, t));
    }
    expect(Math.max(...peaks)).toBeGreaterThan(0.5);
    expect(Math.min(...peaks.slice(10))).toBeLessThan(Math.max(...peaks));

    // 超过 250 ms 没有 audio 事件，目标归零，再靠 130 ms 的释放常数落到 0
    for (let i = 0; i < 120; i++) {
      t += 16;
      p.step(16, t);
    }
    expect(p.value).toBe(0);
    expect(p.idle).toBe(true);
    expect(VOICE_SILENCE_MS).toBe(250);
  });

  it('release 之后自然落回 0', () => {
    const p = new VoicePulse();
    // 每帧都喂，模拟 TTS 持续在发 audio 事件
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 16;
      p.feed(0.35, t);
      p.step(16, t);
    }
    expect(p.value).toBeGreaterThan(0.9);
    p.release();
    for (let i = 0; i < 80; i++) {
      t += 16;
      p.step(16, t);
    }
    expect(p.value).toBe(0);
  });
});

describe('feedEnvelope 只在 speaking 期间生效', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('非 speaking 状态下静默丢弃', () => {
    const { m } = machine('idle');
    m.feedEnvelope(0.3);
    expect(m.getPulse().target).toBe(0);
  });

  it('进入 speaking 打开脉动通道，离开时关掉', () => {
    const { m, sink } = machine('thinking');
    m.setState('speaking');
    expect(sink.voiceOpen).toBe(true);
    m.feedEnvelope(0.35);
    expect(m.getPulse().target).toBeCloseTo(1, 6);

    vi.advanceTimersByTime(MIN_DWELL_MS);
    m.setState('idle');
    expect(sink.voiceOpen).toBe(false);
    expect(m.getPulse().target).toBe(0);
  });

  it('speaking 期间切事件表情，脉动不受影响', () => {
    const { m, sink } = machine('thinking');
    m.setState('speaking');
    m.feedEnvelope(0.3);
    const before = m.getPulse().target;
    applyEvent(m, { type: 'write', payload: { facts: [{ id: 'f', text: 'x' }] } });
    expect(sink.current).toBe('10');
    expect(m.getPulse().target).toBe(before);
    expect(sink.voiceOpen).toBe(true);
  });
});

describe('用户动作也联动表情', () => {
  /**
   * 原来只有「记忆事件」和「回复情绪」两个来源，用户自己的动作一个都不接：
   * 按下发送直接跳思考，点停止脸上毫无反应。中间件既然坐在模型和用户中间，
   * 这两头的事都该反映到脸上。
   */
  it('按下发送先点头收到（31），600 ms 后让位给思考', () => {
    vi.useFakeTimers();
    const { m, sink } = machine('idle');
    expect(applySubmit(m)).toBe('31');
    expect(sink.current).toBe('31');
    vi.advanceTimersByTime(SUBMIT_EMOTION_MS);
    expect(sink.current, '让位给当前状态的表情').toBe('02');
    vi.useRealTimers();
  });

  it('带图片提交是好奇（03），不是点头', () => {
    const { m, sink } = machine('idle');
    expect(applySubmit(m, true)).toBe('03');
    expect(sink.current).toBe('03');
  });

  it('点停止切 41，优先级压过正在演的召回表情', () => {
    const { m, sink } = machine('thinking');
    applyEvent(m, {
      type: 'recall',
      payload: { hits: [{ id: 'h', text: 'x' }], cold_promoted: [] }
    });
    expect(sink.current).toBe('37');
    expect(applyStop(m)).toBe('41');
    expect(sink.current, '用户要的就是「停下」这个反馈').toBe('41');
  });

  it('反过来：提交那一下压不过任何真事件', () => {
    const { m, sink } = machine('idle');
    applyEvent(m, { type: 'write', payload: { facts: [{ id: 'f', text: 'x' }] } });
    expect(sink.current).toBe('10');
    applySubmit(m);
    expect(sink.current, '同一刻到达时按优先级，20 输给 50').toBe('10');
  });
});
