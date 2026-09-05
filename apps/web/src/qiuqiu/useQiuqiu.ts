/**
 * `packages/character` 的 React 外壳。本包不依赖 React，所以 hook 在这边包。
 *
 * 只调它导出的 `loadEngine` / `createQiuqiu`，不复制它的任何逻辑。
 */

import { useEffect, useRef, useState } from 'react';
import {
  createQiuqiu,
  loadEngine,
  type CharacterLook,
  type QiuqiuInstance,
  type QiuqiuPreset
} from '@qiuqiu/character';
import { lookOf, readSkin, SKIN_EVENT, type Skin } from '../skin.js';

/** 当前皮肤对应的丘丘形象。皮肤一换就跟着换，不重建实例。 */
export function useLook(): CharacterLook {
  const [look, setLook] = useState<CharacterLook>(() => lookOf(readSkin()));
  useEffect(() => {
    const onSkin = (e: Event): void => {
      const skin = (e as CustomEvent<Skin>).detail;
      setLook(lookOf(skin ?? readSkin()));
    };
    globalThis.addEventListener?.(SKIN_EVENT, onSkin);
    return () => globalThis.removeEventListener?.(SKIN_EVENT, onSkin);
  }, []);
  return look;
}

/**
 * vendor 四个 IIFE 脚本的目录。
 *
 * `load.ts` 的第 2 种接法：宿主自己把 `vendor/emotion-ball` 放进静态目录，
 * 把 URL 传进来。`vite.config.ts` 的 `emotionBallVendor` 插件负责放。
 * 用 `document.baseURI` 拼，Electron 的 `file://` 与开发服务器都指得对。
 */
export function vendorBaseUrl(): string {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  // baseUrl 指到 emotion-ball 目录本身，`load.ts` 会在后面接上 `js/rings.js` 这样的相对路径
  return new URL('vendor/emotion-ball', base).href;
}

export interface UseQiuqiuResult {
  ref: React.RefObject<HTMLDivElement>;
  qiuqiu: QiuqiuInstance | null;
  /** 加载 vendor 脚本失败时的原因，界面照 `docs/CONVENTIONS.md` 带 hint 显示。 */
  error: Error | null;
}

export interface UseQiuqiuOptions {
  preset: QiuqiuPreset;
  /** 形象。缺省跟着当前皮肤走。 */
  look?: CharacterLook;
  /** 桌宠窗口是穿透的，拿不到有意义的指针坐标时关掉注视。 */
  gaze?: 'pointer' | false;
  /** 实例造好后回调一次，用来把状态机接上去。 */
  onReady?(q: QiuqiuInstance): void;
}

/** 在一个 div 里挂一只丘丘，卸载时销毁。 */
export function useQiuqiu(opts: UseQiuqiuOptions): UseQiuqiuResult {
  const ref = useRef<HTMLDivElement>(null);
  const [qiuqiu, setQiuqiu] = useState<QiuqiuInstance | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const onReady = useRef(opts.onReady);
  onReady.current = opts.onReady;
  // 建实例时读一次当前形象；之后的变化走上面那个 effect，不进依赖数组
  const lookRef = useRef<CharacterLook>('warm');

  const skinLook = useLook();
  const look = opts.look ?? skinLook;
  lookRef.current = look;
  const { preset, gaze } = opts;

  // 形象变了不重建实例——重建会丢掉当前表情与状态机的进度
  useEffect(() => {
    qiuqiu?.setLook(look);
  }, [qiuqiu, look]);

  useEffect(() => {
    let disposed = false;
    let instance: QiuqiuInstance | null = null;

    void (async () => {
      try {
        await loadEngine({ baseUrl: vendorBaseUrl() });
        if (disposed || !ref.current) return;
        instance = createQiuqiu(ref.current, { preset, gaze, look: lookRef.current });
        setQiuqiu(instance);
        onReady.current?.(instance);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return () => {
      disposed = true;
      instance?.destroy();
      setQiuqiu(null);
    };
  }, [preset, gaze]);

  return { ref, qiuqiu, error };
}
