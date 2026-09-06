/** 皮肤切换只动令牌，不该动组件——所以测的是属性和存储，不是渲染。 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FACTORY } from '@qiuqiu/character';
import {
  applySkin,
  DEFAULT_SKIN,
  initSkin,
  lookOf,
  readSkin,
  SKINS,
  SKIN_EVENT
} from '../src/skin.js';

describe('skin', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-skin');
  });

  it('没选过时用出厂皮肤（契约 § 9：卡哇伊）', () => {
    expect(DEFAULT_SKIN).toBe(FACTORY.skin);
    expect(readSkin()).toBe('kawaii');
  });

  it('切回素净把属性摘掉——素净是 tokens.css 的 :root 本身', () => {
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

  it('存了个不认识的值就回出厂皮肤，别让整页挂掉', () => {
    localStorage.setItem('qiuqiu.skin', 'nope');
    expect(readSkin()).toBe(DEFAULT_SKIN);
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

/**
 * 首帧之前挂 `data-skin` 的那段内联脚本。
 *
 * 它在 HTML 里，没法 import 出厂表，只能把 `'kawaii'` 写死。写死就会飘——
 * 哪天出厂皮肤改成别的，两个 HTML 会安静地继续挂旧的，用户看见的是一帧
 * 米色再跳成新色。所以这里读 HTML 原文对一遍。
 */
describe('首帧皮肤引导', () => {
  for (const page of ['index.html', 'pet.html']) {
    it(`${page} 里写死的出厂皮肤跟出厂表一致`, () => {
      // vitest 的 cwd 是 apps/web，两个 HTML 就在这一层
      const html = readFileSync(resolve(process.cwd(), page), 'utf8');
      const found = html.match(/localStorage\.getItem\('qiuqiu\.skin'\) \|\| '([a-z]+)'/);
      expect(found, `${page} 里没找到皮肤引导脚本`).not.toBeNull();
      expect(found![1]).toBe(FACTORY.skin);
    });
  }
});
