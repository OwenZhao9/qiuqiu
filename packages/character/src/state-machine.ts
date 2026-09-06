/**
 * 角色状态机：四态 `idle / listening / thinking / speaking`，
 * 500 ms 最短停留防抖，1600 ms 事件表情，以及 `speaking` 的发声脉动通道。
 *
 * 全部数值与曲线来自 `design/state-machine.md`，状态与 emotionId 的对应
 * 与 `docs/CONTRACTS.md` § 6 逐字一致。
 *
 * 本模块不碰 DOM，也不碰 Emotion Ball：所有外部作用都经 `EmotionSink`。
 * `src/engine.ts` 提供真实的 sink，测试可以塞假的。
 */

import { FACTORY } from './defaults.js';
import { type CharacterState, type EmotionId } from './types.js';

/* ------------------------------------------------------------------ *
 * 状态 → 表情（docs/CONTRACTS.md § 6）
 * ------------------------------------------------------------------ */

/** 四态各自的 emotionId。 */
export const STATE_EMOTION: Readonly<Record<CharacterState, EmotionId>> = {
  idle: '02',
  listening: '35',
  thinking: '30',
  speaking: '39'
};

/** 状态最短停留时间，四态统一 500 ms。只约束表情，不约束状态语义。 */
export const MIN_DWELL_MS = FACTORY.emotion.minDwellMs;

/** 事件表情持续时间 1600 ms，到点回到**当前**状态的表情。 */
export const EVENT_EMOTION_MS = FACTORY.emotion.eventHoldMs;

/**
 * 回复情绪停留多久。
 *
 * 记忆事件（写入、召回）是一闪而过的提示，1600 ms 够了。但「这句回复的情绪」
 * 是这句话本身的表情，1.6 秒之后就切回去，等于让它演一个你看不见的表情——
 * 问它「表演个生气的」，脸上确实变过，只是没人赶得上。
 *
 * 试过 6000 ms，太黏了：一句话说完脸还僵在那儿好几秒。
 */
export const REPLY_EMOTION_MS = FACTORY.emotion.replyHoldMs;

/**
 * 引擎自驱的睡眠表情（`docs/CONTRACTS.md` § 6「引擎自驱」）。
 * 闲置满 300 s 由引擎自己切上去，宿主只负责在离开 `idle` 时认出它。
 */
export const SLEEP_EMOTION: EmotionId = '00';

/** 从 `00` 睡眠离开 `idle` 时的唤醒过场表情，序列 settle 到 `02` 后结束。 */
export const WAKE_EMOTION: EmotionId = '01';

/**
 * 唤醒过场 `01` 的兜底超时：`01` 的切入 320 ms + 睁眼序列 2100 ms。
 * 正常路径靠引擎 `change` 事件报出 `02` 结束，这条只防引擎不回调。
 */
export const WAKE_TIMEOUT_MS = 2600;

/**
 * 迁移表 T1–T10（`design/state-machine.md` § 2）。
 * 键是「从」，值是允许迁到的状态集合。表里没有的组合一律忽略，不报错、不切表情。
 *
 * 展开后只有两个组合被挡下：`idle → speaking`、`listening → speaking`。
 * 首个 `delta` 只可能在 `thinking` 期间到达（T5）。
 */
export const TRANSITIONS: Readonly<Record<CharacterState, readonly CharacterState[]>> = {
  /** T1 提交文本、T2 语音按下 */
  idle: ['thinking', 'listening'],
  /** T3 拿到 final、T4 空 final 或出错 */
  listening: ['thinking', 'idle'],
  /** T5 首个 delta、T6 出错或空回复、T9 打断 */
  thinking: ['speaking', 'idle', 'listening'],
  /** T7 done、T8 新一轮、T9 打断 */
  speaking: ['idle', 'thinking', 'listening']
};

/** 目标状态是否可以从 `from` 迁过去。 */
export function canTransition(from: CharacterState, to: CharacterState): boolean {
  return from !== to && TRANSITIONS[from].includes(to);
}

/* ------------------------------------------------------------------ *
 * 发声脉动（design/state-machine.md § 4）
 * ------------------------------------------------------------------ */

/** 噪声门：静音段的底噪不触发脉动。 */
export const VOICE_GATE = 0.02;
/** 压限跨度，天花板 = 0.02 + 0.33 = 0.35。 */
export const VOICE_SPAN = 0.33;
/** 感知伽马，< 1，把说话最常落的低区拉开。 */
export const VOICE_GAMMA = 0.6;
/** 起 45 ms。 */
export const VOICE_RISE_TAU = 45;
/** 落 130 ms。 */
export const VOICE_FALL_TAU = 130;
/** 容器 scale 增益。 */
export const VOICE_SCALE_GAIN = 0.055;
/** 容器上提像素。 */
export const VOICE_LIFT_PX = 3;
/** 静音看门狗：距上一个 audio 事件超过这个时间，目标值归零。 */
export const VOICE_SILENCE_MS = 250;
/** 收到 done / error / 打断后，继续跑这么久让 s 落到 0 再停 rAF。 */
export const VOICE_RELEASE_MS = 200;
/** dt 钳位，防止标签页切回前台时一帧跳变。 */
export const VOICE_DT_MIN = 1;
export const VOICE_DT_MAX = 50;
/** 小于这个值就写 0，避免持续触发合成层重绘。 */
export const VOICE_EPSILON = 0.001;

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** 第一步：噪声门与压限，`u = clamp((rms - 0.02) / 0.33, 0, 1)`。 */
export function envelopeGate(rms: number): number {
  if (!Number.isFinite(rms)) return 0;
  return clamp((rms - VOICE_GATE) / VOICE_SPAN, 0, 1);
}

/** 第二步：感知伽马，`level = u ** 0.6`。 */
export function envelopeLevel(rms: number): number {
  return Math.pow(envelopeGate(rms), VOICE_GAMMA);
}

/** 容器 scale = 1 + 0.055 × level。 */
export function voiceScale(level: number): number {
  return 1 + VOICE_SCALE_GAIN * level;
}

/** 容器 translateY = −3px × level。 */
export function voiceTranslateY(level: number): number {
  return -VOICE_LIFT_PX * level;
}

/**
 * 第三步：起落平滑。起快落慢——辅音的爆发要跟得上，元音的收尾要拖住。
 * 公式与帧率无关，掉帧不改变收敛时长。
 */
export function smoothToward(current: number, target: number, dtMs: number): number {
  const dt = clamp(Number.isFinite(dtMs) ? dtMs : VOICE_DT_MIN, VOICE_DT_MIN, VOICE_DT_MAX);
  const tau = target > current ? VOICE_RISE_TAU : VOICE_FALL_TAU;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

/**
 * 发声脉动的纯状态：只算数，不写 DOM，不持有 rAF。
 * rAF 循环由 `src/engine.ts` 的声音通道驱动，每帧调一次 `step`。
 */
export class VoicePulse {
  /** 平滑后的实际值，写进 `--qq-voice`。 */
  value = 0;
  /** 目标值，来自最近一个 audio 事件。 */
  target = 0;
  private lastAudioAt = -Infinity;

  /** 收到 audio 事件：更新目标值并重置静音看门狗。 */
  feed(rms: number, now: number): void {
    this.target = envelopeLevel(rms);
    this.lastAudioAt = now;
  }

  /** done / error / 打断 / 离开 speaking：目标归零，靠 130 ms 释放常数自然落回。 */
  release(): void {
    this.target = 0;
    this.lastAudioAt = -Infinity;
  }

  /** 硬复位，进入 speaking 时用。 */
  reset(): void {
    this.value = 0;
    this.target = 0;
    this.lastAudioAt = -Infinity;
  }

  /** 走一帧，返回平滑后的值。 */
  step(dtMs: number, now: number): number {
    if (now - this.lastAudioAt > VOICE_SILENCE_MS) this.target = 0;
    let next = smoothToward(this.value, this.target, dtMs);
    if (next < VOICE_EPSILON) next = 0;
    this.value = next;
    return next;
  }

  /** 是否已经彻底静止（可以停 rAF）。 */
  get idle(): boolean {
    return this.value === 0 && this.target === 0;
  }
}

/* ------------------------------------------------------------------ *
 * Sink
 * ------------------------------------------------------------------ */

/** 状态机对外的全部副作用。 */
export interface EmotionSink {
  /** 切表情。 */
  setEmotion(id: EmotionId): void;
  /** 当前实际显示的表情，用于判断是不是从 `00` 睡眠里醒来。 */
  currentEmotion(): EmotionId | null;
  /** 进入 `speaking`：打开脉动通道。 */
  startVoice?(): void;
  /** 离开 `speaking` 或收到 done / error / 打断：释放脉动。 */
  stopVoice?(): void;
  /** 进入 `idle` 时复位闲置计时。 */
  resetIdle?(): void;
}

export interface MachineOptions {
  sink: EmotionSink;
  /** 时钟，缺省 `Date.now`。测试用假时钟。 */
  now?: () => number;
  initialState?: CharacterState;
}

interface EventEmotion {
  emotionId: EmotionId;
  priority: number;
  at: number;
}

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

/**
 * 表情合成顺序（`design/state-machine.md` § 5），先命中先返回：
 *   1. 唤醒过场 `01` 未播完 → 保持 `01`
 *   2. 事件表情未过期（< 1600 ms）→ 事件 emotionId
 *   3. 最短停留未满 → 保持上一个表情，目标进 `pendingStateEmotion`
 *   4. 当前状态的 emotionId
 *   5. `idle` 且以上都不成立 → 交给引擎的闲置策略（02 → 04 → 00）
 * 发声脉动是并行的第六条，不参与这个链。
 */
export class CharacterMachine {
  private readonly sink: EmotionSink;
  private readonly now: () => number;

  private state: CharacterState;

  /** 上一次真正把表情写进引擎的时刻。 */
  private lastEmotionAt = -Infinity;
  /** 最短停留未满时挂起的状态表情，只保留最新值，到点只切一次。 */
  private pendingStateEmotion: EmotionId | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;

  private eventEmotion: EventEmotion | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;

  /** 唤醒过场进行中：期间任何表情写入都被压住。 */
  private waking = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly pulse = new VoicePulse();
  private destroyed = false;

  constructor(opts: MachineOptions) {
    this.sink = opts.sink;
    this.now = opts.now ?? (() => Date.now());
    this.state = opts.initialState ?? 'idle';
  }

  getState(): CharacterState {
    return this.state;
  }

  /** 当前生效的事件表情，过期后为 `null`。测试与调试用。 */
  getEventEmotion(): EmotionId | null {
    return this.eventEmotion ? this.eventEmotion.emotionId : null;
  }

  isWaking(): boolean {
    return this.waking;
  }

  /* ---------------- 状态迁移 ---------------- */

  /**
   * 切状态。表里没有的组合直接忽略并返回 `false`。
   *
   * 状态变量立即翻转，只有**表情**受 500 ms 最短停留约束——
   * 气泡文字、脉动、音频、网络请求一律不等（首字延迟优先于表情好看）。
   *
   * 迁到 `listening` 恒为立即切（T9 打断必须马上有反馈）；
   * T10 断连由调用方传 `{ immediate: true }`。
   */
  setState(next: CharacterState, opts: { immediate?: boolean; force?: boolean } = {}): boolean {
    if (this.destroyed) return false;
    if (next === this.state) return false;
    if (!opts.force && !canTransition(this.state, next)) return false;

    const prev = this.state;
    this.state = next;

    if (prev === 'speaking' && next !== 'speaking') this.closeVoice();
    if (next === 'speaking') this.openVoice();
    if (next === 'idle') {
      this.closeVoice();
      this.sink.resetIdle?.();
    }

    // 离开 idle 时若丘丘正睡着（`00`），先走唤醒过场
    if (prev === 'idle' && this.maybeWake()) return true;

    const immediate = opts.immediate === true || next === 'listening';
    this.applyStateEmotion(immediate);
    return true;
  }

  /* ---------------- 事件表情 ---------------- */

  /**
   * 施加一条事件表情，`holdMs` 之后回到当前状态的表情。
   *
   * 不排队：新的立即覆盖旧的并重置计时器。同一毫秒内到达多条时取优先级最高的，
   * 优先级相同取后到的。
   */
  applyEventEmotion(
    emotionId: EmotionId,
    priority: number,
    holdMs: number = EVENT_EMOTION_MS
  ): boolean {
    if (this.destroyed) return false;
    const now = this.now();
    const cur = this.eventEmotion;
    if (cur && cur.at === now && cur.priority > priority) return false;

    this.eventEmotion = { emotionId, priority, at: now };
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = setTimeout(() => this.expireEventEmotion(), holdMs);

    // 事件表情优先于最短停留（合成链第 2 条高于第 3 条），立即切
    this.pendingStateEmotion = null;
    this.clearDwellTimer();
    this.commit(emotionId);
    return true;
  }

  private expireEventEmotion(): void {
    this.eventTimer = null;
    this.eventEmotion = null;
    if (this.destroyed) return;
    // 回到**当前**状态的表情，不是进入事件时的那个
    this.applyStateEmotion(false);
  }

  /* ---------------- 唤醒过场（design/character.md § 4） ---------------- */

  /** 当前表情是 `00` 睡眠时走 `01` 唤醒过场，返回是否进入了过场。 */
  private maybeWake(): boolean {
    if (this.sink.currentEmotion() !== SLEEP_EMOTION) return false;
    this.waking = true;
    this.commit(WAKE_EMOTION);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this.finishWake(), WAKE_TIMEOUT_MS);
    return true;
  }

  /**
   * 引擎报出表情变化时调用。`01` 的序列 `settle: { next: '02' }` 播完会自动切到 `02`，
   * 那一刻唤醒过场结束，把当前状态（可能已经变成 `thinking`）的表情补上。
   */
  onEngineEmotion(id: string): void {
    if (this.waking && id === '02') this.finishWake();
  }

  private finishWake(): void {
    if (!this.waking) return;
    this.waking = false;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.destroyed) return;
    if (this.eventEmotion) this.commit(this.eventEmotion.emotionId);
    else this.applyStateEmotion(true);
  }

  /* ---------------- 表情写入 ---------------- */

  private applyStateEmotion(immediate: boolean): void {
    if (this.destroyed || this.waking) return;
    // 事件表情压着的时候不动状态表情，等 1600 ms 到点再回来
    if (this.eventEmotion) return;

    const target = STATE_EMOTION[this.state];
    const elapsed = this.now() - this.lastEmotionAt;
    if (!immediate && elapsed < MIN_DWELL_MS) {
      this.pendingStateEmotion = target;
      if (!this.dwellTimer) {
        this.dwellTimer = setTimeout(() => this.flushDwell(), MIN_DWELL_MS - elapsed);
      }
      return;
    }
    this.pendingStateEmotion = null;
    this.clearDwellTimer();
    this.commit(target);
  }

  private flushDwell(): void {
    this.dwellTimer = null;
    if (this.destroyed || this.waking) return;
    const pending = this.pendingStateEmotion;
    this.pendingStateEmotion = null;
    if (pending === null) return;
    // 期间来了事件表情就让位，1600 ms 到点自然会回到状态表情
    if (this.eventEmotion) return;
    this.commit(pending);
  }

  private commit(id: EmotionId): void {
    this.lastEmotionAt = this.now();
    this.sink.setEmotion(id);
  }

  private clearDwellTimer(): void {
    if (this.dwellTimer) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  /* ---------------- 发声脉动 ---------------- */

  private openVoice(): void {
    this.pulse.reset();
    this.sink.startVoice?.();
  }

  private closeVoice(): void {
    this.pulse.release();
    this.sink.stopVoice?.();
  }

  /**
   * 喂一帧 TTS 音量包络。`rms` ∈ [0, 1]，语义见 `design/state-machine.md` § 4。
   * 只在 `speaking` 期间生效；不在 `speaking` 时静默丢弃。
   */
  feedEnvelope(rms: number): void {
    if (this.destroyed || this.state !== 'speaking') return;
    this.pulse.feed(rms, this.now());
  }

  /** 脉动的纯状态，`src/engine.ts` 的 rAF 循环读它。 */
  getPulse(): VoicePulse {
    return this.pulse;
  }

  /* ---------------- 销毁 ---------------- */

  destroy(): void {
    this.destroyed = true;
    this.clearDwellTimer();
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.eventEmotion = null;
    this.pendingStateEmotion = null;
    this.pulse.reset();
  }
}
