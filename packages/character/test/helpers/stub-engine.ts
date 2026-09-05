/**
 * 测试用的 `EmotionBall` 全局替身。
 *
 * 只 stub 引擎的**行为**，表情配置数据用的是 vendor 里 `emotions.js` 的原文
 * ——那是纯数据文件（顶层只有 `window.EMOTION_GROUPS` 与 `window.EMOTION_SEED`
 * 两个赋值），eval 出来就是上游真实的 32 套配置。
 * 这样主题补丁的测试断言的是真配置，不是我自己编的假数据。
 *
 * canvas / SVG 一律不跑，`setEmotion` 只记账。
 */

import { readFileSync } from 'node:fs';

import { fromPackage } from './paths.js';

import type {
  EmotionBallConfig,
  EmotionBallEngine,
  EmotionBallGlobal,
  EmotionDef,
  EmotionRaw
} from '../../src/types.js';

const EMOTIONS_JS = fromPackage('vendor', 'emotion-ball', 'js', 'emotions.js');

let seedCache: EmotionRaw[] | null = null;

/** 读 vendor 的 `emotions.js`，拿到上游 32 套表情的原始配置。 */
export function loadEmotionSeed(): EmotionRaw[] {
  if (seedCache) return structuredClone(seedCache) as EmotionRaw[];
  const src = readFileSync(EMOTIONS_JS, 'utf8');
  const win: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  const seed = win.EMOTION_SEED as EmotionRaw[] | undefined;
  if (!Array.isArray(seed)) {
    throw new Error('vendor/emotion-ball/js/emotions.js 里没有拿到 window.EMOTION_SEED');
  }
  seedCache = seed;
  return structuredClone(seed) as EmotionRaw[];
}

export interface StubEngine extends EmotionBallEngine {
  /** `setEmotion` / `handleAIMessage` 收到过的 ID，按时间顺序。 */
  readonly emotions: string[];
  readonly gaze: Array<[number, number]>;
  readonly listeners: Map<string, Array<(payload: unknown) => void>>;
  destroyed: boolean;
  active: boolean;
  idleResets: number;
  /** 手动把当前表情设成某个值，模拟引擎自己的闲置推进（比如睡到 `00`）。 */
  forceEmotion(id: string | null): void;
  /** 模拟引擎发一条 `change`。 */
  emitChange(id: string): void;
}

export interface StubEmotionBall extends EmotionBallGlobal {
  readonly registered: Map<string, EmotionRaw>;
  readonly instances: StubEngine[];
  lastCreateOptions: Record<string, unknown> | null;
  config: EmotionBallConfig;
}

/** 造一个干净的 `EmotionBall` 替身，配置表已经种上 vendor 的 32 套表情。 */
export function makeStubEmotionBall(): StubEmotionBall {
  const registered = new Map<string, EmotionRaw>();
  for (const raw of loadEmotionSeed()) registered.set(raw.id, raw);

  const config: EmotionBallConfig = {
    register(raw: EmotionRaw) {
      if (!raw || typeof raw.id !== 'string') return { ok: false, errors: ['缺少合法的 id'] };
      registered.set(raw.id, raw);
      return { ok: true, id: raw.id };
    },
    get(id: string): EmotionDef | null {
      const raw = registered.get(id);
      return raw ? { id, raw } : null;
    },
    list(): EmotionDef[] {
      return [...registered.entries()].map(([id, raw]) => ({ id, raw }));
    }
  };

  const instances: StubEngine[] = [];

  const eb = {
    registered,
    instances,
    lastCreateOptions: null as Record<string, unknown> | null,
    config,
    version: 'stub',
    create(_target: HTMLElement | string, opts: Record<string, unknown> = {}): EmotionBallEngine {
      eb.lastCreateOptions = opts;
      const emotions: string[] = [];
      const gaze: Array<[number, number]> = [];
      const listeners = new Map<string, Array<(payload: unknown) => void>>();
      let current: string | null = null;

      const engine: StubEngine = {
        emotions,
        gaze,
        listeners,
        destroyed: false,
        active: opts.autostart !== false,
        idleResets: 0,
        get emotionId() {
          return current;
        },
        setEmotion(id: string) {
          current = registered.has(id) ? id : '02';
          emotions.push(current);
          engine.emitChange(current);
          return true;
        },
        handleAIMessage(msg) {
          const id = typeof msg === 'string' ? JSON.parse(msg).emotionId : msg.emotionId;
          return engine.setEmotion(id);
        },
        on(evt, cb) {
          const list = listeners.get(evt) ?? [];
          list.push(cb as (payload: unknown) => void);
          listeners.set(evt, list);
          return engine;
        },
        off(evt, cb) {
          const list = listeners.get(evt) ?? [];
          const i = list.indexOf(cb as (payload: unknown) => void);
          if (i >= 0) list.splice(i, 1);
          return engine;
        },
        setActive(on: boolean) {
          engine.active = on;
          return engine;
        },
        resetIdle() {
          engine.idleResets += 1;
          return engine;
        },
        setGaze(nx: number, ny: number) {
          gaze.push([nx, ny]);
          return engine;
        },
        clearGaze() {
          gaze.push([0, 0]);
          return engine;
        },
        destroy() {
          engine.destroyed = true;
        },
        forceEmotion(id: string | null) {
          current = id;
        },
        emitChange(id: string) {
          for (const cb of listeners.get('change') ?? []) cb({ id });
        }
      };

      // 引擎构造函数里就会切一次初始表情
      if (typeof opts.emotion === 'string') current = opts.emotion;
      instances.push(engine);
      return engine;
    }
  } satisfies StubEmotionBall;

  return eb;
}
