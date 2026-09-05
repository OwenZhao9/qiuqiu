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

afterEach(() => {
  cleanup();
  setFetchImpl(null);
  setBridgeForTest(null);
});
