/** 桌宠窗口入口。只在 Electron 里加载；网页端没有桌宠窗口。 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PetApp } from './PetApp.js';
import './styles.css';
import { initSkin } from './skin.js';

// 在渲染前应用，避免先闪一下默认皮肤
initSkin();

document.body.classList.add('qq-pet-body');

const root = document.getElementById('root');
if (!root) throw new Error('pet.html 里少了 #root');

createRoot(root).render(
  <StrictMode>
    <PetApp />
  </StrictMode>
);
