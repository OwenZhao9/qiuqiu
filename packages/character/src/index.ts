/**
 * `@qiuqiu/character` —— 丘丘的表情引擎封装、状态机、事件映射、情绪推断。
 *
 * 纯 TypeScript，不依赖 React（`apps/web` 自己包一层 hook）。
 * 对应 `docs/CONTRACTS.md` § 6，契约版本 v0.1.18。
 *
 * 典型用法：
 *
 * ```ts
 * const qq = createQiuqiu(document.getElementById('pet')!, { preset: 'pet' });
 * qq.setState('thinking');          // → 30
 * qq.applyEvent(memoryEvent);       // write → 10，1600 ms 后回当前状态的表情
 * qq.feedEnvelope(audio.rms);       // speaking 期间驱动发声脉动
 * qq.applyReply(fullText);          // done 之后跑拒绝式与情绪推断
 * qq.destroy();
 * ```
 *
 * 六个顶层函数都以实例（或 `CharacterMachine`）作为第一个参数，
 * 方便函数式调用；实例上同名的方法是同一套行为。
 */

import type { CharacterState, EmotionId, QiuqiuInstance, SetStateOptions } from './types.js';

export {
  createQiuqiu,
  gazeFromDelta,
  getEmotionBall,
  lightCenter,
  LIGHT_BASE,
  LIGHT_SPAN,
  normalizeEmotionId,
  GAZE_RADIUS_PX,
  IDLE_DEFAULT,
  PRESETS
} from './engine.js';

export {
  FACTORY,
  FACTORY_STATE_EMOTION,
  type FactoryDefaults,
  type FactoryPreset,
  type FactorySkin
} from './defaults.js';

export {
  loadEngine,
  defaultVendorUrls,
  resetLoadCache,
  VENDOR_SCRIPTS,
  type LoadEngineOptions
} from './load.js';

export {
  applyEvent,
  applyError,
  applyReply,
  applyStop,
  applySubmit,
  decideSubmitEmotion,
  STOP_DECISION,
  SUBMIT_DECISION,
  SUBMIT_EMOTION_MS,
  SUBMIT_IMAGES_DECISION,
  decideEventEmotion,
  decideReplyEmotion,
  ERROR_DECISION,
  EVENT_EMOTION_TABLE,
  EVENT_PRIORITY,
  type EventEmotionDecision,
  type EventEmotionTarget,
  type EventRuleKey
} from './event-map.js';

export {
  inferEmotion,
  isRefusal,
  lastSentenceOf,
  normalize,
  RULES,
  REFUSAL,
  FALLBACK_EMOTION,
  type EmotionRule,
  type Scope
} from './emotion.js';

export {
  canTransition,
  CharacterMachine,
  envelopeGate,
  envelopeLevel,
  smoothToward,
  voiceScale,
  voiceTranslateY,
  VoicePulse,
  EVENT_EMOTION_MS,
  MIN_DWELL_MS,
  STATE_EMOTION,
  TRANSITIONS,
  VOICE_DT_MAX,
  VOICE_DT_MIN,
  VOICE_EPSILON,
  VOICE_FALL_TAU,
  VOICE_GAMMA,
  VOICE_GATE,
  VOICE_LIFT_PX,
  VOICE_RELEASE_MS,
  VOICE_RISE_TAU,
  VOICE_SCALE_GAIN,
  VOICE_SILENCE_MS,
  VOICE_SPAN,
  SLEEP_EMOTION,
  WAKE_EMOTION,
  WAKE_TIMEOUT_MS,
  type EmotionSink,
  type MachineOptions
} from './state-machine.js';

export {
  applyQiuqiuTheme,
  currentLook,
  ANIME_BODY_COLOR,
  ANIME_BODY_COLOR_PATCH,
  ANIME_EYE_COLOR,
  BODY_COLOR_PATCH,
  IDLE_ANTICS_OFF,
  PALETTES,
  QIUQIU_BODY_COLOR,
  QIUQIU_EYE_COLOR,
  UPSTREAM_BASE_COLORS,
  type ApplyThemeResult,
  type CharacterPalette
} from './theme.js';

export {
  findBodyGroup,
  mountCostume,
  parseEyeTransform,
  BLUSH_DROP,
  BLUSH_SPREAD,
  EYE_HALF,
  HEAD_C,
  type Costume,
  type MountCostumeOptions
} from './costume.js';

export {
  ALL_EMOTION_IDS,
  ALL_LOOKS,
  ALL_STATES,
  isCharacterLook,
  isEmotionId,
  type AgentEmotionId,
  type CharacterLook,
  type CharacterState,
  type EmotionBallEngine,
  type EmotionBallGlobal,
  type EmotionId,
  type LifeEmotionId,
  type MemoryEvent,
  type QiuqiuIdleOptions,
  type QiuqiuInstance,
  type QiuqiuOptions,
  type QiuqiuPreset,
  type ReactionEmotionId,
  type SetStateOptions
} from './types.js';

/** 切表情，未知 ID 回退 `02`。等价于 `q.setEmotion(id)`。 */
export function setEmotion(q: Pick<QiuqiuInstance, 'setEmotion'>, id: string): void {
  q.setEmotion(id);
}

/** 切状态并切到该状态的表情。等价于 `q.setState(next, opts)`。 */
export function setState(
  q: { setState(next: CharacterState, opts?: SetStateOptions): boolean },
  next: CharacterState,
  opts?: SetStateOptions
): boolean {
  return q.setState(next, opts);
}

/** 喂 TTS 音量包络。等价于 `q.feedEnvelope(rms)`。 */
export function feedEnvelope(q: { feedEnvelope(rms: number): void }, rms: number): void {
  q.feedEnvelope(rms);
}

/** 便捷类型：能接收事件表情、也能切状态的对象。 */
export type QiuqiuLike = Pick<QiuqiuInstance, 'setEmotion' | 'setState' | 'feedEnvelope'> & {
  applyEventEmotion(emotionId: EmotionId, priority: number, holdMs?: number): boolean;
};
