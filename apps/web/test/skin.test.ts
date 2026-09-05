/** 皮肤切换只动令牌，不该动组件——所以测的是属性和存储，不是渲染。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { applySkin, initSkin, lookOf, readSkin, SKINS, SKIN_EVENT } from '../src/skin.js';

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

  it('每个皮肤都有名字、说明和形象', () => {
    expect(SKINS.map((s) => s.id)).toEqual(['default', 'kawaii', 'anime']);
    for (const s of SKINS) expect(s.label && s.blurb && s.look).toBeTruthy();
  });

  it('二次元换的不只是令牌，丘丘本人也换形象', () => {
    // 素净和卡哇伊只动 CSS，丘丘照旧；二次元连球一起换
    expect(lookOf('default')).toBe('warm');
    expect(lookOf('kawaii')).toBe('warm');
    expect(lookOf('anime')).toBe('anime');
    applySkin('anime');
    expect(document.documentElement.getAttribute('data-skin')).toBe('anime');
  });

  it('切皮肤会广播，挂着丘丘的组件靠它换形象（CSS 变量传不到 SVG 里）', () => {
    const seen: string[] = [];
    const onSkin = (e: Event): void => void seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(SKIN_EVENT, onSkin);
    applySkin('anime');
    applySkin('default');
    window.removeEventListener(SKIN_EVENT, onSkin);
    expect(seen).toEqual(['anime', 'default']);
  });
});
