/**
 * Emotion Ball 的封装：建实例、打主题补丁、把状态机接到真实的球上。
 *
 * vendor 的四个脚本是 IIFE，挂在 `window.EmotionBall` 上，没有模块导出。
 * 宿主按 `design/character.md` § 1 的顺序引入：
 *
 *   rings.js → emotions.js → ball.js → engine.js
 *
 * 本模块只从全局读它，不改 `vendor/emotion-ball/` 任何文件。
 */

import {
  applyEvent as applyEventTo,
  applyError as applyErrorTo,
  applyReply as applyReplyTo
} from './event-map.js';
import {
  CharacterMachine,
  VOICE_RELEASE_MS,
  type EmotionSink,
  type VoicePulse
} from './state-machine.js';
import { mountCostume, type Costume } from './costume.js';
import { applyQiuqiuTheme } from './theme.js';
import {
  FALLBACK_EMOTION,
  isEmotionId,
  type CharacterLook,
  type CharacterState,
  type EmotionBallEngine,
  type EmotionBallGlobal,
  type EmotionId,
  type MemoryEvent,
  type QiuqiuIdleOptions,
  type QiuqiuInstance,
  type QiuqiuOptions,
  type QiuqiuPreset,
  type SetStateOptions
} from './types.js';

/** 闲置策略：90 s 发呆、300 s 睡着（`design/character.md` § 4）。 */
export const IDLE_DEFAULT: Required<QiuqiuIdleOptions> = {
  standbyAfter: 90000,
  sleepAfter: 300000,
  standbyId: '04',
  sleepId: '00'
};

/** 三处实例的创建参数预设（`design/character.md` § 3）。 */
export const PRESETS: Readonly<
  Record<
    QiuqiuPreset,
    { size: number; eyeScale: number; lite: boolean; idle: QiuqiuIdleOptions | false }
  >
> = {
  /** 桌宠窗口 200 × 200。 */
  pet: { size: 200, eyeScale: 1, lite: false, idle: IDLE_DEFAULT },
  /** 主窗口左栏顶部 120 × 120，`lite` 关掉彩带与撒花，不开闲置。 */
  main: { size: 120, eyeScale: 1.5, lite: true, idle: false },
  /** 网页端内嵌 160 × 160。 */
  web: { size: 160, eyeScale: 1.2, lite: false, idle: IDLE_DEFAULT }
};

/** 已经 warn 过的未知 emotionId，避免逐帧刷屏。 */
const warnedUnknownIds = new Set<string>();

/** 未知 emotionId 回退 `02`，并 warn 一次。 */
export function normalizeEmotionId(id: string): EmotionId {
  if (isEmotionId(id)) return id;
  if (!warnedUnknownIds.has(id)) {
    warnedUnknownIds.add(id);
    console.warn(
      `[qiuqiu] 未知 emotionId "${id}"，已回退 ${FALLBACK_EMOTION}。` +
        '合法取值只有 Emotion Ball 已有的 32 个：00–07 / 10–21 / 30–41。'
    );
  }
  return FALLBACK_EMOTION;
}

/** 拿到全局的 `EmotionBall`；拿不到就抛，错误里带下一步能做什么。 */
export function getEmotionBall(override?: EmotionBallGlobal): EmotionBallGlobal {
  const eb = override ?? (globalThis as { EmotionBall?: EmotionBallGlobal }).EmotionBall;
  if (!eb || typeof eb.create !== 'function' || !eb.config) {
    throw new Error(
      '[qiuqiu] 找不到全局 EmotionBall。' +
        '请先按顺序引入 vendor/emotion-ball/js 下的 rings.js、emotions.js、ball.js、engine.js 四个脚本，' +
        '或给 createQiuqiu 传 opts.engine 注入。'
    );
  }
  return eb;
}

/* ------------------------------------------------------------------ *
 * 发声脉动的 rAF 通道
 * ------------------------------------------------------------------ */

interface VoiceChannel {
  start(): void;
  stop(): void;
  destroy(): void;
}

/**
 * 把 `VoicePulse` 的值写进舞台元素的 `--qq-voice`。
 * 写的是容器 `transform`，与 SVG 内部姿态两条独立通路——所以
 * `speaking` 期间切事件表情，球照样随音量起伏。
 */
function createVoiceChannel(
  stage: HTMLElement,
  pulse: VoicePulse,
  now: () => number
): VoiceChannel {
  const raf: (cb: () => void) => number =
    typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(() => cb())
      : (cb) => setTimeout(cb, 16) as unknown as number;
  const cancel: (h: number) => void =
    typeof cancelAnimationFrame === 'function'
      ? (h) => cancelAnimationFrame(h)
      : (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>);

  let handle = 0;
  let last = 0;
  let stopAt = Infinity;
  let written = '';

  function write(v: number): void {
    const next = v.toFixed(3);
    if (next === written) return; // s < 0.001 写 0 之后就不再重复写，避免刷合成层
    written = next;
    stage.style.setProperty('--qq-voice', next);
  }

  function tick(): void {
    handle = 0;
    const t = now();
    const dt = last ? t - last : 16;
    last = t;
    const v = pulse.step(dt, t);
    write(v);
    if (pulse.idle && t >= stopAt) {
      stage.style.setProperty('--qq-voice', '0');
      written = '0';
      return;
    }
    handle = raf(tick);
  }

  return {
    start(): void {
      stopAt = Infinity;
      if (handle) return;
      last = now();
      written = '';
      write(0);
      handle = raf(tick);
    },
    stop(): void {
      // level 已经在状态机里归零，这里再跑 200 ms 让 s 自然落到 0
      stopAt = now() + VOICE_RELEASE_MS;
      if (!handle) {
        stage.style.setProperty('--qq-voice', '0');
        written = '0';
      }
    },
    destroy(): void {
      if (handle) cancel(handle);
      handle = 0;
      stage.style.removeProperty('--qq-voice');
    }
  };
}

/* ------------------------------------------------------------------ *
 * 鼠标注视跟随
 * ------------------------------------------------------------------ */

/** 注视饱和半径，光标离球心这么远（像素）时注视量到满幅。 */
export const GAZE_RADIUS_PX = 320;

/**
 * 引擎只给了 `setGaze(nx, ny)` / `clearGaze()`，不自带任何指针监听。
 * 「丘丘会看鼠标」这件事由本包接上：在 document 上挂一个 `pointermove`，
 * 把光标相对球心的偏移归一化到 [-1, 1] 喂进去。
 */
function attachGaze(
  ball: EmotionBallEngine,
  mount: HTMLElement,
  doc: Document,
  radius: number
): () => void {
  const onMove = (ev: PointerEvent | MouseEvent): void => {
    const rect = mount.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // 还没布局或已隐藏
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const r = radius > 0 ? radius : GAZE_RADIUS_PX;
    ball.setGaze((ev.clientX - cx) / r, (ev.clientY - cy) / r);
  };
  const onLeave = (): void => {
    ball.clearGaze();
  };

  doc.addEventListener('pointermove', onMove, { passive: true });
  doc.addEventListener('pointerleave', onLeave);
  doc.defaultView?.addEventListener('blur', onLeave);

  return () => {
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerleave', onLeave);
    doc.defaultView?.removeEventListener('blur', onLeave);
  };
}

/* ------------------------------------------------------------------ *
 * createQiuqiu
 * ------------------------------------------------------------------ */

/**
 * 在 `container` 里创建一只丘丘。
 *
 * 会在 `container` 内插入两层：
 *
 *   <div class="qq-stage">      发声脉动写它的 transform
 *     <div class="qq-ball"/>    EmotionBall 挂这里
 *   </div>
 *
 * 两层的必要样式都写成内联，**宿主不需要额外引入 CSS**。
 * `container` 自己的尺寸由宿主负责：正方形，写死像素（桌宠 200、主窗口 120、网页 160）。
 */
export function createQiuqiu(container: HTMLElement, opts: QiuqiuOptions = {}): QiuqiuInstance {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Error('[qiuqiu] createQiuqiu：container 必须是一个已挂载的 HTMLElement');
  }
  const eb = getEmotionBall(opts.engine);
  let look: CharacterLook = opts.look ?? 'warm';
  applyQiuqiuTheme(eb, { look });

  const preset = PRESETS[opts.preset ?? 'pet'];
  const now = opts.now ?? (() => Date.now());

  const doc = container.ownerDocument ?? (globalThis as { document?: Document }).document;
  if (!doc)
    throw new Error('[qiuqiu] createQiuqiu：拿不到 document，本包只能在浏览器/渲染进程里用');

  const stage = doc.createElement('div');
  stage.className = 'qq-stage';
  stage.style.width = '100%';
  stage.style.height = '100%';
  stage.style.transformOrigin = '50% 62%'; // 略低于球心，起伏像点头不像放大
  stage.style.willChange = 'transform';
  stage.style.setProperty('--qq-voice', '0');
  stage.style.transform =
    'scale(calc(1 + 0.055 * var(--qq-voice))) translateY(calc(-3px * var(--qq-voice)))';

  const mount = doc.createElement('div');
  mount.className = 'qq-ball';
  mount.style.width = '100%';
  mount.style.height = '100%';
  stage.appendChild(mount);
  container.appendChild(stage);

  const idle = opts.idle !== undefined ? opts.idle : preset.idle;
  const ball: EmotionBallEngine = eb.create(mount, {
    emotion: opts.emotion ?? FALLBACK_EMOTION,
    shape: 'blob',
    eyeScale: opts.eyeScale ?? preset.eyeScale,
    lite: opts.lite ?? preset.lite,
    fallbackId: FALLBACK_EMOTION,
    autostart: opts.autostart ?? true,
    idle: idle === false ? false : { ...IDLE_DEFAULT, ...idle }
    // 刻意不传 color / eyeColor：主题走 config.register 的数据补丁，见 src/theme.ts
  });

  // 引擎已经把 SVG 画进 mount 了，这时候才挂得上装扮层
  let costume: Costume | null = mountCostume(mount, look);

  const sink: EmotionSink = {
    setEmotion(id) {
      ball.handleAIMessage({ emotionId: id });
    },
    currentEmotion() {
      const cur = ball.emotionId;
      return isEmotionId(cur) ? cur : null;
    },
    startVoice() {
      voice.start();
    },
    stopVoice() {
      voice.stop();
    },
    resetIdle() {
      ball.resetIdle();
    }
  };

  const machine = new CharacterMachine({ sink, now });
  const voice = createVoiceChannel(stage, machine.getPulse(), now);

  const onChange = (payload: { id?: string }): void => {
    if (payload && typeof payload.id === 'string') machine.onEngineEmotion(payload.id);
  };
  ball.on('change', onChange);

  const detachGaze =
    (opts.gaze ?? 'pointer') === 'pointer'
      ? attachGaze(ball, mount, doc, opts.gazeRadius ?? GAZE_RADIUS_PX)
      : null;

  let destroyed = false;

  const instance: QiuqiuInstance = {
    ball,
    stage,
    mount,
    getState: () => machine.getState(),
    getEmotion: () => sink.currentEmotion(),
    setEmotion(id: string) {
      ball.handleAIMessage({ emotionId: normalizeEmotionId(id) });
    },
    setState: (next: CharacterState, o?: SetStateOptions) => machine.setState(next, o ?? {}),
    applyEventEmotion: (emotionId: EmotionId, priority: number) =>
      machine.applyEventEmotion(emotionId, priority),
    feedEnvelope: (rms: number) => machine.feedEnvelope(rms),
    applyEvent(event: MemoryEvent) {
      applyEventTo(machine, event);
    },
    applyError() {
      applyErrorTo(machine);
    },
    applyReply(replyText: string, userText?: string) {
      applyReplyTo(machine, replyText, userText);
    },
    getLook: () => look,
    setLook(next: CharacterLook) {
      if (next === look) return;
      look = next;
      // 配色补丁改的是注册表，得让引擎重新读一遍当前表情才看得到新颜色
      applyQiuqiuTheme(eb, { look });
      const cur = sink.currentEmotion();
      if (cur) ball.handleAIMessage({ emotionId: cur });
      costume?.destroy();
      costume = mountCostume(mount, look);
    },

    setActive(on: boolean) {
      ball.setActive(on);
    },
    resetIdle() {
      ball.resetIdle();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ball.off('change', onChange);
      detachGaze?.();
      machine.destroy();
      voice.destroy();
      costume?.destroy();
      costume = null;
      ball.destroy();
      if (stage.parentNode) stage.parentNode.removeChild(stage);
    }
  };

  return instance;
}
