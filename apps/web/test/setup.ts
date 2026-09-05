/** vitest 的 jsdom 环境补几个缺的 DOM API。 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { setFetchImpl } from '../src/api.js';
import { setBridgeForTest } from '../src/bridge.js';

// jsdom 没有实现滚动，侧栏的自动滚会调到它
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo(): void {
    /* noop */
  };
}

// jsdom 这个版本的 localStorage 缺方法，补一个内存实现。
// 补在这里而不是各个测试里各打各的补丁——皮肤、草稿都会用到它。
if (typeof localStorage === 'undefined' || typeof localStorage.clear !== 'function') {
  const box = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => box.get(k) ?? null,
      setItem: (k: string, v: string) => void box.set(k, String(v)),
      removeItem: (k: string) => void box.delete(k),
      clear: () => box.clear(),
      key: (i: number) => [...box.keys()][i] ?? null,
      get length() {
        return box.size;
      }
    }
  });
}

afterEach(() => {
  cleanup();
  setFetchImpl(null);
  setBridgeForTest(null);
});
