/**
 * 记忆事件 / 出错 / 拒绝 / 情绪推断 → 事件表情。
 *
 * 映射与 `docs/CONTRACTS.md` § 6 的表逐字一致，优先级取自
 * `design/state-machine.md` § 3 的「事件 → 表情映射」表。
 *
 * 事件表情优先于状态表情，持续 1600 ms 后回到**当前**状态的表情；
 * `speaking` 期间的发声脉动不受事件表情影响（两条通路写的不是同一个属性）。
 */

import { FACTORY } from './defaults.js';
import { inferEmotion, isRefusal } from './emotion.js';
import { REPLY_EMOTION_MS } from './state-machine.js';
import { FALLBACK_EMOTION, type EmotionId, type MemoryEvent } from './types.js';

/** 一次事件表情的决定。`null` 表示不切换。 */
export interface EventEmotionDecision {
  emotionId: EmotionId;
  priority: number;
  /** 命中了映射表的哪一行，调试与契约测试用。 */
  rule: EventRuleKey;
}

export type EventRuleKey =
  | 'stop'
  | 'error'
  | 'refusal'
  | 'recall.cold_promoted'
  | 'recall.hit'
  | 'merge'
  | 'write'
  | 'filter.uncertain'
  | 'filter.reject'
  | 'filter.accept'
  | 'recall.empty'
  | 'inferred'
  | 'submit'
  | 'submit.images';

/** 事件表情的优先级，数值大的胜出。 */
export const EVENT_PRIORITY = {
  /** 用户主动打断，压过一切正在演的东西——他要的就是「停下」这个反馈 */
  stop: 95,
  error: 90,
  refusal: 80,
  recallCold: 70,
  recallHit: 60,
  merge: 50,
  write: 50,
  filterUncertain: 40,
  inferred: 30,
  /** 提交只是「收到了」的一瞬确认，谁都盖得过它 */
  submit: 20
} as const;

/**
 * 提交那一下停多久。
 *
 * `31 接收任务` 的切入过渡是 220 ms，停 600 ms 正好点个头就进思考；
 * 停久了会挡住 `30 思考中`，看着像卡住。
 */
export const SUBMIT_EMOTION_MS = FACTORY.emotion.submitHoldMs;

/**
 * `docs/CONTRACTS.md` § 6「事件表情」表，**行序与契约逐行一致**，供契约测试对着断言。
 *
 * `emotionId` 为 `null` 有两种含义，看 `priority`：
 * - `priority` 也是 `null` → 契约里写的「不切换」
 * - `priority` 有值（`inferred` 那行）→ 契约里写的是 `10`–`21` 区间而不是单个 ID，
 *   具体落哪个由 `design/emotion-rules.md` 的 17 条规则算出来
 */
export const EVENT_EMOTION_TABLE: readonly {
  rule: EventRuleKey;
  emotionId: EmotionId | null;
  priority: number | null;
}[] = [
  { rule: 'stop', emotionId: '41', priority: EVENT_PRIORITY.stop },
  { rule: 'error', emotionId: '34', priority: EVENT_PRIORITY.error },
  { rule: 'refusal', emotionId: '38', priority: EVENT_PRIORITY.refusal },
  { rule: 'recall.cold_promoted', emotionId: '40', priority: EVENT_PRIORITY.recallCold },
  { rule: 'recall.hit', emotionId: '37', priority: EVENT_PRIORITY.recallHit },
  { rule: 'merge', emotionId: '19', priority: EVENT_PRIORITY.merge },
  { rule: 'write', emotionId: '10', priority: EVENT_PRIORITY.write },
  { rule: 'filter.uncertain', emotionId: '11', priority: EVENT_PRIORITY.filterUncertain },
  { rule: 'inferred', emotionId: null, priority: EVENT_PRIORITY.inferred },
  { rule: 'submit', emotionId: '31', priority: EVENT_PRIORITY.submit },
  { rule: 'submit.images', emotionId: '03', priority: EVENT_PRIORITY.submit },
  { rule: 'filter.reject', emotionId: null, priority: null },
  { rule: 'filter.accept', emotionId: null, priority: null },
  { rule: 'recall.empty', emotionId: null, priority: null }
];

/** 请求出错（SSE / WS `error` 帧）。 */
export const ERROR_DECISION: EventEmotionDecision = {
  emotionId: '34',
  priority: EVENT_PRIORITY.error,
  rule: 'error'
};

function len(x: unknown): number {
  return Array.isArray(x) ? x.length : 0;
}

/**
 * 一条记忆事件切哪个表情。纯函数。
 *
 * - `filter.reject` 与 `filter.accept` 不切换
 * - `recall` 的 `cold_promoted` 非空用 `40`，否则命中非空用 `37`，两者都空不切换
 * - `write` 的 `facts` 为空时不切换（`design/state-machine.md` § 3 的判定列）
 */
export function decideEventEmotion(
  event: MemoryEvent | null | undefined
): EventEmotionDecision | null {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'filter': {
      if (event.payload?.decision === 'uncertain') {
        return {
          emotionId: '11',
          priority: EVENT_PRIORITY.filterUncertain,
          rule: 'filter.uncertain'
        };
      }
      return null; // accept / reject 都不切换，但照常进记忆侧栏
    }
    case 'write': {
      if (len(event.payload?.facts) === 0) return null;
      return { emotionId: '10', priority: EVENT_PRIORITY.write, rule: 'write' };
    }
    case 'merge':
      return { emotionId: '19', priority: EVENT_PRIORITY.merge, rule: 'merge' };
    case 'recall': {
      if (len(event.payload?.cold_promoted) > 0) {
        return {
          emotionId: '40',
          priority: EVENT_PRIORITY.recallCold,
          rule: 'recall.cold_promoted'
        };
      }
      if (len(event.payload?.hits) > 0) {
        return { emotionId: '37', priority: EVENT_PRIORITY.recallHit, rule: 'recall.hit' };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * 一轮回复结束（SSE `done`）之后对全文跑一次：先拒绝式（`38`，优先级 80），
 * 命中则**跳过**情绪推断；否则跑 `design/emotion-rules.md` 的 17 条规则（优先级 30）。
 * 情绪推断落到默认回退 `02` 时不切换——`02` 就是 `idle` 的状态表情，切了也是白切。
 */
export function decideReplyEmotion(
  replyText: string,
  userText?: string
): EventEmotionDecision | null {
  if (typeof replyText !== 'string' || !replyText.trim()) return null;
  if (isRefusal(replyText)) {
    return { emotionId: '38', priority: EVENT_PRIORITY.refusal, rule: 'refusal' };
  }
  const inferred = inferEmotion(replyText, userText);
  if (inferred === FALLBACK_EMOTION) return null;
  return { emotionId: inferred, priority: EVENT_PRIORITY.inferred, rule: 'inferred' };
}

/** 能接受事件表情的对象：`CharacterMachine` 与 `QiuqiuInstance` 都满足。 */
export interface EventEmotionTarget {
  applyEventEmotion(emotionId: EmotionId, priority: number, holdMs?: number): boolean;
}

/** 把一条记忆事件应用到丘丘身上。返回实际切到的表情，`null` 表示没切。 */
export function applyEvent(target: EventEmotionTarget, event: MemoryEvent): EmotionId | null {
  const decision = decideEventEmotion(event);
  if (!decision) return null;
  target.applyEventEmotion(decision.emotionId, decision.priority);
  return decision.emotionId;
}

/** 用户按下发送，没带附件。 */
export const SUBMIT_DECISION: EventEmotionDecision = {
  emotionId: '31',
  priority: EVENT_PRIORITY.submit,
  rule: 'submit'
};

/** 用户按下发送，带了图片。 */
export const SUBMIT_IMAGES_DECISION: EventEmotionDecision = {
  emotionId: '03',
  priority: EVENT_PRIORITY.submit,
  rule: 'submit.images'
};

/** 用户点停止中止本轮。 */
export const STOP_DECISION: EventEmotionDecision = {
  emotionId: '41',
  priority: EVENT_PRIORITY.stop,
  rule: 'stop'
};

/** 按下发送时该切哪个。 */
export function decideSubmitEmotion(hasImages = false): EventEmotionDecision {
  return hasImages ? SUBMIT_IMAGES_DECISION : SUBMIT_DECISION;
}

/**
 * 用户按下发送 → `31 接收任务`（带图片时 → `03 好奇`）。
 *
 * 原来提交之后直接跳 `30 思考中`，中间没有「收到了」这一下。点个头再去想，
 * 跟人说话时的反应顺序一致；带图进来是另一件事，`03 好奇` 表示「这什么，我看看」。
 */
export function applySubmit(target: EventEmotionTarget, hasImages = false): EmotionId {
  const d = decideSubmitEmotion(hasImages);
  target.applyEventEmotion(d.emotionId, d.priority, SUBMIT_EMOTION_MS);
  return d.emotionId;
}

/** 用户点停止中止本轮 → `41 停止终止`。 */
export function applyStop(target: EventEmotionTarget): EmotionId {
  target.applyEventEmotion(STOP_DECISION.emotionId, STOP_DECISION.priority);
  return STOP_DECISION.emotionId;
}

/** 请求出错 → `34`。 */
export function applyError(target: EventEmotionTarget): EmotionId {
  target.applyEventEmotion(ERROR_DECISION.emotionId, ERROR_DECISION.priority);
  return ERROR_DECISION.emotionId;
}

/** 一轮回复结束后应用拒绝式或情绪推断的结果。 */
export function applyReply(
  target: EventEmotionTarget,
  replyText: string,
  userText?: string
): EmotionId | null {
  const decision = decideReplyEmotion(replyText, userText);
  if (!decision) return null;
  // 回复的情绪停留得比记忆事件久，见 REPLY_EMOTION_MS
  target.applyEventEmotion(decision.emotionId, decision.priority, REPLY_EMOTION_MS);
  return decision.emotionId;
}
