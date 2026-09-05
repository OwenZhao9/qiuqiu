/**
 * 加载 vendor 里的 Emotion Ball 引擎。
 *
 * vendor 的四个文件是**浏览器全局脚本**（IIFE，挂 `window.EmotionBall`），
 * 没有任何模块导出，所以不能 `import`，只能用 `<script>` 注入。
 * 顺序是硬要求，`engine.js` 启动时要读 `window.EB_RINGS` 与 `window.EMOTION_SEED`：
 *
 *   rings.js → emotions.js → ball.js → engine.js
 *
 * 三种接法，宿主任选一种：
 *
 * 1. `await loadEngine()` —— 默认按 `import.meta.url` 解析 vendor 路径注入。
 *    Vite / webpack 都能静态分析 `new URL('...', import.meta.url)` 并把
 *    四个 js 当成资源产出，打包后仍然指得对。
 * 2. `await loadEngine({ urls: [...] })` —— 宿主自己把四个文件复制进
 *    `public/`（Electron 里是 `resources/`），把 URL 传进来。
 * 3. 宿主在 HTML 里写四个 `<script src>` 标签，然后直接 `createQiuqiu()`。
 *    `loadEngine()` 检测到 `window.EmotionBall` 已存在会立刻返回，不重复注入。
 *
 * 本模块不改 `vendor/emotion-ball/` 任何文件。
 */

import type { EmotionBallGlobal } from './types.js';

/** 四个脚本相对 `vendor/emotion-ball/` 的路径，顺序即加载顺序，不可调换。 */
export const VENDOR_SCRIPTS: readonly string[] = [
  'js/rings.js',
  'js/emotions.js',
  'js/ball.js',
  'js/engine.js'
];

/**
 * 默认的四个脚本 URL，按本模块自身位置解析。
 * 写成四条字面量而不是循环拼接，是为了让打包器能静态识别成资源引用。
 */
export function defaultVendorUrls(): string[] {
  return [
    new URL('../vendor/emotion-ball/js/rings.js', import.meta.url).href,
    new URL('../vendor/emotion-ball/js/emotions.js', import.meta.url).href,
    new URL('../vendor/emotion-ball/js/ball.js', import.meta.url).href,
    new URL('../vendor/emotion-ball/js/engine.js', import.meta.url).href
  ];
}

export interface LoadEngineOptions {
  /** 四个脚本的完整 URL，顺序必须是 rings → emotions → ball → engine。 */
  urls?: readonly string[];
  /**
   * 目录前缀，末尾有没有斜杠都行。给了它就用
   * `<baseUrl>/js/rings.js` 这样的路径，等价于自己拼 `urls`。
   */
  baseUrl?: string;
  /** 注入到哪个 document，缺省当前 document。多窗口（桌宠 / 主窗口）时用得上。 */
  doc?: Document;
  /** 单个脚本的加载超时，毫秒，默认 10000。 */
  timeoutMs?: number;
}

/** 每个 document 只注入一次，重复调用复用同一个 Promise。 */
const inflight = new WeakMap<Document, Promise<EmotionBallGlobal>>();

function joinUrl(base: string, rel: string): string {
  return base.endsWith('/') ? base + rel : base + '/' + rel;
}

function readGlobal(doc: Document): EmotionBallGlobal | null {
  const win = (doc.defaultView ?? globalThis) as unknown as { EmotionBall?: EmotionBallGlobal };
  const eb = win.EmotionBall ?? (globalThis as { EmotionBall?: EmotionBallGlobal }).EmotionBall;
  return eb && typeof eb.create === 'function' && eb.config ? eb : null;
}

function injectScript(doc: Document, src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = doc.querySelector<HTMLScriptElement>(
      `script[data-qiuqiu-vendor="${CSS_ESCAPE(src)}"]`
    );
    if (existing) {
      if (existing.dataset.qiuqiuLoaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(fail(src))), { once: true });
      return;
    }
    const el = doc.createElement('script');
    el.src = src;
    el.async = false; // 保证四个脚本按插入顺序执行
    el.dataset.qiuqiuVendor = src;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      reject(new Error(`${fail(src)}（${timeoutMs} ms 超时）`));
    }, timeoutMs);
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    el.addEventListener(
      'load',
      () => {
        clear();
        el.dataset.qiuqiuLoaded = '1';
        resolve();
      },
      { once: true }
    );
    el.addEventListener(
      'error',
      () => {
        clear();
        reject(new Error(fail(src)));
      },
      { once: true }
    );
    (doc.head ?? doc.documentElement).appendChild(el);
  });
}

function fail(src: string): string {
  return (
    `[qiuqiu] Emotion Ball 脚本加载失败：${src}。` +
    '检查文件是否随构建产物一起发布；也可以把 vendor/emotion-ball 复制进宿主的静态目录，' +
    '再用 loadEngine({ baseUrl }) 指过去。'
  );
}

/** 属性选择器里的引号与反斜杠要转义，路径里出现的概率极低但不能不管。 */
function CSS_ESCAPE(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}

/**
 * 按顺序注入四个 vendor 脚本，解析出 `window.EmotionBall`。
 *
 * 幂等：同一个 document 上重复调用复用同一个 Promise；
 * 检测到 `window.EmotionBall` 已经存在（宿主自己写了 script 标签）时立刻返回。
 */
export async function loadEngine(opts: LoadEngineOptions = {}): Promise<EmotionBallGlobal> {
  const doc = opts.doc ?? (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error(
      '[qiuqiu] loadEngine 只能在浏览器 / 渲染进程里调用（拿不到 document）。' +
        'Node 侧只用得到 inferEmotion 与 decideEventEmotion 这些纯函数。'
    );
  }

  const ready = readGlobal(doc);
  if (ready) return ready;

  const cached = inflight.get(doc);
  if (cached) return cached;

  const urls = opts.urls
    ? [...opts.urls]
    : opts.baseUrl
      ? VENDOR_SCRIPTS.map((rel) => joinUrl(opts.baseUrl as string, rel))
      : defaultVendorUrls();
  const timeoutMs = opts.timeoutMs ?? 10000;

  const task = (async (): Promise<EmotionBallGlobal> => {
    for (const url of urls) {
      await injectScript(doc, url, timeoutMs);
    }
    const eb = readGlobal(doc);
    if (!eb) {
      throw new Error(
        '[qiuqiu] 四个脚本都加载完了，但 window.EmotionBall 仍然不存在。' +
          '确认加载顺序是 rings.js → emotions.js → ball.js → engine.js，且四个文件没有被裁剪。'
      );
    }
    return eb;
  })();

  inflight.set(doc, task);
  try {
    return await task;
  } catch (err) {
    inflight.delete(doc); // 失败不缓存，允许宿主换个 URL 重试
    throw err;
  }
}

/** 仅供测试：清掉某个 document 的加载缓存。 */
export function resetLoadCache(doc: Document): void {
  inflight.delete(doc);
}
