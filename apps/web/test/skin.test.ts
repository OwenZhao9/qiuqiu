/** 皮肤切换只动令牌，不该动组件——所以测的是属性和存储，不是渲染。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { applySkin, initSkin, readSkin, SKINS } from '../src/skin.js';

describe('skin', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-skin');
  });

  it('默认是素净，不挂属性', () => {
    expect(readSkin()).toBe('default');
    applySkin('default');
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('切卡哇伊挂上属性并记住', () => {
    applySkin('kawaii');
    expect(document.documentElement.getAttribute('data-skin')).toBe('kawaii');
    expect(readSkin()).toBe('kawaii');
  });

  it('切回素净把属性摘掉', () => {
    applySkin('kawaii');
    applySkin('default');
    expect(document.documentElement.hasAttribute('data-skin')).toBe(false);
  });

  it('initSkin 恢复上次的选择', () => {
    localStorage.setItem('qiuqiu.skin', 'kawaii');
    initSkin();
    expect(document.documentElement.getAttribute('data-skin')).toBe('kawaii');
  });

  it('存了个不认识的值就回默认，别让整页挂掉', () => {
    localStorage.setItem('qiuqiu.skin', 'nope');
    expect(readSkin()).toBe('default');
  });

  it('两个皮肤都有名字和说明', () => {
    expect(SKINS).toHaveLength(2);
    for (const s of SKINS) expect(s.label && s.blurb).toBeTruthy();
  });
});
