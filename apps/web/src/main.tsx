/** 主窗口入口。桌面端与网页端同一份代码，差异只在 `bridge.ts` 里。 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MainApp } from './MainApp.js';
import { installMockServer } from './mock-server.js';
import './styles.css';
import { initSkin } from './skin.js';

// 在渲染前应用，避免先闪一下默认皮肤
initSkin();

// 手工联调：地址栏加 ?mock=1 就不连真后端，走 src/mock-server.ts
if (new URLSearchParams(location.search).has('mock')) {
  installMockServer({ ambientMs: 3000 });
  console.info('[qiuqiu] 已启用 mock 后端（?mock=1）');
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html 里少了 #root');

createRoot(root).render(
  <StrictMode>
    <MainApp />
  </StrictMode>
);
