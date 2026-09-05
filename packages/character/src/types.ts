/**
 * 丘丘角色包的公共类型。
 *
 * 依据：
 * - `docs/CONTRACTS.md` § 6（表情映射）、§ 1 与 § 3（事件信封与 payload）
 * - `design/character.md`（32 个 emotionId 全表）
 * - `design/state-machine.md`（四态）
 *
 * 契约版本 v0.1.5。
 */

/* ------------------------------------------------------------------ *
 * emotionId
 * ------------------------------------------------------------------ */

/** 生命周期组，`00`–`07`。 */
export type LifeEmotionId = '00' | '01' | '02' | '03' | '04' | '05' | '06' | '07';

/** 情绪反应组，`10`–`21`。情绪推断只能落进这一组。 */
export type ReactionEmotionId =
  '10' | '11' | '12' | '13' | '14' | '15' | '16' | '17' | '18' | '19' | '20' | '21';

/** 代理工作状态组，`30`–`41`。 */
export type AgentEmotionId =
  '30' | '31' | '32' | '33' | '34' | '35' | '36' | '37' | '38' | '39' | '40' | '41';

/**
 * Emotion Ball 已有的 32 个表情 ID。
 * 丘丘不注册 `50+` 自定义表情，也不发明新 ID。
 */
export type EmotionId = LifeEmotionId | ReactionEmotionId | AgentEmotionId;

/** 32 个合法 emotionId，顺序与 `design/character.md` § 1 的全表一致。 */
export const ALL_EMOTION_IDS: readonly EmotionId[] = [
  '00',
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
  '30',
  '31',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '38',
  '39',
  '40',
  '41'
];

const EMOTION_ID_SET: ReadonlySet<string> = new Set<string>(ALL_EMOTION_IDS);

/** 未知 emotionId 的统一回退（`02` 待机放空），同时也是引擎的 `fallbackId`。 */
export const FALLBACK_EMOTION: EmotionId = '02';

/** 是否是 Emotion Ball 已有的 32 个 ID 之一。 */
export function isEmotionId(id: unknown): id is EmotionId {
  return typeof id === 'string' && EMOTION_ID_SET.has(id);
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

/** 四个角色状态，与 `docs/CONTRACTS.md` § 2 的 `setPetState(state)` 逐字一致。 */
export type CharacterState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** 四态，`idle` 在首位（初始状态）。 */
export const ALL_STATES: readonly CharacterState[] = ['idle', 'listening', 'thinking', 'speaking'];

/* ------------------------------------------------------------------ *
 * 记忆事件（docs/CONTRACTS.md § 1「记忆事件流」）
 * ------------------------------------------------------------------ */

export type FilterDecision = 'accept' | 'reject' | 'uncertain';

export interface FilterPayload {
  decision: FilterDecision;
  score?: number;
  reason?: string;
  source?: 'ambient_audio' | 'ambient_image';
  input_preview?: string;
}

export interface WriteFact {
  id: string;
  text: string;
  entities?: string[];
  valid_from?: string;
}

export interface WritePayload {
  raw?: string;
  speaker?: 'user' | 'assistant';
  facts: WriteFact[];
  dropped_spans?: string[];
}

export interface MergePayload {
  result_id?: string;
  result_text?: string;
  absorbed?: Array<{ id: string; text: string }>;
  invalidated?: Array<{ id: string; text: string; valid_to?: string }>;
}

export interface RecallHit {
  id: string;
  text: string;
  path?: string;
  score?: number;
}

export interface RecallPayload {
  query?: string;
  plan?: { paths?: string[]; depth?: number; rewritten?: string };
  hits: RecallHit[];
  skipped_paths?: string[];
  tokens_injected?: number;
  cold_promoted: string[];
}

interface MemoryEventBase {
  id?: string;
  ts?: string;
  trace_id?: string;
}

export type MemoryEvent = MemoryEventBase &
  (
    | { type: 'filter'; payload: FilterPayload }
    | { type: 'write'; payload: WritePayload }
    | { type: 'merge'; payload: MergePayload }
    | { type: 'recall'; payload: RecallPayload }
  );

/* ------------------------------------------------------------------ *
 * 实例
 * ------------------------------------------------------------------ */

/** `createQiuqiu` 返回的实例。`apps/web` 自己包一层 hook，本包不依赖 React。 */
export interface QiuqiuInstance {
  /** 底层 Emotion Ball 引擎实例，逃生舱口，正常路径不用直接碰。 */
  readonly ball: EmotionBallEngine;
  /** 承载发声脉动的舞台元素（`.qq-stage`），脉动写它的 `transform`。 */
  readonly stage: HTMLElement;
  /** 引擎挂载的元素（`.qq-ball`）。 */
  readonly mount: HTMLElement;

  /** 当前状态。 */
  getState(): CharacterState;
  /** 当前实际显示的 emotionId（取自引擎）。 */
  getEmotion(): EmotionId | null;

  /** 直接切表情，未知 ID 回退 `02`。 */
  setEmotion(id: string): void;
  /** 切状态，同时切到该状态的表情（受 500 ms 最短停留约束）。返回是否发生了迁移。 */
  setState(next: CharacterState, opts?: SetStateOptions): boolean;
  /** 喂 TTS 音量包络，驱动容器级发声脉动。`rms` ∈ [0, 1]。 */
  feedEnvelope(rms: number): void;
  /** 记忆事件 → 事件表情。 */
  applyEvent(event: MemoryEvent): void;
  /** 请求出错（SSE / WS `error` 帧）→ `34`。 */
  applyError(): void;
  /** 一轮回复结束（SSE `done`）后对全文跑拒绝式与情绪推断。 */
  applyReply(replyText: string, userText?: string): void;
  /** 直接施加一条事件表情，持续 1600 ms。映射表之外的自定义用法走这里。 */
  applyEventEmotion(emotionId: EmotionId, priority: number): boolean;

  /**
   * 订阅表情变化。返回退订函数。
   *
   * 桌面端主窗口靠它把自己这只丘丘的表情镜像到桌宠：桌宠不自己推断表情
   * （AD-5），可主窗口的事件表情、情绪推断结果都只写在自己的实例上，
   * 不镜像的话两个窗口就是两张脸。
   */
  onEmotion(cb: (id: EmotionId) => void): () => void;

  /**
   * 直接给注视量，`nx` / `ny` ∈ [-1, 1]，正方向右下，超出去引擎自己夹。
   *
   * 桌宠窗口只有 200 px 又是鼠标穿透的，渲染进程只在光标压在丘丘身上时才收得到
   * `pointermove`——所以桌面上的「眼神跟随」拿不到自己算，得由主进程轮询
   * 全局光标再喂进来。`gazeFromDelta` 负责把像素偏移换成这两个数。
   */
  setGaze(nx: number, ny: number): void;
  /** 收回注视，眼睛回正。 */
  clearGaze(): void;
  /**
   * 光源方向，`nx` / `ny` 与注视量同一套（[-1, 1]，正方向右下）。
   *
   * 把球体渐变的光心朝那边挪一点，装扮层的泽面高光跟着走。真实物体的高光
   * 会随光源移动；钉死在左上角的高光是「这是一张图」最明显的破绽。
   */
  setLight(nx: number, ny: number): void;

  /** 当前形象。 */
  getLook(): CharacterLook;
  /**
   * 换形象。重打一遍配色补丁（全局）并重挂装扮层（本实例）。
   * 页面上换皮肤时调它，不用销毁重建实例。
   */
  setLook(look: CharacterLook): void;

  /** 暂停 / 恢复渲染（窗口失焦、滚出视口时用）。 */
  setActive(on: boolean): void;
  /** 复位闲置计时。 */
  resetIdle(): void;
  /** 销毁：停 rAF、清定时器、销毁引擎、移除 DOM。 */
  destroy(): void;
}

export interface SetStateOptions {
  /** 跳过 500 ms 最短停留，立即切表情。用于 T9 打断与 T10 断连。 */
  immediate?: boolean;
  /** 跳过迁移表校验，强制切到目标状态。 */
  force?: boolean;
}

/** 三处实例的尺寸与创建参数预设，见 `design/character.md` § 3。 */
export type QiuqiuPreset = 'pet' | 'main' | 'web';

/**
 * 形象。决定丘丘长什么样，与页面皮肤是两件事——页面皮肤只换 CSS 令牌，
 * 形象换的是球本身的配色与身上那层装扮。
 *
 * - `warm`  —— 原本的暖奶油小球，不戴任何装扮
 * - `anime` —— 二次元少女：樱色瓷白 + 紫瞳，加眼高光、腮红、呆毛、蝴蝶结、闪光
 */
export type CharacterLook = 'warm' | 'anime';

/** 合法形象列表，界面拿它做选项。 */
export const ALL_LOOKS: readonly CharacterLook[] = ['warm', 'anime'];

/** 是不是合法形象。 */
export function isCharacterLook(v: unknown): v is CharacterLook {
  return typeof v === 'string' && (ALL_LOOKS as readonly string[]).includes(v);
}

export interface QiuqiuIdleOptions {
  standbyAfter?: number;
  sleepAfter?: number;
  standbyId?: EmotionId;
  sleepId?: EmotionId;
}

export interface QiuqiuOptions {
  /** 场景预设，决定 `eyeScale` / `lite` / `idle` 的默认值。默认 `'pet'`。 */
  preset?: QiuqiuPreset;
  /** 初始表情，默认 `02`。 */
  emotion?: EmotionId;
  /** 覆盖预设的眼睛缩放。 */
  eyeScale?: number;
  /** 覆盖预设的精简模式（关彩带与撒花）。 */
  lite?: boolean;
  /** 覆盖预设的闲置策略；`false` 关闭闲置推进。 */
  idle?: QiuqiuIdleOptions | false;
  /** 默认 `true`，`false` 时只静态渲染一帧。 */
  autostart?: boolean;
  /**
   * 鼠标注视跟随。默认 `'pointer'`：在 `container` 所属 document 上挂一个
   * `pointermove` 监听，把光标位置换算成 `ball.setGaze(nx, ny)`。
   * 传 `false` 关掉（比如桌宠窗口是穿透的，拿不到有意义的指针坐标）。
   *
   * 引擎只提供 `setGaze` / `clearGaze`，**不自带**任何指针监听，
   * 所以「丘丘会看鼠标」这件事必须由本包接上。
   */
  gaze?: 'pointer' | false;
  /**
   * 注视饱和半径，像素。光标离球心这么远时注视量到满幅（±24 / ±15 viewBox 单位）。
   * 默认 320。
   */
  gazeRadius?: number;
  /**
   * 形象，默认 `'warm'`。`'anime'` 换成二次元配色并挂上装扮层。
   * 配色补丁是注册表级别的，会影响同一个 EmotionBall 上的所有实例；
   * 装扮层是每个实例各挂各的。
   */
  look?: CharacterLook;
  /** 注入 Emotion Ball 全局对象，缺省读 `globalThis.EmotionBall`。测试用。 */
  engine?: EmotionBallGlobal;
  /** 注入时钟，缺省 `Date.now`。测试用。 */
  now?: () => number;
}

/* ------------------------------------------------------------------ *
 * vendor/emotion-ball 的最小类型描述
 * 只描述 packages/character 用到的部分，不改 vendor 任何文件。
 * ------------------------------------------------------------------ */

/** 表情原始配置（`emotions.js` 里的一条），只标出主题补丁要动的字段。 */
export interface EmotionRaw {
  id: string;
  name: string;
  group: string;
  body?: Record<string, unknown> & { color?: string };
  eyes?: Record<string, unknown>;
  /** 待机随机小动作（自旋 / 弹跳）。自旋会甩彩带，见 `theme.ts` 的 `IDLE_ANTICS_OFF`。 */
  antics?: boolean;
  sequence?: {
    settle?: unknown;
    frames: Array<
      Record<string, unknown> & { body?: Record<string, unknown> & { color?: string } }
    >;
  };
  [key: string]: unknown;
}

export interface EmotionDef {
  id: string;
  raw: EmotionRaw;
  [key: string]: unknown;
}

export interface EmotionBallEngine {
  readonly emotionId: string | null;
  setEmotion(id: string, opts?: { auto?: boolean }): boolean;
  handleAIMessage(msg: { emotionId: string; tips?: string } | string): boolean;
  on(evt: 'change' | 'tips' | 'error', cb: (payload: any) => void): unknown;
  off(evt: 'change' | 'tips' | 'error', cb: (payload: any) => void): unknown;
  setActive(on: boolean): unknown;
  resetIdle(): unknown;
  setGaze(nx: number, ny: number): unknown;
  clearGaze(): unknown;
  destroy(): void;
}

export interface EmotionBallConfig {
  register(raw: EmotionRaw): { ok: boolean; id?: string; errors?: string[] };
  get(id: string): EmotionDef | null;
  list(group?: string): EmotionDef[];
}

export interface EmotionBallGlobal {
  create(target: HTMLElement | string, opts?: Record<string, unknown>): EmotionBallEngine;
  config: EmotionBallConfig;
  version?: string;
}
