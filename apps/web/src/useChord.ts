/**
 * 和弦快捷键：**同时按住**若干个键才触发，不是依次按。
 *
 * 字母键当快捷键有个坑：在输入框里打字会误触发。中文拼音尤其明显——
 * 「擦」「察」「猜」这些字都要先敲 c 再敲 a，两个键会短暂同时按下。
 * 所以焦点在可输入元素里时一律不触发。
 *
 * 只在**全部键都按下的那一刻**触发一次，松开任意一个才重新武装，
 * 按住不放不会连发。
 */

import { useEffect, useRef } from 'react';

/** 焦点是不是在能打字的地方。 */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export interface ChordOptions {
  /** 关掉监听。 */
  disabled?: boolean;
  /** 在输入框里也触发。默认 false——字母和弦在输入框里必然误触发。 */
  allowWhileTyping?: boolean;
}

/**
 * @param keys 要同时按住的键，用 `KeyboardEvent.code`（`KeyC`、`KeyA`）。
 *             用 code 不用 key，这样切输入法或大写锁定都不影响。
 */
export function useChord(
  keys: readonly string[],
  onTrigger: () => void,
  { disabled = false, allowWhileTyping = false }: ChordOptions = {}
): void {
  const fire = useRef(onTrigger);
  fire.current = onTrigger;

  useEffect(() => {
    if (disabled || keys.length === 0) return;

    const down = new Set<string>();
    let armed = true;

    function onDown(e: KeyboardEvent): void {
      if (!keys.includes(e.code)) return;
      if (!allowWhileTyping && isTyping(e.target)) return;
      // 带修饰键的组合是别的快捷键，别抢
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      down.add(e.code);
      if (armed && keys.every((k) => down.has(k))) {
        armed = false; // 按住不放不连发
        e.preventDefault();
        fire.current();
      }
    }

    function onUp(e: KeyboardEvent): void {
      if (!keys.includes(e.code)) return;
      down.delete(e.code);
      armed = true; // 松开任意一个就重新武装
    }

    /** 切走窗口时按键的抬起收不到，回来会以为还按着。 */
    function reset(): void {
      down.clear();
      armed = true;
    }

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', reset);
    };
  }, [keys, disabled, allowWhileTyping]);
}
